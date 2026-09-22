// job_queue の滞留検知（G-10で判明）：CT102のポーリングプロセス自体が完全停止していると、
// jobs/completion.ts の再試行上限チェック（attempts）は一切発火しない（claim/complete報告が
// 来ないため attempts が増えない）。ここでは「一度も claim されないまま長時間 pending の
// ジョブ」を別経路で検知し、タスク起票・運営専用チャンネルへの通知を行う（§6.4.4と同型の縮退動作）。
//
// ジョブ自体は pending のまま残す（stale_notified_at は通知済みの印にすぎない）。
// CT102復旧後は claimJobs が通常どおり拾って処理する。

import type { Env } from "../env";
import { getJobRetrySetting } from "../settings";
import { issueSystemTask } from "../tasks/autoIssue";

interface StaleJobRow {
  id: number;
  kind: string;
  created_at: string;
}

export async function detectStaleJobs(env: Env): Promise<void> {
  const retry = await getJobRetrySetting(env);
  const thresholdIso = new Date(Date.now() - retry.stale_after_sec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

  const stale = await env.DB.prepare(
    `SELECT id, kind, created_at FROM job_queue
     WHERE status = 'pending' AND locked_at IS NULL AND stale_notified_at IS NULL AND created_at <= ?
     ORDER BY id ASC LIMIT 50`,
  )
    .bind(thresholdIso)
    .all<StaleJobRow>();

  const jobs = stale.results ?? [];
  if (jobs.length === 0) return;

  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  for (const job of jobs) {
    await issueSystemTask(env, {
      title: `ジョブ滞留：CT102が job_queue #${job.id}（${job.kind}）を取得していません`,
      summary: `job_queue #${job.id}（kind=${job.kind}）が ${retry.stale_after_sec}秒以上 claim されていません（作成: ${job.created_at}）。CT102のポーリングプロセスの停止が疑われます。`,
      relatedRule: "§6.4.4",
      priority: "high",
      requiredTags: ["technical"],
      requiresDeveloper: true,
    });

    await env.DB.prepare("UPDATE job_queue SET stale_notified_at = ? WHERE id = ?").bind(nowIso, job.id).run();
  }
}
