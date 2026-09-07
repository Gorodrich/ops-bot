// votes / vote_ballots への読み書き（§5.2・§5.3・§8）。

import type { Env } from "../env";
import type { QuorumType } from "../settings";
import type { BallotChoice } from "./domain";

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface VoteRow {
  id: number;
  subject: string;
  vote_type: string;
  voter_scope: "unei" | "participant";
  approval_key: string;
  method: "secret" | "quick";
  quorum_type: QuorumType;
  threshold: number;
  exclude_target: string | null;
  started_at: string;
  closes_at: string;
  status: "open" | "closed";
  eligible_count: number;
  result: string | null;
  tallied_at: string | null;
  created_by: string;
  channel_id: string | null;
  message_id: string | null;
  task_id: number | null;
  reminder_sent_at: string | null;
}

export async function insertVote(
  env: Env,
  args: {
    subject: string;
    approvalKey: string;
    voterScope: "unei" | "participant";
    method: "secret" | "quick";
    quorumType: QuorumType;
    threshold: number;
    excludeTarget: string | null;
    closesAt: string;
    eligibleCount: number;
    createdBy: string;
  },
): Promise<number> {
  const voteType = args.voterScope === "participant" ? "participant_secret" : args.method === "quick" ? "quick" : "type_a";
  const res = await env.DB.prepare(
    `INSERT INTO votes
       (subject, vote_type, voter_scope, approval_key, method, quorum_type, threshold, exclude_target,
        started_at, closes_at, status, eligible_count, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
  )
    .bind(
      args.subject,
      voteType,
      args.voterScope,
      args.approvalKey,
      args.method,
      args.quorumType,
      args.threshold,
      args.excludeTarget,
      nowIso(),
      args.closesAt,
      args.eligibleCount,
      args.createdBy,
    )
    .run();
  return Number(res.meta.last_row_id);
}

export async function setVoteMessage(env: Env, voteId: number, channelId: string, messageId: string): Promise<void> {
  await env.DB.prepare("UPDATE votes SET channel_id = ?, message_id = ? WHERE id = ?").bind(channelId, messageId, voteId).run();
}

export async function setVoteTaskId(env: Env, voteId: number, taskId: number): Promise<void> {
  await env.DB.prepare("UPDATE votes SET task_id = ? WHERE id = ?").bind(taskId, voteId).run();
}

export async function getVote(env: Env, id: number): Promise<VoteRow | null> {
  return env.DB.prepare("SELECT * FROM votes WHERE id = ?").bind(id).first<VoteRow>();
}

export async function listOpenVotes(env: Env, voterScope: "unei" | "participant"): Promise<VoteRow[]> {
  const res = await env.DB.prepare("SELECT * FROM votes WHERE status = 'open' AND voter_scope = ? ORDER BY closes_at ASC")
    .bind(voterScope)
    .all<VoteRow>();
  return res.results ?? [];
}

export async function listOpenVotesPastDeadline(env: Env, nowIsoValue: string): Promise<VoteRow[]> {
  const res = await env.DB.prepare("SELECT * FROM votes WHERE status = 'open' AND closes_at <= ?").bind(nowIsoValue).all<VoteRow>();
  return res.results ?? [];
}

/**
 * 締切3時間前のリマインド対象（§4.7：未投票の投票タスクは締切3時間前に1回DM）。
 * `windowEndIso`＝now+3h、`windowStartIso`＝now。closes_atがこの範囲に入った投票を対象とする
 * （Cronの発火間隔をまたいでも取りこぼさないよう、reminder_sent_atで一度送ったものを除外する）。
 */
export async function listVotesNeedingReminder(env: Env, windowStartIso: string, windowEndIso: string): Promise<VoteRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM votes WHERE status = 'open' AND reminder_sent_at IS NULL AND closes_at > ? AND closes_at <= ?",
  )
    .bind(windowStartIso, windowEndIso)
    .all<VoteRow>();
  return res.results ?? [];
}

export async function markReminderSent(env: Env, voteId: number): Promise<void> {
  await env.DB.prepare("UPDATE votes SET reminder_sent_at = ? WHERE id = ?").bind(nowIso(), voteId).run();
}

/**
 * `/vote end`・`/vote status` の vote_id オプション（autocomplete）向け検索。
 * 運営者が投票IDを直接把握していなくても、開始時の件名（subject）の一部一致で選択できるようにする。
 * Discordのautocomplete選択肢は最大25件のため、それに合わせて上限を設ける。
 */
export async function searchVotesForAutocomplete(
  env: Env,
  args: { query: string; onlyOpen: boolean; voterScope: "unei" | "participant"; limit?: number },
): Promise<VoteRow[]> {
  const limit = args.limit ?? 25;
  const like = `%${args.query.replace(/[\\%_]/g, "\\$&")}%`;
  const sql = args.onlyOpen
    ? "SELECT * FROM votes WHERE status = 'open' AND voter_scope = ? AND subject LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?"
    : "SELECT * FROM votes WHERE voter_scope = ? AND subject LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?";
  const res = await env.DB.prepare(sql).bind(args.voterScope, like, limit).all<VoteRow>();
  return res.results ?? [];
}

/** 二重投票防止（PRIMARY KEY (vote_id, voter_id)・§9）。既存票があれば上書きする（締切前の投票変更を許容）。 */
export async function castBallot(env: Env, voteId: number, voterId: string, choice: BallotChoice): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO vote_ballots (vote_id, voter_id, choice, cast_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(vote_id, voter_id) DO UPDATE SET choice = excluded.choice, cast_at = excluded.cast_at`,
  )
    .bind(voteId, voterId, choice, nowIso())
    .run();
}

export async function hasBallot(env: Env, voteId: number, voterId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 FROM vote_ballots WHERE vote_id = ? AND voter_id = ?").bind(voteId, voterId).first();
  return row !== null;
}

export async function countBallots(env: Env, voteId: number): Promise<{ yes: number; no: number; abstain: number }> {
  const res = await env.DB.prepare(
    `SELECT choice, COUNT(*) as n FROM vote_ballots WHERE vote_id = ? GROUP BY choice`,
  )
    .bind(voteId)
    .all<{ choice: string; n: number }>();
  const counts = { yes: 0, no: 0, abstain: 0 };
  for (const row of res.results ?? []) {
    if (row.choice === "yes" || row.choice === "no" || row.choice === "abstain") counts[row.choice] = row.n;
  }
  return counts;
}

/**
 * 集計確定＋個票の破棄（§5.2-8・§8：締切・集計後は個票を破棄する）。
 * `WHERE status = 'open'` により、Cronの締切処理・ボタン起点の処理・`/vote end` による早期終了が
 * 競合した場合でも二重集計・二重投稿が起きないようにする（先着1件のみが成功しclosedにできる）。
 * 戻り値は自分が締切処理を行った（＝先着だった）かどうか。
 */
export async function finalizeVoteTally(env: Env, voteId: number, result: unknown): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE votes SET status = 'closed', result = ?, tallied_at = ? WHERE id = ? AND status = 'open'`,
  )
    .bind(JSON.stringify(result), nowIso(), voteId)
    .run();
  const closedByThisCall = (res.meta.changes ?? 0) > 0;
  if (closedByThisCall) {
    await env.DB.prepare("DELETE FROM vote_ballots WHERE vote_id = ?").bind(voteId).run();
  }
  return closedByThisCall;
}
