// 投票タスク（T-E）の締切3時間前リマインド（§4.7：未投票者へDMで1回）。

import type { Env } from "../env";
import { hasBallot, listVotesNeedingReminder, markReminderSent } from "../votes/repo";
import { computeCurrentEligibleVoters, computeCurrentParticipantEligibleVoters } from "../votes/eligibility";
import { buildVoteReminderDm } from "../tasks/templates";
import { sendDirectMessage } from "../discord/rest";

const REMINDER_WINDOW_HOURS = 3;

export async function processVoteReminders(env: Env): Promise<void> {
  const now = new Date();
  const windowStartIso = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const windowEndIso = new Date(now.getTime() + REMINDER_WINDOW_HOURS * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

  const votes = await listVotesNeedingReminder(env, windowStartIso, windowEndIso);
  for (const vote of votes) {
    try {
      const eligible = vote.voter_scope === "participant"
        ? await computeCurrentParticipantEligibleVoters(env)
        : await computeCurrentEligibleVoters(env, vote.exclude_target);
      const unvoted: string[] = [];
      for (const voterId of eligible) {
        if (!(await hasBallot(env, vote.id, voterId))) unvoted.push(voterId);
      }
      const content = buildVoteReminderDm({ voteId: vote.id, subject: vote.subject, closesAt: vote.closes_at });
      for (const voterId of unvoted) {
        await sendDirectMessage(env.DISCORD_BOT_TOKEN, voterId, content).catch((e) => console.error(`投票 #${vote.id} のリマインドDM送信に失敗（${voterId}）`, e));
      }
      await markReminderSent(env, vote.id);
    } catch (e) {
      console.error(`投票 #${vote.id} のリマインド処理に失敗`, e);
    }
  }
}
