// applications / claims / protected_areas テーブルの D1 アクセス（§8）。
// CTはD1に直接アクセスしない。Workersがここで読み書きし、ジョブのpayload/resultを介してやり取りする。

import type { Env } from "../env";

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface ClaimRow {
  id: number;
  owner_uuid: string;
  status: string;
  mask_ref: string | null;
  area_blocks: number | null;
  bbox_loc1: string | null; // JSON {x,y,z}
  bbox_loc2: string | null;
  application_id: number | null;
  owner_mc_name: string | null;
}

export interface ClaimWithOwner extends ClaimRow {
  owner_name: string;
}

export async function getActiveClaimByOwnerUuid(env: Env, ownerUuid: string): Promise<ClaimRow | null> {
  const row = await env.DB.prepare("SELECT * FROM claims WHERE owner_uuid = ? AND status = 'active'")
    .bind(ownerUuid)
    .first<ClaimRow>();
  return row ?? null;
}

/**
 * 他参加者の既存の個人開発領（申請者自身は除外・§5.7.1）。
 * owner名は claims.owner_mc_name（非正規化・decisions.md #52）から直接取得する。
 * account_links への JOIN に依存すると、移行データ（tools/migrate_claims.py）のうち
 * 所有者が未だ /authorise で紐づけていないものが重複判定の対象から漏れてしまうため。
 */
export async function listActiveClaimsExcludingOwner(env: Env, ownerUuid: string): Promise<ClaimWithOwner[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM claims WHERE status = 'active' AND owner_uuid != ? AND owner_mc_name IS NOT NULL`,
  )
    .bind(ownerUuid)
    .all<ClaimRow>();
  return (res.results ?? []).map((c) => ({ ...c, owner_name: c.owner_mc_name as string }));
}

/** 複数参加者（代表者一括申請・§5.7.3）を同時に除外する版。 */
export async function listActiveClaimsExcludingOwners(env: Env, ownerUuids: string[]): Promise<ClaimWithOwner[]> {
  if (ownerUuids.length === 0) return listActiveClaimsExcludingOwner(env, "\0__none__");
  const placeholders = ownerUuids.map(() => "?").join(",");
  const res = await env.DB.prepare(
    `SELECT * FROM claims WHERE status = 'active' AND owner_uuid NOT IN (${placeholders}) AND owner_mc_name IS NOT NULL`,
  )
    .bind(...ownerUuids)
    .all<ClaimRow>();
  return (res.results ?? []).map((c) => ({ ...c, owner_name: c.owner_mc_name as string }));
}

export interface ProtectedAreaRow {
  id: number;
  name: string;
  mask_ref: string | null;
  bbox_loc1: string | null;
  bbox_loc2: string | null;
}

/** 特定保護区域一覧（open-items #6：データ投入までは0件。0件なら条件⑤は常に通過する）。 */
export async function listProtectedAreas(env: Env): Promise<ProtectedAreaRow[]> {
  const res = await env.DB.prepare(
    "SELECT id, name, mask_ref, bbox_loc1, bbox_loc2 FROM protected_areas WHERE mask_ref IS NOT NULL",
  ).all<ProtectedAreaRow>();
  return res.results ?? [];
}

export async function insertApplication(
  env: Env,
  args: {
    kind: string;
    requester: string;
    status: string;
    payload: unknown;
    groupKey?: string | null;
    submittedBy?: string | null;
    ownerMcUuid?: string | null;
    ownerMcName?: string | null;
    targetClaimId?: number | null;
    op?: "set" | "delete";
  },
): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO applications
       (kind, requester, status, submitted_at, payload, group_key, submitted_by, owner_mc_uuid, owner_mc_name, target_claim_id, op)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      args.kind,
      args.requester,
      args.status,
      nowIso(),
      JSON.stringify(args.payload ?? {}),
      args.groupKey ?? null,
      args.submittedBy ?? args.requester,
      args.ownerMcUuid ?? null,
      args.ownerMcName ?? null,
      args.targetClaimId ?? null,
      args.op ?? "set",
    )
    .run();
  return Number(res.meta.last_row_id);
}

export interface ApplicationRow {
  id: number;
  kind: string;
  requester: string;
  status: string;
  submitted_at: string;
  effective_at: string | null;
  provisional_until: string | null;
  payload: string;
  group_key: string | null;
  submitted_by: string | null;
  owner_mc_uuid: string | null;
  owner_mc_name: string | null;
  target_claim_id: number | null;
  op: "set" | "delete";
  confirmed_at: string | null;
  revocable_until: string | null;
  held_blocking_application_id: number | null;
  held_blocking_group_key: string | null;
}

export async function getApplication(env: Env, id: number): Promise<ApplicationRow | null> {
  const row = await env.DB.prepare("SELECT * FROM applications WHERE id = ?").bind(id).first<ApplicationRow>();
  return row ?? null;
}

export async function listApplicationsByGroup(env: Env, groupKey: string): Promise<ApplicationRow[]> {
  const res = await env.DB.prepare("SELECT * FROM applications WHERE group_key = ? ORDER BY id ASC")
    .bind(groupKey)
    .all<ApplicationRow>();
  return res.results ?? [];
}

/** 同一Minecraftアカウントが処理中／仮承認中／グループ受付中でないか（§5.7.3：仮承認中の再申請拒否）。 */
export async function hasOpenApplication(env: Env, ownerMcUuid: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT id FROM applications
     WHERE owner_mc_uuid = ? AND kind = 'kaihatsu_set' AND status IN ('processing','provisional','collecting','held')
     LIMIT 1`,
  )
    .bind(ownerMcUuid)
    .first<{ id: number }>();
  return row != null;
}

