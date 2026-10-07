// job_queue の処理中リース回収（監査指摘・2026-10-07）。
// claimJobs で processing にしたジョブは、CT102 から完了報告が来ない限り processing のまま残り、
// 再試行・上限到達時のエスカレーション・滞留検知（staleJobs.ts は pending のみが対象）のいずれも発火しない。
// CT102 のクラッシュ・強制停止（systemd の停止タイムアウト・OOM）・完了報告の送信失敗で取り残された行を、
// リース期限切れの「失敗報告」として通常の完了処理（handleJobComplete）に流す。
// これにより attempts の加算・再試行のバックオフ・上限到達時の種別ごとの終端処理と運営通知が既存経路どおり行われる。

import type { Env } from "../env";
import { DEFAULT_PROCESSING_LEASE_SEC, getJobRetrySetting } from "../settings";
import { listExpiredLeases } from "../jobs/queue";
import { handleJobComplete } from "../jobs/completion";
import { writeAuditLog } from "../auditLog";

export async function reclaimExpiredLeases(env: Env): Promise<void> {
  const retry = await getJobRetrySetting(env);
  const leaseSec = retry.processing_lease_sec ?? DEFAULT_PROCESSING_LEASE_SEC;
  const lockedBeforeIso = new Date(Date.now() - leaseSec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

  for (const job of await listExpiredLeases(env, lockedBeforeIso)) {
    await handleJobComplete(env, job.id, {
      status: "failed",
      error: `処理中リース期限切れ（${leaseSec}秒以内にCT102から完了報告がありませんでした）`,
    });
    await writeAuditLog(env, { actor: "system", action: "job_lease_expired", target: String(job.id), detail: { kind: job.kind, lease_sec: leaseSec } });
  }
}
