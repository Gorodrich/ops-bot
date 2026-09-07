// /vote start・status・end（参加者投票・2026-09-06決定）。
// 従来の運営の承認（/modvote）とは母数（「人民」ロール＝settings.roles.hito）・分類表
// （settings.participant_approval_types）・投稿先（settings.channels.participant_vote_hall）が異なる。
// 短縮投票（quick）は参加者投票には存在しないため実装しない。
// 開始・終了の実行資格は /modvote と同じ運営者ロール（承認事項の起票自体は運営が行うため）。
// 投票そのものの可決要件（quorum_type/threshold）は settings.participant_approval_types 側の分類表に従う。

import type { Env } from "../env";
import { InteractionResponseType, type CommandOption, type Interaction, optionValue } from "../discord/types";
import { getChannels, getDeadlines, getParticipantApprovalTypes } from "../settings";
import { resolveUneiActor } from "../staff/subaccountEligibility";
import { sendChannelMessageWithComponents, sendFollowupMessage, EPHEMERAL_FLAG } from "../discord/rest";
import { writeAuditLog } from "../auditLog";
import { addHoursIso, tallyVote } from "./domain";
import { computeCurrentParticipantEligibleVoters } from "./eligibility";
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

const PARTICIPANT_METHOD_LABEL = "秘密投票（参加者による承認）";
const PARTICIPANT_ELIGIBLE_COUNT_NOTE = "母数（「人民」ロール保有者数）";

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

export async function handleParticipantVoteStart(env: Env, interaction: Interaction, options: CommandOption[]): Promise<DeferredResult> {
  const resolved = await resolveUneiActor(env, interaction.member);
  if (!resolved.ok) return immediate(resolved.message);
  const operatorId = resolved.actorId;

  const approvalKey = optionValue(options, "approval_key");
  const subject = optionValue(options, "subject");
  if (!approvalKey || !subject) return immediate("approval_key・subject オプションが必要です。");

  const approvalTypes = await getParticipantApprovalTypes(env);
  const entry = approvalTypes[approvalKey];
  if (!entry) return immediate(VOTE_MESSAGES.unknownParticipantApprovalKey);

  const quorumType = entry.quorum_type ?? "voters_majority";
  const threshold = entry.threshold ?? 0.5;

  return {
    ack: { type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: EPHEMERAL_FLAG } },
    followUp: async () => {
      const eligible = await computeCurrentParticipantEligibleVoters(env);
      if (eligible.length === 0) {
        await sendFollowupMessage(env.DISCORD_APP_ID, interaction.token, { content: VOTE_MESSAGES.noEligibleVotersParticipant, flags: EPHEMERAL_FLAG });
        return;
      }

      // 期限は運営投票と同じ24時間（settings.deadlines.vote_hours）を流用する（決定事項）。
      const deadlines = await getDeadlines(env);
      const startedAt = nowIso();
      const closesAt = addHoursIso(startedAt, deadlines.vote_hours);

      const voteId = await insertVote(env, {
        subject,
        approvalKey,
        voterScope: "participant",
        method: "secret",
        quorumType,
        threshold,
        excludeTarget: null,
        closesAt,
        eligibleCount: eligible.length,
        createdBy: operatorId,
      });

      const channels = await getChannels(env);
      const channelId = channels.participant_vote_hall;
      if (!channelId) {
        await sendFollowupMessage(env.DISCORD_APP_ID, interaction.token, {
          content: "参加者投票チャンネル（settings.channels.participant_vote_hall）が未設定のため、投票は作成しましたが投稿できませんでした。",
          flags: EPHEMERAL_FLAG,
        });
        return;
      }

      const { content, embed } = buildVoteOpenedEmbed({
        voteId,
        label: entry.label,
        subject,
        method: "secret",
        methodLabel: PARTICIPANT_METHOD_LABEL,
        eligibleCount: eligible.length,
        eligibleCountNote: PARTICIPANT_ELIGIBLE_COUNT_NOTE,
        closesAtDiscordTimestamp: discordTimestamp(closesAt),
      });

      const messageId = await sendChannelMessageWithComponents(env.DISCORD_BOT_TOKEN, channelId, content, buildVoteButtonRow(voteId), [embed]);
      await setVoteMessage(env, voteId, channelId, messageId);

      const taskRes = await env.DB.prepare(
        `INSERT INTO tasks (type, title, summary, related_rule, status, priority, due_at, deadline_source, created_at, assigned_at, vote_id)
         VALUES ('T-E', ?, ?, '§5.5/§5.6', 'in_progress', 'medium', ?, 'rule', ?, ?, ?)`,
      )
        .bind(`参加者投票 #${voteId}：${entry.label}`, subject, closesAt, startedAt, startedAt, voteId)
        .run();
      await setVoteTaskId(env, voteId, Number(taskRes.meta.last_row_id));

      await writeAuditLog(env, {
        actor: operatorId,
        action: "participant_vote_started",
        target: String(voteId),
        detail: { approvalKey, subject, eligibleCount: eligible.length, closesAt },
      });

      await sendFollowupMessage(env.DISCORD_APP_ID, interaction.token, {
        content: `参加者投票 #${voteId} を開始しました（<#${channelId}>）。`,
        flags: EPHEMERAL_FLAG,
      });
    },
  };
}

