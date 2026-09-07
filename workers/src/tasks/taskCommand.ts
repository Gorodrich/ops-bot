// /task add・done・decline・hold（§4.2・§4.3の状態遷移＋§4.5割当アルゴリズム・§4.5.1共同確認・§4.6期限管理）。

import type { Env } from "../env";
import { type CommandOption, type Interaction, InteractionResponseType, optionValue } from "../discord/types";
import { getTaskTargetDays } from "../settings";
import { resolveUneiActor } from "../staff/subaccountEligibility";
import { EPHEMERAL_FLAG, sendDirectMessage, sendFollowupMessage } from "../discord/rest";
import { writeAuditLog } from "../auditLog";
import {
  assignTask,
  declineTask,
  getTask,
  holdTask,
  insertManualTask,
  listOwnIncompleteTasks,
  markUnassignedNeedsManualReview,
  recordCompletion,
  searchTasksForAutocomplete,
  type TaskRow,
} from "./repo";
import { autoAssign } from "./autoAssign";
import { computeBotDefaultDueAt, parseManualDueAtJst } from "./deadlines";
import { buildAssignedNoticeEmbed, buildCoSignUnavailableNote, buildOwnTaskListEmbed, buildReassignNotice, manualReviewReasonText } from "./templates";
import { postTaskAttentionPush, syncTaskMessage } from "./notify";
import { isValidTag } from "../staff/tags";
import type { PermissionTier } from "./assignment";
import type { DeferredResult } from "../accountLinks/authoriseCommand";

function immediate(content: string): DeferredResult {
  return {
    ack: { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content, flags: EPHEMERAL_FLAG } },
    followUp: async () => {},
  };
}

function immediateEmbed(embed: Record<string, unknown>): DeferredResult {
  return {
    ack: { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { embeds: [embed], flags: EPHEMERAL_FLAG } },
    followUp: async () => {},
  };
}

function deferred(env: Env, interaction: Interaction, run: () => Promise<string>): DeferredResult {
  return {
    ack: { type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: EPHEMERAL_FLAG } },
    followUp: async () => {
      const content = await run();
      await sendFollowupMessage(env.DISCORD_APP_ID, interaction.token, { content, flags: EPHEMERAL_FLAG });
    },
  };
}

const VALID_PRIORITIES = new Set(["high", "medium", "low"]);
const VALID_TIERS = new Set(["admin", "broad", "standard"]);
const RESUME_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

async function requireUnei(env: Env, interaction: Interaction): Promise<{ operatorId: string } | { error: string }> {
  const resolved = await resolveUneiActor(env, interaction.member);
  if (!resolved.ok) return { error: resolved.message };
  return { operatorId: resolved.actorId };
}

/**
 * `/task done`・`/task decline`・`/task hold` の `task_id` オプション（autocomplete・2026-09-06追加）。
 * `decline`・`hold`は担当者本人のみ実行できるため、候補もその担当者のタスクのみに絞る。
 * `done`は運営者であれば誰でも実行できるため、未完了の全タスクを候補にする。
 */
export async function handleTaskIdAutocomplete(
  env: Env,
  subcommandName: string,
  requesterId: string,
  query: string,
): Promise<Array<{ name: string; value: string }>> {
  const assigneeId = subcommandName === "decline" || subcommandName === "hold" ? requesterId : undefined;
  const tasks = await searchTasksForAutocomplete(env, { query, assigneeId, excludeDone: true });
  return tasks.map((t) => ({
    name: `${t.title}（#${t.id}）`.slice(0, 100),
    value: String(t.id),
  }));
}

// required_tags は tag_1〜tag_3（Discord固定choicesの選択式・§4.4）の3枠で受け取る。
// カンマ区切り1フィールド＋autocompleteの構成は、Discordが選択時に入力欄全体を選択肢のvalueで
// 上書きする仕様（カーソル位置を保持しない）のため、既存の選択済みタグと入力中の新規タグを
// 区別できず、確定済みタグが消える不具合が発生することが判明したため採用しない。
const REQUIRED_TAG_OPTION_NAMES = ["tag_1", "tag_2", "tag_3"] as const;

function parseRequiredTags(options: CommandOption[]): { tags: string[]; error: string | null } {
  const tags: string[] = [];
  for (const name of REQUIRED_TAG_OPTION_NAMES) {
    const raw = optionValue(options, name);
    if (!raw) continue;
    if (!isValidTag(raw)) {
      return { tags: [], error: `${name} に未知のタグがあります（§4.4の語彙のみ使用可）: ${raw}` };
    }
    if (!tags.includes(raw)) tags.push(raw);
  }
  return { tags, error: null };
}

