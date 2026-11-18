// 投票の開始処理（/modvote start・/modvote quick・/vote start と、rule-builder の RPC で共有する）。
// コマンドの入力の確認・応答はそれぞれの呼び出し元で行い、ここでは母数の算出・投票の作成・投稿・タスクの作成・監査記録だけを行う。

import type { Env } from "../env";
import { getApprovalTypes, getChannels, getDeadlines, getParticipantApprovalTypes } from "../settings";
import { editChannelMessage, sendChannelMessage, sendChannelMessageWithComponents } from "../discord/rest";
import { writeAuditLog } from "../auditLog";
import { addHoursIso, addMinutesIso } from "./domain";
import { computeCurrentEligibleVoters, computeCurrentParticipantEligibleVoters } from "./eligibility";
import { cancelOpenVote, insertVote, setVoteMessage, setVoteTaskId } from "./repo";
import { buildVoteButtonRow, buildVoteOpenedEmbed, VOTE_MESSAGES, type VoteEmbedField } from "./templates";

const PARTICIPANT_METHOD_LABEL = "秘密投票（参加者による承認）";
const PARTICIPANT_ELIGIBLE_COUNT_NOTE = "母数（「人民」ロール保有者数）";

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function discordTimestamp(iso: string): string {
  return `<t:${Math.floor(new Date(iso).getTime() / 1000)}:F>`;
}

export type OpenVoteResult =
  | { ok: true; voteId: number; closesAt: string; channelId: string }
  /** 投票を始められなかった（作ったが投稿できなかった投票は打ち切り済み） */
  | { ok: false; message: string };

/** 投稿に失敗した投票は、母数に数えた運営者の画面に残らないよう打ち切っておく */
async function abandon(env: Env, voteId: number, operatorId: string, reason: string): Promise<void> {
  await cancelOpenVote(env, voteId).catch(() => {});
  await writeAuditLog(env, { actor: operatorId, action: "vote_open_failed", target: String(voteId), detail: { reason } });
}

async function createTask(env: Env, args: { title: string; summary: string; relatedRule: string; closesAt: string; startedAt: string; voteId: number }) {
  const taskRes = await env.DB.prepare(
    `INSERT INTO tasks (type, title, summary, related_rule, status, priority, due_at, deadline_source, created_at, assigned_at, vote_id)
     VALUES ('T-E', ?, ?, ?, 'in_progress', 'medium', ?, 'rule', ?, ?, ?)`,
  )
    .bind(args.title, args.summary, args.relatedRule, args.closesAt, args.startedAt, args.startedAt, args.voteId)
    .run();
  await setVoteTaskId(env, args.voteId, Number(taskRes.meta.last_row_id));
}

