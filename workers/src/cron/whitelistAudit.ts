// 日次ホワイトリスト突合（§6.4.4）：CT102にジョブを積むだけ。
// 実際のCraftyからの取得はCT102側（crafty_op と同じジョブキュー経由）で行う。
// 突合の差分計算・通知は completeJob 経由（jobs/completion.ts）で行う。
//
// 起動時刻はWorkers Cron Triggers（wrangler.jsonc、デプロイ時固定）で制御する。
// settings.job_retry.crafty_audit_report_hour_utc を変更した場合は wrangler.jsonc 側の
// cron 式も合わせて変更し再デプロイすること（Cron Triggers はD1から動的に読めないため）。

import type { Env } from "../env";
import { enqueueJob } from "../jobs/queue";

export async function triggerWhitelistAudit(env: Env): Promise<void> {
  await enqueueJob(env, "crafty_whitelist_audit", {});
}
