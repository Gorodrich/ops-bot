// Phase 3の絶対時刻ベースの締切処理（§9：締切精度・Cron発火間隔に依存しない設計）。
//   * 仮承認（単独の代表者一括申請）の72時間本人確認期限切れ → 期限切れ却下・保留の自動再審査（§5.7.3・§5.7.5）
//   * 同時処理グループの72時間期限切れ → 未確認メンバーをexpired化し、グループ全体を却下（§5.7.4）

import type { Env } from "../env";
import { isPastDeadline } from "../kaihatsu/domain";
import { handleWithdrawOrExpire } from "../kaihatsu/confirmCommand";
import { tryResolveGroup } from "../kaihatsu/groupResolution";
import { listApplicationsByGroup, listFinalizedGroupsPastDeadline, listProvisionalApplicationsPastDeadline } from "../kaihatsu/repo";

export async function processPhase3Deadlines(env: Env): Promise<void> {
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const expiredProvisional = await listProvisionalApplicationsPastDeadline(env, nowIso);
  for (const application of expiredProvisional) {
    await handleWithdrawOrExpire(env, application, "expired");
  }

  const expiredGroups = await listFinalizedGroupsPastDeadline(env, nowIso);
  for (const group of expiredGroups) {
    const members = await listApplicationsByGroup(env, group.group_key);
    for (const m of members) {
      if (m.status === "provisional" && isPastDeadline(nowIso, m.provisional_until)) {
        await env.DB.prepare("UPDATE applications SET status = 'expired' WHERE id = ?").bind(m.id).run();
      }
    }
    await tryResolveGroup(env, group.group_key);
  }
}
