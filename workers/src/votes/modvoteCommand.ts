// /modvote start・quick・status・end・hogokuiki_build（§5.2・§5.3・§5.6）。
// 旧 /vote を改名したもの（2026-09-06決定：参加者投票の新設に伴い、運営の承認専用コマンドと明確に分離）。

import type { Env } from "../env";
import { InteractionResponseType, type CommandOption, type Interaction, optionValue, resolvedAttachment } from "../discord/types";
import { getApprovalTypes, getChannels, getDeadlines } from "../settings";
import { resolveUneiActor } from "../staff/subaccountEligibility";
import { sendChannelMessageWithComponents, sendFollowupMessage, EPHEMERAL_FLAG } from "../discord/rest";
import { writeAuditLog } from "../auditLog";
import { addHoursIso, addMinutesIso, tallyVote } from "./domain";
import { computeCurrentEligibleVoters } from "./eligibility";
import {
  getVote,
  insertVote,
  listOpenVotes,
  searchVotesForAutocomplete,
  setVoteMessage,
  setVoteTaskId,
} from "./repo";
import {
  buildVoteButtonRow,
  buildVoteOpenedEmbed,
  buildVoteStatusLine,
  VOTE_MESSAGES,
} from "./templates";
import { closeAndTallyVote } from "./voteShared";
import type { DeferredResult } from "../accountLinks/authoriseCommand";

function immediate(content: string): DeferredResult {
  return {
    ack: { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content, flags: EPHEMERAL_FLAG } },
    followUp: async () => {},
  };
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function discordTimestamp(iso: string): string {
  return `<t:${Math.floor(new Date(iso).getTime() / 1000)}:F>`;
}

async function startVote(env: Env, interaction: Interaction, options: CommandOption[], method: "secret" | "quick"): Promise<DeferredResult> {
  const resolved = await resolveUneiActor(env, interaction.member);
  if (!resolved.ok) return immediate(resolved.message);
  const operatorId = resolved.actorId;

  const approvalKey = optionValue(options, "approval_key");
  const subject = optionValue(options, "subject");
  const targetUserId = optionValue(options, "target");
  if (!approvalKey || !subject) return immediate("approval_key・subject オプションが必要です。");

  const approvalTypes = await getApprovalTypes(env);
  const entry = approvalTypes[approvalKey];
  if (!entry) return immediate(VOTE_MESSAGES.unknownApprovalKey);
  if (entry.method !== "A") return immediate(VOTE_MESSAGES.methodBMismatch);
  if (entry.exclude_self && !targetUserId) return immediate(VOTE_MESSAGES.targetRequired);

  // 短縮投票（§5.3）は quorum_type/threshold を通常投票の分類表とは別ロジックに固定する（決定事項）。
  const quorumType = method === "quick" ? "total_majority_excl_abstain" : (entry.quorum_type ?? "voters_majority");
  const threshold = method === "quick" ? 0.5 : (entry.threshold ?? 0.5);

  return {
    ack: { type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: EPHEMERAL_FLAG } },
    followUp: async () => {
      const eligible = await computeCurrentEligibleVoters(env, entry.exclude_self ? targetUserId : null);
      if (eligible.length === 0) {
        await sendFollowupMessage(env.DISCORD_APP_ID, interaction.token, { content: VOTE_MESSAGES.noEligibleVoters, flags: EPHEMERAL_FLAG });
        return;
      }

      const deadlines = await getDeadlines(env);
      const startedAt = nowIso();
      const closesAt = method === "quick"
        ? addMinutesIso(startedAt, deadlines.quick_vote_minutes)
        : addHoursIso(startedAt, deadlines.vote_hours);

      const voteId = await insertVote(env, {
        subject,
        approvalKey,
        voterScope: "unei",
        method,
        quorumType,
        threshold,
        excludeTarget: entry.exclude_self ? (targetUserId ?? null) : null,
        closesAt,
        eligibleCount: eligible.length,
        createdBy: operatorId,
      });

      const channels = await getChannels(env);
      const channelId = channels.vote_hall;
      if (!channelId) {
        await sendFollowupMessage(env.DISCORD_APP_ID, interaction.token, {
          content: "投票場チャンネル（settings.channels.vote_hall）が未設定のため、投票は作成しましたが投稿できませんでした。",
          flags: EPHEMERAL_FLAG,
        });
        return;
      }

      const { content, embed } = buildVoteOpenedEmbed({
        voteId,
        label: entry.label,
        subject,
        method,
        eligibleCount: eligible.length,
        closesAtDiscordTimestamp: discordTimestamp(closesAt),
        targetMention: targetUserId ? `<@${targetUserId}>` : null,
        participantVoteRequired: entry.participant_vote_required,
      });

      const messageId = await sendChannelMessageWithComponents(env.DISCORD_BOT_TOKEN, channelId, content, buildVoteButtonRow(voteId), [embed]);
      await setVoteMessage(env, voteId, channelId, messageId);

      const taskRes = await env.DB.prepare(
        `INSERT INTO tasks (type, title, summary, related_rule, status, priority, due_at, deadline_source, created_at, assigned_at, vote_id)
         VALUES ('T-E', ?, ?, '§5.2/§5.3/§5.5', 'in_progress', 'medium', ?, 'rule', ?, ?, ?)`,
      )
        .bind(`投票 #${voteId}：${entry.label}`, subject, closesAt, startedAt, startedAt, voteId)
        .run();
      await setVoteTaskId(env, voteId, Number(taskRes.meta.last_row_id));

      await writeAuditLog(env, {
        actor: operatorId,
        action: method === "quick" ? "vote_quick_started" : "vote_started",
        target: String(voteId),
        detail: { approvalKey, subject, eligibleCount: eligible.length, closesAt, targetUserId },
      });

      await sendFollowupMessage(env.DISCORD_APP_ID, interaction.token, {
        content: `投票 #${voteId} を開始しました（<#${channelId}>）。`,
        flags: EPHEMERAL_FLAG,
      });
    },
  };
}