/** 運営投票（秘密投票・短縮投票）を始める。approvalKey は settings.approval_types のキー（類型A） */
export async function openUneiVote(
  env: Env,
  args: {
    approvalKey: string;
    subject: string;
    method: "secret" | "quick";
    operatorId: string;
    targetUserId?: string | null;
    ruleProposalId?: string | null;
    extraFields?: VoteEmbedField[];
  },
): Promise<OpenVoteResult> {
  const approvalTypes = await getApprovalTypes(env);
  const entry = approvalTypes[args.approvalKey];
  if (!entry) return { ok: false, message: VOTE_MESSAGES.unknownApprovalKey };
  if (entry.method !== "A") return { ok: false, message: VOTE_MESSAGES.methodBMismatch };
  if (entry.exclude_self && !args.targetUserId) return { ok: false, message: VOTE_MESSAGES.targetRequired };

  // 短縮投票（§5.3）は quorum_type/threshold を通常投票の分類表とは別ロジックに固定する（決定事項）。
  const quorumType = args.method === "quick" ? "total_majority_excl_abstain" : (entry.quorum_type ?? "voters_majority");
  const threshold = args.method === "quick" ? 0.5 : (entry.threshold ?? 0.5);
  const excludeTarget = entry.exclude_self ? (args.targetUserId ?? null) : null;

  const eligible = await computeCurrentEligibleVoters(env, excludeTarget);
  if (eligible.length === 0) return { ok: false, message: VOTE_MESSAGES.noEligibleVoters };

  const channels = await getChannels(env);
  const channelId = channels.vote_hall;
  if (!channelId) {
    return { ok: false, message: "投票場チャンネル（settings.channels.vote_hall）が未設定のため、投票を開始できません。" };
  }

  const deadlines = await getDeadlines(env);
  const startedAt = nowIso();
  const closesAt = args.method === "quick"
    ? addMinutesIso(startedAt, deadlines.quick_vote_minutes)
    : addHoursIso(startedAt, deadlines.vote_hours);

  const voteId = await insertVote(env, {
    subject: args.subject,
    approvalKey: args.approvalKey,
    voterScope: "unei",
    method: args.method,
    quorumType,
    threshold,
    excludeTarget,
    closesAt,
    eligibleCount: eligible.length,
    createdBy: args.operatorId,
    ruleProposalId: args.ruleProposalId ?? null,
  });

  const { content, embed } = buildVoteOpenedEmbed({
    voteId,
    label: entry.label,
    subject: args.subject,
    method: args.method,
    eligibleCount: eligible.length,
    closesAtDiscordTimestamp: discordTimestamp(closesAt),
    targetMention: args.targetUserId ? `<@${args.targetUserId}>` : null,
    // rule-builder の改正案は参加者投票まで OpsBot が扱うので、「運営側の手続のみ扱う」の注記は出さない
    participantVoteRequired: args.ruleProposalId ? false : entry.participant_vote_required,
    extraFields: args.extraFields,
  });

  let messageId: string;
  try {
    messageId = await sendChannelMessageWithComponents(env.DISCORD_BOT_TOKEN, channelId, content, buildVoteButtonRow(voteId), [embed]);
  } catch (e) {
    console.error(`投票 #${voteId} を投稿できませんでした`, e);
    await abandon(env, voteId, args.operatorId, "post_failed");
    return { ok: false, message: "投票場に投稿できなかったため、投票を開始できませんでした。" };
  }
  await setVoteMessage(env, voteId, channelId, messageId);
  await createTask(env, {
    title: `投票 #${voteId}：${entry.label}`,
    summary: args.subject,
    relatedRule: "§5.2/§5.3/§5.5",
    closesAt,
    startedAt,
    voteId,
  });

  await writeAuditLog(env, {
    actor: args.operatorId,
    action: args.method === "quick" ? "vote_quick_started" : "vote_started",
    target: String(voteId),
    detail: {
      approvalKey: args.approvalKey,
      subject: args.subject,
      eligibleCount: eligible.length,
      closesAt,
      targetUserId: args.targetUserId ?? undefined,
      ruleProposalId: args.ruleProposalId ?? undefined,
    },
  });

  return { ok: true, voteId, closesAt, channelId };
}