export async function handleTaskAdd(env: Env, interaction: Interaction, options: CommandOption[]): Promise<DeferredResult> {
  const requireResult = await requireUnei(env, interaction);
  if ("error" in requireResult) return immediate(requireResult.error);
  const { operatorId } = requireResult;

  const title = optionValue(options, "title");
  if (!title) return immediate("title オプションが必要です。");
  const summary = optionValue(options, "summary") ?? null;
  const manualAssignee = optionValue(options, "assignee") ?? null;
  const priorityRaw = optionValue(options, "priority") ?? "medium";
  if (!VALID_PRIORITIES.has(priorityRaw)) return immediate("priority は high/medium/low のいずれかです。");

  const { tags: requiredTags, error: tagError } = parseRequiredTags(options);
  if (tagError) return immediate(tagError);
  const requiresTechnician = optionValue(options, "requires_technician") === "true";
  const permissionTierRaw = optionValue(options, "required_permission_tier");
  if (permissionTierRaw && !VALID_TIERS.has(permissionTierRaw)) return immediate("required_permission_tier は admin/broad/standard のいずれかです。");
  const requiredPermissionTier = (permissionTierRaw as PermissionTier | undefined) ?? null;
  const isControversial = optionValue(options, "controversial") === "true";
  const estimatedLoadRaw = optionValue(options, "estimated_load");
  const estimatedLoad = estimatedLoadRaw ? Number(estimatedLoadRaw) : null;
  if (estimatedLoad !== null && (!Number.isInteger(estimatedLoad) || estimatedLoad < 1 || estimatedLoad > 5)) {
    return immediate("estimated_load は1〜5の整数です。");
  }
  const dueAtRaw = optionValue(options, "due_at");
  let manualDueAt: string | null = null;
  if (dueAtRaw) {
    manualDueAt = parseManualDueAtJst(dueAtRaw);
    if (!manualDueAt) return immediate("due_at は `YYYY-MM-DD-hh-mm`（日本時間・24時間表記）の形式で指定してください（例：2026-09-10-18-30）。");
  }

  return deferred(env, interaction, async () => {
    const targetDays = await getTaskTargetDays(env);
    const dueAt = manualDueAt ?? computeBotDefaultDueAt(targetDays, "T-C", new Date());
    const deadlineSource: "manual" | "bot_default" = manualDueAt ? "manual" : "bot_default";

    if (manualAssignee) {
      const taskId = await insertManualTask(env, {
        title,
        summary,
        assignee: manualAssignee,
        coSigner: null,
        priority: priorityRaw as "high" | "medium" | "low",
        createdBy: operatorId,
        requiredTags,
        requiresTechnician,
        requiredPermissionTier,
        isControversial,
        estimatedLoad,
        dueAt,
        deadlineSource,
      });
      await writeAuditLog(env, { actor: operatorId, action: "task_added", target: String(taskId), detail: { title, assignee: manualAssignee, auto: false } });
      await sendDirectMessage(env.DISCORD_BOT_TOKEN, manualAssignee, "", [
        buildAssignedNoticeEmbed({ taskId, title, assigneeMention: `<@${manualAssignee}>`, dueAt }),
      ]).catch((e) => console.error("担当者DM送信に失敗", e));
      await syncTaskMessage(env, taskId).catch((e) => console.error("タスク起票通知の送信に失敗", e));
      const cosignNote = isControversial ? "（共同確認者はこの割当方式では自動選定されません。必要な場合は手動で調整してください）" : "";
      return `タスク #${taskId} を作成しました（担当：<@${manualAssignee}>・目標期限あり）。${cosignNote}`;
    }

    const outcome = await autoAssign(env, { requiredTags, requiresTechnician, requiredPermissionTier, isControversial });
    const assigned = outcome.reason === "ok" && outcome.primary;
    // 未割当でも運営が手動で期限を指定した場合はその期限を保持する（Bot既定の目標期限は割当と連動するが、
    // 手動指定は運営の意思決定のため割当状況に関わらず尊重する）。
    const appliesDueAt = assigned || manualDueAt !== null;

    const taskId = await insertManualTask(env, {
      title,
      summary,
      assignee: assigned ? outcome.primary : null,
      coSigner: assigned ? outcome.coSigner : null,
      priority: priorityRaw as "high" | "medium" | "low",
      createdBy: operatorId,
      requiredTags,
      requiresTechnician,
      requiredPermissionTier,
      isControversial,
      estimatedLoad,
      dueAt: appliesDueAt ? dueAt : null,
      deadlineSource: appliesDueAt ? deadlineSource : null,
    });

    const reason: "no_eligible" | "tie_or_below_threshold" = outcome.reason === "no_eligible" ? "no_eligible" : "tie_or_below_threshold";
    await syncTaskMessage(env, taskId, { manualReviewNote: assigned ? null : manualReviewReasonText(reason) }).catch((e) => console.error("タスク起票通知の送信に失敗", e));

    if (!assigned) {
      await writeAuditLog(env, { actor: operatorId, action: "task_added", target: String(taskId), detail: { title, auto: true, assigned: false, reason: outcome.reason } });
      const freshTask = await getTask(env, taskId);
      if (freshTask) {
        await postTaskAttentionPush(env, freshTask, `自動割当できませんでした（${manualReviewReasonText(reason)}）。`);
      }
      return `タスク #${taskId} を作成しましたが、自動割当できませんでした（運営チャンネルに手動対応を依頼しました）。`;
    }

    const primaryId = outcome.primary as string;
    await writeAuditLog(env, { actor: operatorId, action: "task_added", target: String(taskId), detail: { title, auto: true, assignee: primaryId, coSigner: outcome.coSigner } });
    await sendDirectMessage(env.DISCORD_BOT_TOKEN, primaryId, "", [
      buildAssignedNoticeEmbed({ taskId, title, assigneeMention: `<@${primaryId}>`, coSignerMention: outcome.coSigner ? `<@${outcome.coSigner}>` : null, dueAt }),
    ]).catch((e) => console.error("担当者DM送信に失敗", e));
    if (outcome.coSigner) {
      await sendDirectMessage(env.DISCORD_BOT_TOKEN, outcome.coSigner, `タスク #${taskId}「${title}」の共同確認者に選定されました（§4.5.1）。`).catch((e) => console.error("共同確認者DM送信に失敗", e));
    }
    const cosignWarn = outcome.coSignRequiredButUnavailable ? `\n${buildCoSignUnavailableNote({ taskId, title })}` : "";
    return `タスク #${taskId} を自動割当しました（担当：<@${primaryId}>${outcome.coSigner ? `・共同確認：<@${outcome.coSigner}>` : ""}）。${cosignWarn}`;
  });
}