/**
 * `/modvote end`・`/modvote status` の `vote_id` オプション（autocomplete）。運営者が投票IDを暗記していなくても、
 * 開始時に入力したsubjectの一部一致で「件名（#id）」の形式から選べるようにする（2026-09-06追加）。
 * `end`は締切済みの投票を終了できないため、候補を`open`のもののみに絞る。
 */
export async function handleModvoteIdAutocomplete(
  env: Env,
  subcommandName: string,
  query: string,
): Promise<Array<{ name: string; value: string }>> {
  const onlyOpen = subcommandName === "end";
  const votes = await searchVotesForAutocomplete(env, { query, onlyOpen, voterScope: "unei" });
  return votes.map((v) => ({
    name: `${v.subject}（#${v.id}）`.slice(0, 100),
    value: String(v.id),
  }));
}

export const handleModvoteStart = (env: Env, interaction: Interaction, options: CommandOption[]) => startVote(env, interaction, options, "secret");
export const handleModvoteQuick = (env: Env, interaction: Interaction, options: CommandOption[]) => startVote(env, interaction, options, "quick");

// /modvote hogokuiki_build（特定保護区域内の建築・採掘の承認要請・禁止事項及び罰則に関するルール第12条第1項）。
// 独立コマンドではなく /modvote のサブコマンドとして統合し、内部的には秘密投票（類型A）の開始経路に乗せる。
// approval_key は settings.approval_types の "protected_area_build_approval" に固定する（§5.5）。
const HOGOKUIKI_BUILD_APPROVAL_KEY = "protected_area_build_approval";