/** 同一申請者の kaihatsu_set が処理中でないか（Phase 2互換：単独申請の重複投入防止）。 */
export async function hasProcessingKaihatsuSet(env: Env, requester: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT id FROM applications WHERE requester = ? AND kind = 'kaihatsu_set' AND status = 'processing' LIMIT 1",
  )
    .bind(requester)
    .first<{ id: number }>();
  return row != null;
}

export async function updateApplicationStatus(
  env: Env,
  id: number,
  status: string,
  patch?: { effectiveAt?: string; payload?: unknown; revocableUntil?: string | null },
): Promise<void> {
  if (patch?.payload !== undefined) {
    await env.DB.prepare(
      "UPDATE applications SET status = ?, effective_at = COALESCE(?, effective_at), payload = ?, revocable_until = COALESCE(?, revocable_until) WHERE id = ?",
    )
      .bind(status, patch.effectiveAt ?? null, JSON.stringify(patch.payload), patch.revocableUntil ?? null, id)
      .run();
  } else {
    await env.DB.prepare(
      "UPDATE applications SET status = ?, effective_at = COALESCE(?, effective_at), revocable_until = COALESCE(?, revocable_until) WHERE id = ?",
    )
      .bind(status, patch?.effectiveAt ?? null, patch?.revocableUntil ?? null, id)
      .run();
  }
}

export async function markApplicationProvisional(
  env: Env,
  id: number,
  args: { provisionalUntil: string; payload: unknown },
): Promise<void> {
  await env.DB.prepare(
    "UPDATE applications SET status = 'provisional', provisional_until = ?, payload = ? WHERE id = ?",
  )
    .bind(args.provisionalUntil, JSON.stringify(args.payload ?? {}), id)
    .run();
}

/** 本人確認ボタン押下（§5.7.3）。グループの場合は全員confirmedが揃うまで待つ中間状態として使う。 */
/** グループ内のdelete対象者への72時間本人確認（§5.7.4：delete対象者の本人確認）。CT評価は不要。 */
export async function markDeleteMemberProvisional(env: Env, id: number, provisionalUntil: string): Promise<void> {
  await env.DB.prepare("UPDATE applications SET status = 'provisional', provisional_until = ? WHERE id = ?")
    .bind(provisionalUntil, id)
    .run();
}

export async function markApplicationConfirmed(env: Env, id: number): Promise<void> {
  await env.DB.prepare("UPDATE applications SET status = 'confirmed', confirmed_at = ? WHERE id = ?").bind(nowIso(), id).run();
}

export async function markApplicationHeld(
  env: Env,
  id: number,
  args: { blockingApplicationId?: number | null; blockingGroupKey?: string | null; payload: unknown },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE applications
     SET status = 'held', held_blocking_application_id = ?, held_blocking_group_key = ?, payload = ?
     WHERE id = ?`,
  )
    .bind(args.blockingApplicationId ?? null, args.blockingGroupKey ?? null, JSON.stringify(args.payload ?? {}), id)
    .run();
}

export async function clearHeldBlocking(env: Env, id: number): Promise<void> {
  await env.DB.prepare(
    "UPDATE applications SET held_blocking_application_id = NULL, held_blocking_group_key = NULL WHERE id = ?",
  )
    .bind(id)
    .run();
}

export async function setHeldBlockingApplication(env: Env, id: number, blockingApplicationId: number): Promise<void> {
  await env.DB.prepare(
    "UPDATE applications SET held_blocking_application_id = ?, held_blocking_group_key = NULL WHERE id = ?",
  )
    .bind(blockingApplicationId, id)
    .run();
}

export async function listHeldByApplication(env: Env, applicationId: number): Promise<ApplicationRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM applications WHERE status = 'held' AND held_blocking_application_id = ? ORDER BY submitted_at ASC",
  )
    .bind(applicationId)
    .all<ApplicationRow>();
  return res.results ?? [];
}

export async function listHeldByGroup(env: Env, groupKey: string): Promise<ApplicationRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM applications WHERE status = 'held' AND held_blocking_group_key = ? ORDER BY submitted_at ASC",
  )
    .bind(groupKey)
    .all<ApplicationRow>();
  return res.results ?? [];
}

/** 仮承認中の全applications（§5.7.5：他者からの重複候補としてCTへ渡すため。除外はJS側で行う）。 */
export async function listAllProvisionalApplications(env: Env): Promise<ApplicationRow[]> {
  const res = await env.DB.prepare("SELECT * FROM applications WHERE status = 'provisional' ORDER BY submitted_at ASC").all<ApplicationRow>();
  return res.results ?? [];
}

/** ダッシュボード（§4.8：参加者向け申請受付状況）向け。processing（受付処理中）件数。 */
export async function countProcessingApplications(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) as n FROM applications WHERE status = 'processing'").first<{ n: number }>();
  return row?.n ?? 0;
}

/** ダッシュボード向け。指定時刻以降に正式承認（confirmed）された件数。 */
export async function countConfirmedSince(env: Env, sinceIso: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) as n FROM applications WHERE status = 'confirmed' AND confirmed_at >= ?")
    .bind(sinceIso)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** グループ確定済み・未解決のdelete対象claim（§5.7.4最終段落：土地の予約）。 */
export async function listGroupReservedTargetClaims(env: Env, excludeGroupKey?: string): Promise<ApplicationRow[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM applications
     WHERE op = 'delete' AND group_key IS NOT NULL AND group_key != COALESCE(?, '')
       AND status IN ('collecting','provisional') AND target_claim_id IS NOT NULL
     ORDER BY submitted_at ASC`,
  )
    .bind(excludeGroupKey ?? null)
    .all<ApplicationRow>();
  return res.results ?? [];
}