/** 参加者投票（/vote）を始める。approvalKey は settings.participant_approval_types のキー */
export async function openParticipantVote(
  env: Env,
  args: {
    approvalKey: string;
    subject: string;
    operatorId: string;
    ruleProposalId?: string | null;
    extraFields?: VoteEmbedField[];
  },
): Promise<OpenVoteResult> {
  const approvalTypes = await getParticipantApprovalTypes(env);
  const entry = approvalTypes[args.approvalKey];
  if (!entry) return { ok: false, message: VOTE_MESSAGES.unknownParticipantApprovalKey };

  const quorumType = entry.quorum_type ?? "voters_majority";
  const threshold = entry.threshold ?? 0.5;

  const eligible = await computeCurrentParticipantEligibleVoters(env);
  if (eligible.length === 0) return { ok: false, message: VOTE_MESSAGES.noEligibleVotersParticipant };

  const channels = await getChannels(env);
  const channelId = channels.participant_vote_hall;
  if (!channelId) {
    return {
      ok: false,
      message: "参加者投票チャンネル（settings.channels.participant_vote_hall）が未設定のため、投票を開始できません。",
    };
  }

  // 期限は運営投票と同じ24時間（settings.deadlines.vote_hours）を流用する（決定事項）。
  const deadlines = await getDeadlines(env);
  const startedAt = nowIso();
  const closesAt = addHoursIso(startedAt, deadlines.vote_hours);

  const voteId = await insertVote(env, {
    subject: args.subject,
    approvalKey: args.approvalKey,
    voterScope: "participant",
    method: "secret",
    quorumType,
    threshold,
    excludeTarget: null,
    closesAt,
    eligibleCount: eligible.length,
    createdBy: args.operatorId,
    ruleProposalId: args.ruleProposalId ?? null,
  });

  const { content, embed } = buildVoteOpenedEmbed({
    voteId,
    label: entry.label,
    subject: args.subject,
    method: "secret",
    methodLabel: PARTICIPANT_METHOD_LABEL,
    eligibleCount: eligible.length,
    eligibleCountNote: PARTICIPANT_ELIGIBLE_COUNT_NOTE,
    closesAtDiscordTimestamp: discordTimestamp(closesAt),
    extraFields: args.extraFields,
  });

  let messageId: string;
  try {
    messageId = await sendChannelMessageWithComponents(env.DISCORD_BOT_TOKEN, channelId, content, buildVoteButtonRow(voteId), [embed]);
  } catch (e) {
    console.error(`参加者投票 #${voteId} を投稿できませんでした`, e);
    await abandon(env, voteId, args.operatorId, "post_failed");
    return { ok: false, message: "参加者投票のチャンネルに投稿できなかったため、投票を開始できませんでした。" };
  }
  await setVoteMessage(env, voteId, channelId, messageId);
  await createTask(env, {
    title: `参加者投票 #${voteId}：${entry.label}`,
    summary: args.subject,
    relatedRule: "§5.5/§5.6",
    closesAt,
    startedAt,
    voteId,
  });

  await writeAuditLog(env, {
    actor: args.operatorId,
    action: "participant_vote_started",
    target: String(voteId),
    detail: {
      approvalKey: args.approvalKey,
      subject: args.subject,
      eligibleCount: eligible.length,
      closesAt,
      ruleProposalId: args.ruleProposalId ?? undefined,
    },
  });

  return { ok: true, voteId, closesAt, channelId };
}

/**
 * 進行中の投票を集計せずに打ち切る（rule-builder の取り下げ）。個票は破棄し、ボタンを外して打ち切りを投稿する。
 * 既に締め切られていれば何もしない（false を返す）。
 */
export async function abortVote(env: Env, voteId: number, byId: string, reason: string): Promise<boolean> {
  const vote = await cancelOpenVote(env, voteId);
  if (!vote) return false;
  if (vote.channel_id && vote.message_id) {
    await editChannelMessage(env.DISCORD_BOT_TOKEN, vote.channel_id, vote.message_id, { components: [] }).catch(() => {});
  }
  if (vote.channel_id) {
    await sendChannelMessage(env.DISCORD_BOT_TOKEN, vote.channel_id, `投票 #${voteId} は${reason}のため打ち切りました（集計しません）。`).catch(
      (e) => console.error("vote abort post failed", e),
    );
  }
  if (vote.task_id) {
    await env.DB.prepare("UPDATE tasks SET status = 'done', completed_at = ?, completion_evidence = ? WHERE id = ?")
      .bind(nowIso(), `打ち切り（${reason}）`, vote.task_id)
      .run();
  }
  await writeAuditLog(env, { actor: byId, action: "vote_aborted", target: String(voteId), detail: { reason } });
  return true;
}