export async function handleModvoteHogokuikiBuild(env: Env, interaction: Interaction, options: CommandOption[]): Promise<DeferredResult> {
  const areaName = optionValue(options, "area_name");
  if (!areaName) return immediate("area_name オプションが必要です。");
  const description = optionValue(options, "description");
  const attachment = resolvedAttachment(interaction, "area_image", options);

  const subjectParts = [`特定保護区域「${areaName}」内での建築・採掘の承認`];
  if (description) subjectParts.push(description);
  if (attachment) subjectParts.push(attachment.url);

  const voteOptions: CommandOption[] = [
    { name: "approval_key", type: 3, value: HOGOKUIKI_BUILD_APPROVAL_KEY },
    { name: "subject", type: 3, value: subjectParts.join(" / ") },
  ];
  return startVote(env, interaction, voteOptions, "secret");
}

export async function handleModvoteStatus(env: Env, interaction: Interaction, options: CommandOption[]): Promise<DeferredResult> {
  const resolvedStatus = await resolveUneiActor(env, interaction.member);
  if (!resolvedStatus.ok) return immediate(resolvedStatus.message);

  const voteIdOption = optionValue(options, "vote_id");
  const approvalTypes = await getApprovalTypes(env);

  if (voteIdOption) {
    const vote = await getVote(env, Number(voteIdOption));
    if (!vote || vote.voter_scope !== "unei") return immediate("指定された投票が見つかりません。");
    const entry = approvalTypes[vote.approval_key];
    const result = vote.result ? (JSON.parse(vote.result) as ReturnType<typeof tallyVote>) : null;
    return immediate(
      buildVoteStatusLine({
        voteId: vote.id,
        label: entry?.label ?? vote.approval_key,
        subject: vote.subject,
        method: vote.method,
        closesAtDiscordTimestamp: discordTimestamp(vote.closes_at),
        status: vote.status,
        result,
      }),
    );
  }

  const open = await listOpenVotes(env, "unei");
  if (open.length === 0) return immediate(VOTE_MESSAGES.noOpenVotes);
  const lines = open.map((vote) =>
    buildVoteStatusLine({
      voteId: vote.id,
      label: approvalTypes[vote.approval_key]?.label ?? vote.approval_key,
      subject: vote.subject,
      method: vote.method,
      closesAtDiscordTimestamp: discordTimestamp(vote.closes_at),
      status: vote.status,
    }),
  );
  return immediate(lines.join("\n"));
}

/** /modvote end：期限到来前でも投票を即座に終了する。実行資格は /modvote start・/modvote quick と同じ（運営者ロール）。 */
export async function handleModvoteEnd(env: Env, interaction: Interaction, options: CommandOption[]): Promise<DeferredResult> {
  const resolvedEnd = await resolveUneiActor(env, interaction.member);
  if (!resolvedEnd.ok) return immediate(resolvedEnd.message);

  const voteIdOption = optionValue(options, "vote_id");
  if (!voteIdOption) return immediate("vote_id オプションが必要です。");
  const voteId = Number(voteIdOption);

  const vote = await getVote(env, voteId);
  if (!vote || vote.voter_scope !== "unei") return immediate("指定された投票が見つかりません。");
  if (vote.status !== "open") return immediate(VOTE_MESSAGES.alreadyClosed);

  return {
    ack: { type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: EPHEMERAL_FLAG } },
    followUp: async () => {
      const outcome = await closeAndTallyVote(env, vote, resolvedEnd.actorId);
      if (!outcome) {
        await sendFollowupMessage(env.DISCORD_APP_ID, interaction.token, {
          content: `投票 #${voteId} は既に締め切られていました（締切処理と競合した可能性があります）。`,
          flags: EPHEMERAL_FLAG,
        });
        return;
      }
      await sendFollowupMessage(env.DISCORD_APP_ID, interaction.token, {
        content: `投票 #${voteId} を締切前に終了し、結果を投稿しました。`,
        flags: EPHEMERAL_FLAG,
      });
    },
  };
}
