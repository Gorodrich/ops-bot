// 督促の段階的エスカレーション（§4.7）。Lv1:DM Lv2:担当者メンション Lv3:全体共有 Lv4:自動再割当。
// 静穏時間・1日あたりの頻度上限を尊重し、文面は固定テンプレート（LLM不使用）。

import type { Env } from "../env";
import { getChannels, getNudgeSetting, getTaskTargetDays, type NudgeLevelEntry } from "../settings";
import { isWithinDailyWindow } from "../tasks/assignment";
import {
  assignTask,
  countNudgesToday,
  listNudgeCandidates,
  markUnassignedNeedsManualReview,
  recordNudge,
  resetEscalationAfterReassign,
  type TaskRow,
} from "../tasks/repo";
import { autoAssign } from "../tasks/autoAssign";
import { computeBotDefaultDueAt } from "../tasks/deadlines";
import {
  buildAssignedNotice,
  buildNudgeBroadcastMessage,
  buildNudgeDmMessage,
  buildNudgeMentionMessage,
  buildNudgeReassignBroadcastMessage,
} from "../tasks/templates";
import { sendChannelMessage, sendDirectMessage } from "../discord/rest";
import { syncTaskMessage } from "../tasks/notify";
import { writeAuditLog } from "../auditLog";
import type { PermissionTier } from "../tasks/assignment";

export async function processNudges(env: Env): Promise<void> {
  const now = new Date();
  const nudgeSetting = await getNudgeSetting(env);
  if (isWithinDailyWindow(nudgeSetting.quiet_hours.from, nudgeSetting.quiet_hours.to, now)) return;

  const nowIso = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const channels = await getChannels(env);
  if (!channels.unei_only) {
    console.error("settings.channels.unei_only が未設定のため督促（Lv2以降・自動再割当の通知）を送信できません");
    return;
  }
  const uneiChannelId = channels.unei_only;
  const tasks = await listNudgeCandidates(env, nowIso);

  for (const task of tasks) {
    try {
      await maybeNudge(env, task, nudgeSetting.levels, nudgeSetting.max_per_day, now, uneiChannelId);
    } catch (e) {
      console.error(`タスク #${task.id} の督促処理に失敗`, e);
    }
  }
}

async function maybeNudge(
  env: Env,
  task: TaskRow,
  levels: NudgeLevelEntry[],
  maxPerDay: number,
  now: Date,
  uneiChannelId: string,
): Promise<void> {
  if (!task.due_at || !task.assignee) return;
  const hoursOverdue = (now.getTime() - new Date(task.due_at).getTime()) / 3_600_000;
  const applicable = levels.filter((l) => hoursOverdue >= l.hours_after_due).sort((a, b) => b.level - a.level);
  const target = applicable[0];
  if (!target || target.level <= task.escalation_level) return;

  const sentToday = await countNudgesToday(env, task.id);
  if (sentToday >= maxPerDay) return;

  const assigneeMention = `<@${task.assignee}>`;

  if (target.target === "dm") {
    await sendDirectMessage(env.DISCORD_BOT_TOKEN, task.assignee, buildNudgeDmMessage({ taskId: task.id, title: task.title, dueAt: task.due_at }));
  } else if (target.target === "mention") {
    await sendChannelMessage(env.DISCORD_BOT_TOKEN, uneiChannelId, buildNudgeMentionMessage({ taskId: task.id, title: task.title, assigneeMention, dueAt: task.due_at }));
  } else if (target.target === "broadcast") {
    await sendChannelMessage(env.DISCORD_BOT_TOKEN, uneiChannelId, buildNudgeBroadcastMessage({ taskId: task.id, title: task.title, assigneeMention, dueAt: task.due_at }));
  } else if (target.target === "reassign") {
    await reassignOnEscalation(env, task, uneiChannelId);
  }

  await recordNudge(env, task.id, target.level, task.assignee);
  await writeAuditLog(env, { actor: "system", action: "task_nudged", target: String(task.id), detail: { level: target.level, target_type: target.target } });
}

async function reassignOnEscalation(env: Env, task: TaskRow, uneiChannelId: string): Promise<void> {
  const requiredTags = JSON.parse(task.required_tags || "[]") as string[];
  const declinedHistory = JSON.parse(task.declined_by || "[]") as string[];
  const outcome = await autoAssign(
    env,
    {
      requiredTags,
      requiresTechnician: task.requires_technician === 1,
      requiredPermissionTier: (task.required_permission_tier as PermissionTier) || null,
      isControversial: task.is_controversial === 1,
    },
    [...declinedHistory, task.assignee as string],
  );

  const fromMention = `<@${task.assignee}>`;
  if (outcome.reason === "ok" && outcome.primary) {
    const targetDays = await getTaskTargetDays(env);
    const newDueAt = computeBotDefaultDueAt(targetDays, task.type, new Date());
    await assignTask(env, task.id, { assignee: outcome.primary, coSigner: outcome.coSigner });
    await resetEscalationAfterReassign(env, task.id, newDueAt);
    await syncTaskMessage(env, task.id).catch((e) => console.error(`タスク #${task.id} のタスクメッセージ更新に失敗`, e));
    await sendDirectMessage(
      env.DISCORD_BOT_TOKEN,
      outcome.primary,
      buildAssignedNotice({ taskId: task.id, title: task.title, assigneeMention: `<@${outcome.primary}>`, coSignerMention: outcome.coSigner ? `<@${outcome.coSigner}>` : null, dueAt: newDueAt }),
    ).catch((e) => console.error("担当者DM送信に失敗", e));
    await sendChannelMessage(env.DISCORD_BOT_TOKEN, uneiChannelId, buildNudgeReassignBroadcastMessage({ taskId: task.id, title: task.title, fromMention, toMention: `<@${outcome.primary}>` }));
    await writeAuditLog(env, { actor: "system", action: "task_reassigned", target: String(task.id), detail: { from: task.assignee, to: outcome.primary, reason: "nudge_lv4" } });
    return;
  }

  await markUnassignedNeedsManualReview(env, task.id);
  await syncTaskMessage(env, task.id, { manualReviewNote: "督促Lv4の自動再割当に失敗しました（候補者なし、またはスコア確定不可）" }).catch((e) =>
    console.error(`タスク #${task.id} のタスクメッセージ更新に失敗`, e),
  );
  await sendChannelMessage(env.DISCORD_BOT_TOKEN, uneiChannelId, buildNudgeReassignBroadcastMessage({ taskId: task.id, title: task.title, fromMention, toMention: null }));
  await writeAuditLog(env, { actor: "system", action: "task_unassigned_manual_review", target: String(task.id), detail: { reason: outcome.reason } });
}