export async function handleTaskDone(env: Env, interaction: Interaction, options: CommandOption[]): Promise<DeferredResult> {
  const requireResult = await requireUnei(env, interaction);
  if ("error" in requireResult) return immediate(requireResult.error);
  const { operatorId } = requireResult;

  const taskIdRaw = optionValue(options, "task_id");
  const evidence = optionValue(options, "evidence");
  if (!taskIdRaw || !evidence) return immediate("task_id・evidence オプションが必要です（§4.2：完了の根拠を必須とする）。");

  const task = await getTask(env, Number(taskIdRaw));
  if (!task) return immediate("指定されたタスクが見つかりません。");
  if (task.status === "done") return immediate("このタスクは既に完了しています。");

  if (task.co_signer && operatorId !== task.assignee && operatorId !== task.co_signer) {
    return immediate(`このタスクは共同確認（§4.5.1）が必要です。完了操作は担当者（<@${task.assignee}>）または共同確認者（<@${task.co_signer}>）のみ行えます。`);
  }

  const { fullyDone, role } = await recordCompletion(env, task, operatorId, evidence);
  await writeAuditLog(env, { actor: operatorId, action: fullyDone ? "task_done" : "task_done_partial_cosign", target: String(task.id), detail: { evidence, role } });
  await syncTaskMessage(env, task.id).catch((e) => console.error("タスクメッセージの更新に失敗", e));
  if (fullyDone) return immediate(`タスク #${task.id} を完了にしました。`);
  return immediate(`タスク #${task.id} の完了操作を受け付けました（${role === "co_signer" ? "共同確認者" : "担当者"}分）。もう一方の完了操作を待って正式に完了となります（§4.5.1）。`);
}

export async function handleTaskDecline(env: Env, interaction: Interaction, options: CommandOption[]): Promise<DeferredResult> {
  const requireResult = await requireUnei(env, interaction);
  if ("error" in requireResult) return immediate(requireResult.error);
  const { operatorId } = requireResult;

  const taskIdRaw = optionValue(options, "task_id");
  if (!taskIdRaw) return immediate("task_id オプションが必要です。");

  const task = await getTask(env, Number(taskIdRaw));
  if (!task) return immediate("指定されたタスクが見つかりません。");
  if (task.assignee !== operatorId) return immediate("このタスクの現在の担当者のみ辞退できます。");

  return deferred(env, interaction, async () => reassignAfterDecline(env, task, operatorId));
}

