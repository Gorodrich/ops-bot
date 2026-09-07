// 投票の締切処理（§9：絶対時刻ベース・Cron発火間隔に依存しない）。
// 秘密投票（24時間・§5.2-3）・短縮投票（既定15分・§5.3）のいずれも closes_at で判定する。

import type { Env } from "../env";
import { listOpenVotesPastDeadline } from "../votes/repo";
import { closeAndTallyVote } from "../votes/voteShared";

export async function processVoteDeadlines(env: Env): Promise<void> {
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const due = await listOpenVotesPastDeadline(env, nowIso);
  for (const vote of due) {
    await closeAndTallyVote(env, vote).catch((e) => console.error(`vote #${vote.id} の締切処理に失敗`, e));
  }
}