// ── 同時処理グループ（§5.7.4） ───────────────────────────────────────────

export interface ApplicationGroupRow {
  group_key: string;
  representative_discord_id: string;
  status: "collecting" | "finalized" | "approved" | "rejected";
  created_at: string;
  finalized_at: string | null;
  deadline_at: string | null;
  resolved_at: string | null;
}

export async function getOrCreateGroup(env: Env, groupKey: string, representativeDiscordId: string): Promise<ApplicationGroupRow> {
  const existing = await env.DB.prepare("SELECT * FROM application_groups WHERE group_key = ?")
    .bind(groupKey)
    .first<ApplicationGroupRow>();
  if (existing) return existing;
  await env.DB.prepare(
    "INSERT INTO application_groups (group_key, representative_discord_id, status, created_at) VALUES (?, ?, 'collecting', ?)",
  )
    .bind(groupKey, representativeDiscordId, nowIso())
    .run();
  return { group_key: groupKey, representative_discord_id: representativeDiscordId, status: "collecting", created_at: nowIso(), finalized_at: null, deadline_at: null, resolved_at: null };
}

export async function getGroup(env: Env, groupKey: string): Promise<ApplicationGroupRow | null> {
  const row = await env.DB.prepare("SELECT * FROM application_groups WHERE group_key = ?").bind(groupKey).first<ApplicationGroupRow>();
  return row ?? null;
}

export async function finalizeGroup(env: Env, groupKey: string, deadlineIso: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE application_groups SET status = 'finalized', finalized_at = ?, deadline_at = ? WHERE group_key = ?",
  )
    .bind(nowIso(), deadlineIso, groupKey)
    .run();
}

export async function resolveGroupStatus(env: Env, groupKey: string, status: "approved" | "rejected"): Promise<void> {
  await env.DB.prepare("UPDATE application_groups SET status = ?, resolved_at = ? WHERE group_key = ?")
    .bind(status, nowIso(), groupKey)
    .run();
}

export async function listFinalizedGroupsPastDeadline(env: Env, nowIsoValue: string): Promise<ApplicationGroupRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM application_groups WHERE status = 'finalized' AND deadline_at IS NOT NULL AND deadline_at <= ?",
  )
    .bind(nowIsoValue)
    .all<ApplicationGroupRow>();
  return res.results ?? [];
}

export async function listProvisionalApplicationsPastDeadline(env: Env, nowIsoValue: string): Promise<ApplicationRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM applications WHERE status = 'provisional' AND group_key IS NULL AND provisional_until IS NOT NULL AND provisional_until <= ?",
  )
    .bind(nowIsoValue)
    .all<ApplicationRow>();
  return res.results ?? [];
}

export async function getClaim(env: Env, claimId: number): Promise<ClaimRow | null> {
  const row = await env.DB.prepare("SELECT * FROM claims WHERE id = ?").bind(claimId).first<ClaimRow>();
  return row ?? null;
}

export async function supersedeClaim(env: Env, claimId: number, newStatus: "superseded" | "deleted"): Promise<void> {
  await env.DB.prepare("UPDATE claims SET status = ?, updated_at = ? WHERE id = ?")
    .bind(newStatus, nowIso(), claimId)
    .run();
}

export async function insertClaim(
  env: Env,
  args: {
    ownerUuid: string;
    ownerMcName: string;
    maskRef: string;
    areaBlocks: number;
    loc1: { x: number; y: number; z: number };
    loc2: { x: number; y: number; z: number };
    applicationId: number;
  },
): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO claims (owner_uuid, owner_mc_name, status, mask_ref, area_blocks, bbox_loc1, bbox_loc2, application_id, created_at, updated_at)
     VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      args.ownerUuid,
      args.ownerMcName,
      args.maskRef,
      args.areaBlocks,
      JSON.stringify(args.loc1),
      JSON.stringify(args.loc2),
      args.applicationId,
      nowIso(),
      nowIso(),
    )
    .run();
  return Number(res.meta.last_row_id);
}