/**
 * `/vote end`・`/vote status` の `vote_id` オプション（autocomplete）。/modvote 側とテーブルは共通のため、
 * voter_scope='participant' で絞り込み、運営投票の候補が混ざらないようにする。
 */
export async function handleParticipantVoteIdAutocomplete(
  env: Env,
  subcommandName: string,
  query: string,
): Promise<Array<{ name: string; value: string }>> {
  const onlyOpen = subcommandName === "end";
  const votes = await searchVotesForAutocomplete(env, { query, onlyOpen, voterScope: "participant" });
  return votes.map((v) => ({
    name: `${v.subject}（#${v.id}）`.slice(0, 100),
    value: String(v.id),
  }));
}

export async function handleParticipantVoteStatus(env: Env, interaction: Interaction, options: CommandOption[]): Promise<DeferredResult> {
  const operator = interaction.member;
  if (!operator) return immediate("このコマンドはサーバー内でのみ実行できます。");

  const voteIdOption = optionValue(options, "vote_id");
  const approvalTypes = await getParticipantApprovalTypes(env);

  if (voteIdOption) {
    const vote = await getVote(env, Number(voteIdOption));
    if (!vote || vote.voter_scope !== "participant") return immediate("指定された投票が見つかりません。");
    const entry = approvalTypes[vote.approval_key];
    const result = vote.result ? (JSON.parse(vote.result) as ReturnType<typeof tallyVote>) : null;
    return immediate(
      buildVoteStatusLine({
        voteId: vote.id,
        label: entry?.label ?? vote.approval_key,
        subject: vote.subject,
        method: vote.method,
        methodLabel: PARTICIPANT_METHOD_LABEL,
        closesAtDiscordTimestamp: discordTimestamp(vote.closes_at),
        status: vote.status,
        result,
      }),
    );
  }

  const open = await listOpenVotes(env, "participant");
  if (open.length === 0) return immediate(VOTE_MESSAGES.noOpenVotes);
  const lines = open.map((vote) =>
    buildVoteStatusLine({
      voteId: vote.id,
      label: approvalTypes[vote.approval_key]?.label ?? vote.approval_key,
      subject: vote.subject,
      method: vote.method,
      methodLabel: PARTICIPANT_METHOD_LABEL,
      closesAtDiscordTimestamp: discordTimestamp(vote.closes_at),
      status: vote.status,
    }),
  );
  return immediate(lines.join("\n"));
}

/** /vote end：期限到来前でも投票を即座に終了する。実行資格は /vote start と同じ（運営者ロール）。 */
export async function handleParticipantVoteEnd(env: Env, interaction: Interaction, options: CommandOption[]): Promise<DeferredResult> {
  const resolved = await resolveUneiActor(env, interaction.member);
  if (!resolved.ok) return immediate(resolved.message);

  const voteIdOption = optionValue(options, "vote_id");
  if (!voteIdOption) return immediate("vote_id オプションが必要です。");
  const voteId = Number(voteIdOption);

  const vote = await getVote(env, voteId);
  if (!vote || vote.voter_scope !== "participant") return immediate("指定された投票が見つかりません。");
  if (vote.status !== "open") return immediate(VOTE_MESSAGES.alreadyClosed);

  return {
    ack: { type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: EPHEMERAL_FLAG } },
    followUp: async () => {
      const outcome = await closeAndTallyVote(env, vote, resolved.actorId);
      if (!outcome) {
        await sendFollowupMessage(env.DISCORD_APP_ID, interaction.token, {
          content: `参加者投票 #${voteId} は既に締め切られていました（締切処理と競合した可能性があります）。`,
          flags: EPHEMERAL_FLAG,
        });
        return;
      }
      await sendFollowupMessage(env.DISCORD_APP_ID, interaction.token, {
        content: `参加者投票 #${voteId} を締切前に終了し、結果を投稿しました。`,
        flags: EPHEMERAL_FLAG,
      });
    },
  };
}
