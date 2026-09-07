// job_queue（CT102 がポーリングで取得・§3.4.2／§8）への積み込みと取得・完了処理。
// Workers → CT102 の接続は一切発生しない（CT102からのアウトバウンドポーリングのみ）。

import type { Env } from "../env";

export type JobKind = "image_process" | "crafty_op" | "claude_code" | "crafty_whitelist_audit" | "mojang_lookup" | "dynmap_sync";

export interface JobRow {
  id: number;
  kind: JobKind;
  payload: string;
  status: "pending" | "processing" | "done" | "failed";
  attempts: number;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function enqueueJob(env: Env, kind: JobKind, payload: unknown): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO job_queue (kind, payload, status, attempts, created_at, updated_at)
     VALUES (?, ?, 'pending', 0, ?, ?)`,
  )
    .bind(kind, JSON.stringify(payload), nowIso(), nowIso())
    .run();
  return Number(res.meta.last_row_id);
}

interface Capacity {
  image?: number;
  llm?: number;
  crafty?: number;
}

const KIND_CAPACITY_FIELD: Record<JobKind, keyof Capacity> = {
  image_process: "image",
  claude_code: "llm",
  crafty_op: "crafty",
  crafty_whitelist_audit: "crafty",
  // Mojang API 呼び出しも軽量なHTTP呼び出しのため、crafty枠を共用する。
  mojang_lookup: "crafty",
  // Dynmap反映もCrafty File Manager API経由の軽量な呼び出しのため、crafty枠を共用する（§6.3.4）。
  dynmap_sync: "crafty",
};

/**
 * 未処理ジョブを容量の範囲で取得し、排他ロック（processing）を掛けて返す（二重実行防止・§8）。
 * 種別ごとに容量が尽きたらそれ以上は取得しない（§11-13：画像処理・LLMの同時実行制限）。
 */
export async function claimJobs(env: Env, capacity: Capacity, workerId: string): Promise<JobRow[]> {
  const remaining: Capacity = { ...capacity };
  const claimed: JobRow[] = [];

  const pending = await env.DB.prepare(
    `SELECT id, kind, payload, status, attempts FROM job_queue
     WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?)
     ORDER BY id ASC LIMIT 50`,
  )
    .bind(nowIso())
    .all<JobRow>();

  for (const job of pending.results ?? []) {
    const field = KIND_CAPACITY_FIELD[job.kind];
    const cap = remaining[field] ?? 0;
    if (cap <= 0) continue;

    const res = await env.DB.prepare(
      `UPDATE job_queue SET status = 'processing', locked_by = ?, locked_at = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
      .bind(workerId, nowIso(), nowIso(), job.id)
      .run();
    if (res.meta.changes && res.meta.changes > 0) {
      remaining[field] = cap - 1;
      claimed.push(job);
    }
  }

  return claimed;
}

export async function completeJob(
  env: Env,
  id: number,
  outcome: { status: "done" | "failed"; result?: unknown; error?: string },
): Promise<JobRow | null> {
  const job = await env.DB.prepare("SELECT id, kind, payload, status, attempts FROM job_queue WHERE id = ?")
    .bind(id)
    .first<JobRow>();
  if (!job) return null;

  if (outcome.status === "done") {
    await env.DB.prepare(
      `UPDATE job_queue SET status = 'done', result = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(JSON.stringify(outcome.result ?? null), nowIso(), id)
      .run();
    return { ...job, status: "done" };
  }

  // 失敗：再試行スケジュールへ戻す（呼び出し側が上限超過を判断してエスカレーションする）
  const attempts = job.attempts + 1;
  await env.DB.prepare(
    `UPDATE job_queue SET status = 'pending', attempts = ?, result = ?, next_retry_at = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(attempts, JSON.stringify({ error: outcome.error ?? "unknown" }), null, nowIso(), id)
    .run();
  return { ...job, status: "pending", attempts };
}

export async function scheduleRetry(env: Env, id: number, nextRetryAtIso: string): Promise<void> {
  await env.DB.prepare("UPDATE job_queue SET next_retry_at = ?, updated_at = ? WHERE id = ?")
    .bind(nextRetryAtIso, nowIso(), id)
    .run();
}

/** 再試行上限に達したジョブを終端状態にする（以後 claimJobs に二度と拾わせない・通知の連投防止）。 */
export async function markFailedTerminal(env: Env, id: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE job_queue SET status = 'failed', next_retry_at = NULL, updated_at = ? WHERE id = ?`,
  )
    .bind(nowIso(), id)
    .run();
}
