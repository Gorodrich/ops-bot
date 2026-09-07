// Mojang API 連携（§3.4.5：CT102 経由のジョブとして実行する。Workersからの直接呼び出しはしない）。
//
// 経緯：Workers（Cloudflareのデータセンター系IP）からの直接呼び出しはMojang APIに403で
// 拒否されることが実地確認で判明したため、CT102（プル方式ポーリング・§3.4.2）を経由する
// 方式に変更した（旧: Workersから直接fetch）。ユーザー名の実在確認・UUID解決は
// job_queue の "mojang_lookup" ジョブとしてCT102に実行させ、Workers側は完了をポーリングする。

import type { Env } from "./env";
import { enqueueJob } from "./jobs/queue";

export interface MojangProfile {
  uuid: string; // ハイフン無し32桁
  name: string; // 解決時点の表示名
}

interface MojangLookupResult {
  found: boolean;
  uuid?: string;
  name?: string;
}

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 60_000; // CT102側の最大アイドル間隔（既定45秒）+ 余裕

/**
 * Minecraftユーザー名からUUIDを解決する。
 * 実在しない場合、またはCT102側のジョブがタイムアウトした場合は null を返す（却下条件①）。
 * タイムアウトと「実在しない」は呼び出し側で区別できるよう timedOut フラグを返す。
 */
export async function resolveMinecraftProfile(
  env: Env,
  username: string,
): Promise<{ profile: MojangProfile | null; timedOut: boolean }> {
  const jobId = await enqueueJob(env, "mojang_lookup", { username });

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const row = await env.DB.prepare("SELECT status, result FROM job_queue WHERE id = ?")
      .bind(jobId)
      .first<{ status: string; result: string | null }>();

    if (row?.status === "done") {
      const result = row.result ? (JSON.parse(row.result) as MojangLookupResult) : { found: false };
      if (!result.found || !result.uuid || !result.name) return { profile: null, timedOut: false };
      return { profile: { uuid: normalizeUuid(result.uuid), name: result.name }, timedOut: false };
    }
    // 失敗時は job_queue 側で status='pending' に戻し再試行待ちになる（jobs/queue.ts）。
    // ここでは done になるまで待ち、POLL_TIMEOUT_MS を超えたらタイムアウト扱いとする。

    await sleep(POLL_INTERVAL_MS);
  }

  return { profile: null, timedOut: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** ハイフン無しUUIDをハイフン付き標準形へ正規化する（表示・保存用）。 */
export function normalizeUuid(uuid: string): string {
  const hex = uuid.replace(/-/g, "").toLowerCase();
  if (hex.length !== 32) return uuid;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