async function reassignAfterDecline(env: Env, task: TaskRow, decliningOperatorId: string): Promise<string> {
  const declinedHistory = JSON.parse(task.declined_by || "[]") as string[];
  await declineTask(env, task.id, decliningOperatorId, declinedHistory);
  await writeAuditLog(env, { actor: decliningOperatorId, action: "task_declined", target: String(task.id) });

  const requiredTags = JSON.parse(task.required_tags || "[]") as string[];
  const outcome = await autoAssign(
    env,
    {
      requiredTags,
      requiresTechnician: task.requires_technician === 1,
      requiredPermissionTier: (task.required_permission_tier as PermissionTier) || null,
      isControversial: task.is_controversial === 1,
    },
    [...declinedHistory, decliningOperatorId],
  );

  if (outcome.reason !== "ok" || !outcome.primary) {
    await markUnassignedNeedsManualReview(env, task.id);
    const reason: "no_eligible" | "tie_or_below_threshold" = outcome.reason === "no_eligible" ? "no_eligible" : "tie_or_below_threshold";
    await syncTaskMessage(env, task.id, { manualReviewNote: manualReviewReasonText(reason) }).catch((e) => console.error("タスクメッセージの更新に失敗", e));
    const freshTask = await getTask(env, task.id);
    if (freshTask) {
      await postTaskAttentionPush(env, freshTask, `辞退後の自動再割当に失敗しました（${manualReviewReasonText(reason)}）。`);
    }
    return `タスク #${task.id} を辞退しました（未割当に戻しました）。自動再割当の候補者が見つからなかったため、運営チャンネルに手動対応を依頼しました。`;
  }

  await assignTask(env, task.id, { assignee: outcome.primary, coSigner: outcome.coSigner });
  await writeAuditLog(env, { actor: "system", action: "task_reassigned", target: String(task.id), detail: { from: decliningOperatorId, to: outcome.primary, coSigner: outcome.coSigner } });
  await syncTaskMessage(env, task.id).catch((e) => console.error("タスクメッセージの更新に失敗", e));
  await sendDirectMessage(env.DISCORD_BOT_TOKEN, outcome.primary, "", [
    buildAssignedNoticeEmbed({ taskId: task.id, title: task.title, assigneeMention: `<@${outcome.primary}>`, coSignerMention: outcome.coSigner ? `<@${outcome.coSigner}>` : null, dueAt: task.due_at }),
  ]).catch((e) => console.error("担当者DM送信に失敗", e));
  return `タスク #${task.id} を辞退しました。${buildReassignNotice({ taskId: task.id, title: task.title, fromMention: `<@${decliningOperatorId}>`, toMention: `<@${outcome.primary}>` })}`;
}

export async function handleTaskHold(env: Env, interaction: Interaction, options: CommandOption[]): Promise<DeferredResult> {
  const requireResult = await requireUnei(env, interaction);
  if ("error" in requireResult) return immediate(requireResult.error);
  const { operatorId } = requireResult;

  const taskIdRaw = optionValue(options, "task_id");
  const resumeAt = optionValue(options, "resume_at");
  const reason = optionValue(options, "reason") ?? null;
  if (!taskIdRaw || !resumeAt) return immediate("task_id・resume_at オプションが必要です（§4.2：再開予定日は必須）。");
  if (!RESUME_DATE_PATTERN.test(resumeAt) || Number.isNaN(Date.parse(`${resumeAt}T00:00:00Z`))) {
    return immediate("resume_at は YYYY-MM-DD 形式の日付で指定してください。");
  }

  const task = await getTask(env, Number(taskIdRaw));
  if (!task) return immediate("指定されたタスクが見つかりません。");
  if (task.assignee !== operatorId) return immediate("このタスクの現在の担当者のみ保留にできます。");

  await holdTask(env, task.id, `${resumeAt}T00:00:00Z`, reason);
  await writeAuditLog(env, { actor: operatorId, action: "task_held", target: String(task.id), detail: { resumeAt, reason } });
  await syncTaskMessage(env, task.id).catch((e) => console.error("タスクメッセージの更新に失敗", e));
  return immediate(`タスク #${task.id} を保留にしました（再開予定日：${resumeAt}。その日になると自動的に割当済へ戻ります）。`);
}

/** 自分に残っているタスクと期限をEphemeral・embed形式で確認する（2026-09-06追加）。 */
export async function handleTaskList(env: Env, interaction: Interaction): Promise<DeferredResult> {
  const requireResult = await requireUnei(env, interaction);
  if ("error" in requireResult) return immediate(requireResult.error);
  const { operatorId } = requireResult;

  const tasks = await listOwnIncompleteTasks(env, operatorId);
  return immediateEmbed(buildOwnTaskListEmbed(operatorId, tasks));
}
