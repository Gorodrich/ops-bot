// modvote（運営の承認・§5.2/§5.3）・vote（参加者投票・2026-09-06決定）の両方から共有される処理。
// 賛否ボタン（custom_id: vote:yes:<id> 等）は投票IDのみで対象を特定できるため、両方のコマンド系統で
// 1つのハンドラを共有し、投票行の voter_scope に応じて母数の算出元・分類表・投稿先の扱いを分岐する。

import type { Env } from "../env";
import { InteractionResponseType, type Interaction } from "../discord/types";
import { editChannelMessage, sendChannelMessage, EPHEMERAL_FLAG } from "../discord/rest";
import { writeAuditLog } from "../auditLog";
import { getApprovalTypes, getParticipantApprovalTypes } from "../settings";
import { isValidBallotChoice, tallyVote } from "./domain";
import { computeCurrentEligibleVoters, computeCurrentParticipantEligibleVoters } from "./eligibility";
import { castBallot, finalizeVoteTally, countBallots, getVote, hasBallot, type VoteRow } from "./repo";
import { resolveUneiActor } from "../staff/subaccountEligibility";
import {
  buildBallotAckMessage,
  buildVoteResultEmbed,
  VOTE_ABSTAIN_BUTTON_PREFIX,
  VOTE_MESSAGES,
  VOTE_NO_BUTTON_PREFIX,
  VOTE_YES_BUTTON_PREFIX,
} from "./templates";
import type { DeferredResult } from "../accountLinks/authoriseCommand";

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function immediate(content: string): DeferredResult {
  return {
    ack: { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content, flags: EPHEMERAL_FLAG } },
    followUp: async () => {},
  };
}

async function eligibleVotersFor(env: Env, vote: VoteRow): Promise<string[]> {
  return vote.voter_scope === "participant"
    ? computeCurrentParticipantEligibleVoters(env)
    : computeCurrentEligibleVoters(env, vote.exclude_target);
}

export interface TallyOutcome {
  vote: VoteRow;
  result: ReturnType<typeof tallyVote>;
}

/**
 * 投票を集計・締切・結果投稿する。Cron（締切到来・絶対時刻ベース・§9）・`/modvote end`・`/vote end`
 * （早期終了）のいずれからも呼ぶ。`finalizeVoteTally` が `status = 'open'` を条件に更新するため、
 * Cronと早期終了が競合しても実際に締切処理を行うのはどちらか一方のみになる。
 */
export async function closeAndTallyVote(env: Env, vote: VoteRow, endedEarlyBy?: string): Promise<TallyOutcome | null> {
  const counts = await countBallots(env, vote.id);
  const result = tallyVote({
    yes: counts.yes,
    no: counts.no,
    abstain: counts.abstain,
    eligibleCount: vote.eligible_count,
    quorumType: vote.quorum_type,
    threshold: vote.threshold,
  });

  const closedByThisCall = await finalizeVoteTally(env, vote.id, result);
  if (!closedByThisCall) return null;

  const approvalTypes = vote.voter_scope === "participant" ? await getParticipantApprovalTypes(env) : await getApprovalTypes(env);
  const label = approvalTypes[vote.approval_key]?.label ?? vote.approval_key;
  const embed = buildVoteResultEmbed({ voteId: vote.id, label, subject: vote.subject, result, endedEarlyBy });

  if (vote.channel_id) {
    await sendChannelMessage(env.DISCORD_BOT_TOKEN, vote.channel_id, "", [embed]).catch((e) => console.error("vote result post failed", e));
  }
  if (vote.message_id && vote.channel_id) {
    await editChannelMessage(env.DISCORD_BOT_TOKEN, vote.channel_id, vote.message_id, { components: [] }).catch(() => {});
  }
  if (vote.task_id) {
    await env.DB.prepare(
      `UPDATE tasks SET status = 'done', completed_at = ?, completion_evidence = ? WHERE id = ?`,
    )
      .bind(nowIso(), `賛成${result.yes}／反対${result.no}／棄権${result.abstain} → ${result.passed ? "可決" : "否決"}`, vote.task_id)
      .run();
  }

  await writeAuditLog(env, {
    actor: endedEarlyBy ?? "system",
    action: endedEarlyBy ? "vote_ended_early" : "vote_tallied",
    target: String(vote.id),
    detail: { yes: result.yes, no: result.no, abstain: result.abstain, passed: result.passed, originalClosesAt: vote.closes_at, voterScope: vote.voter_scope },
  });

  return { vote, result };
}

/** 賛否ボタン押下（MESSAGE_COMPONENT）。押下結果はephemeral応答とし、他の投票者からは見えないようにする（§5.2-2）。 */
export async function handleVoteBallotButton(env: Env, interaction: Interaction): Promise<DeferredResult> {
  const actorId = interaction.member?.user.id;
  if (!actorId) return immediate("このボタンはサーバー内でのみ使用できます。");

  const customId = interaction.data?.custom_id ?? "";
  let choiceValue: string;
  let prefix: string;
  if (customId.startsWith(VOTE_YES_BUTTON_PREFIX)) { choiceValue = "yes"; prefix = VOTE_YES_BUTTON_PREFIX; }
  else if (customId.startsWith(VOTE_NO_BUTTON_PREFIX)) { choiceValue = "no"; prefix = VOTE_NO_BUTTON_PREFIX; }
  else if (customId.startsWith(VOTE_ABSTAIN_BUTTON_PREFIX)) { choiceValue = "abstain"; prefix = VOTE_ABSTAIN_BUTTON_PREFIX; }
  else return immediate("不明な操作です。");
  if (!isValidBallotChoice(choiceValue)) return immediate("不明な選択肢です。");

  const voteId = Number(customId.slice(prefix.length));
  const vote = await getVote(env, voteId);
  if (!vote || vote.status !== "open") return immediate(VOTE_MESSAGES.alreadyClosed);

  // 運営投票（voter_scope='unei'）は運営サブ垢からの一票をメイン垢の一票とみなす（2026-09-07決定）。
  // 参加者投票は対象外（人民ロール保有者本人のみが行使できる）。
  let ballotActorId = actorId;
  if (vote.voter_scope === "unei") {
    const resolved = await resolveUneiActor(env, interaction.member);
    if (!resolved.ok) return immediate(resolved.message);
    ballotActorId = resolved.actorId;
  }

  const eligible = await eligibleVotersFor(env, vote);
  if (!eligible.includes(ballotActorId)) {
    return immediate(vote.voter_scope === "participant" ? VOTE_MESSAGES.notEligibleParticipant : VOTE_MESSAGES.notEligible);
  }

  const alreadyVoted = await hasBallot(env, voteId, ballotActorId);
  await castBallot(env, voteId, ballotActorId, choiceValue);

  return {
    ack: { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: buildBallotAckMessage(choiceValue), flags: EPHEMERAL_FLAG } },
    followUp: async () => {
      await writeAuditLog(env, {
        actor: ballotActorId,
        action: alreadyVoted ? "vote_ballot_changed" : "vote_ballot_cast",
        target: String(voteId),
        // 個票の選択内容そのものは秘密投票の趣旨（§5.2-2・§5.2-7）に反するため監査ログにも残さない。
        // 「誰が投票したか」の事実のみ棄権みなし判定のため記録する（§5.2-8）。
        detail: { voted: true },
      });
    },
  };
}
