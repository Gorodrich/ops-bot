// Phase 3 の共通オーケストレーション（§5.7.2〜§5.7.5・§6.3.4）。
// 単独申請（Phase 2互換の即時確定）・代表者一括申請（§5.7.3）・同時処理グループ（§5.7.4）の
// いずれからも呼ばれる「重複候補プールの構築」「正式承認の確定」「保留の解放」を1箇所に集約する。

import type { Env } from "../env";
import { getDeadlines, getChannels } from "../settings";
import { sendChannelMessage, sendChannelMessageWithFileAndComponents, sendDirectMessage } from "../discord/rest";
import { writeAuditLog } from "../auditLog";
import { enqueueJob } from "../jobs/queue";
import { addHoursIso, decomposeApplication, worldBBoxFromLocJson, type WorldBBox } from "./domain";
import {
  type ApplicationRow,
  type ClaimWithOwner,
  getClaim,
  insertClaim,
  listActiveClaimsExcludingOwners,
  listGroupReservedTargetClaims,
  listHeldByApplication,
  listHeldByGroup,
  listAllProvisionalApplications,
  listProtectedAreas,
  markApplicationHeld,
  setHeldBlockingApplication,
  clearHeldBlocking,
  supersedeClaim,
  updateApplicationStatus,
} from "./repo";
import {
  buildApprovedEmbed,
  buildGroupDeleteConfirmedEmbed,
  buildHeldNoticeEmbed,
  buildHeldRejectedEmbed,
  buildRevokeButtonRow,
  KAIHATSU_MESSAGES,
} from "./templates";

export interface OverlapCandidate {
  claim_id: number;
  owner_uuid: string;
  owner_name: string;
  mask_ref: string;
  bbox: WorldBBox;
  kind: "confirmed" | "provisional" | "reserved";
  ref_type: "application" | "group" | null;
  ref_id: number | string | null;
}

/** CT側の kaihatsu_set / kaihatsu_set_batch ジョブに渡す既存領域候補プールを構築する（§5.7.5・§5.7.4末尾）。 */
export async function buildOverlapCandidatePool(
  env: Env,
  args: { excludeOwnerUuids: string[]; excludeGroupKey?: string },
): Promise<OverlapCandidate[]> {
  const confirmedRows = await listActiveClaimsExcludingOwners(env, args.excludeOwnerUuids);
  const confirmed: OverlapCandidate[] = confirmedRows
    .map((c) => ({ c, bbox: worldBBoxFromLocJson(c.bbox_loc1, c.bbox_loc2) }))
    .filter((x): x is { c: ClaimWithOwner; bbox: WorldBBox } => x.bbox !== null && Boolean(x.c.mask_ref))
    .map(({ c, bbox }) => ({
      claim_id: c.id,
      owner_uuid: c.owner_uuid,
      owner_name: c.owner_name,
      mask_ref: c.mask_ref as string,
      bbox,
      kind: "confirmed" as const,
      ref_type: null,
      ref_id: null,
    }));

  const excludeSet = new Set(args.excludeOwnerUuids);
  const provisionalRows = await listAllProvisionalApplications(env);
  const provisional: OverlapCandidate[] = provisionalRows
    .filter((r) => !excludeSet.has(r.owner_mc_uuid ?? ""))
    .map((r): OverlapCandidate | null => {
      const payload = safeJsonParse<{ ctResult?: { mask_saved_path?: string; bbox?: { x1: number; z1: number; x2: number; z2: number } } }>(r.payload);
      const bbox = payload?.ctResult?.bbox;
      const maskRef = payload?.ctResult?.mask_saved_path;
      if (!bbox || !maskRef) return null;
      return {
        claim_id: -1,
        owner_uuid: r.owner_mc_uuid ?? "",
        owner_name: r.owner_mc_name ?? "",
        mask_ref: maskRef,
        bbox,
        kind: "provisional",
        ref_type: "application",
        ref_id: r.id,
      };
    })
    .filter((x): x is OverlapCandidate => x !== null);

  const reservedRows = await listGroupReservedTargetClaims(env, args.excludeGroupKey);
  const reservedCandidates: OverlapCandidate[] = [];
  for (const r of reservedRows) {
    if (!r.target_claim_id) continue;
    const claim = await getClaim(env, r.target_claim_id);
    const bbox = claim ? worldBBoxFromLocJson(claim.bbox_loc1, claim.bbox_loc2) : null;
    if (!claim || !bbox || !claim.mask_ref) continue;
    reservedCandidates.push({
      claim_id: claim.id,
      owner_uuid: claim.owner_uuid,
      owner_name: claim.owner_mc_name ?? r.owner_mc_name ?? "",
      mask_ref: claim.mask_ref,
      bbox,
      kind: "reserved",
      ref_type: "group",
      ref_id: r.group_key,
    });
  }

  // provisional/reserved（保留候補）は届出時刻の古い順に並べる（CT側のタイブレークに使う・§5.7.5）。
  const pending = [...provisional, ...reservedCandidates];
  return [...confirmed, ...pending];
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function safeJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

interface CtSetResult {
  outcome: "approved" | "rejected" | "held";
  reasons: string[];
  area_blocks?: number;
  bbox?: { x1: number; z1: number; x2: number; z2: number };
  loc1?: { x: number; y: number; z: number };
  loc2?: { x: number; y: number; z: number };
  removed_pixels?: number;
  added_pixels?: number;
  had_previous_claim?: boolean;
  mask_saved_path?: string;
  confirmation_image_base64?: string;
  held_blocking_ref_type?: "application" | "group";
  held_blocking_ref_id?: number | string;
  overlap_pending?: Array<{ owner_name: string; pixels: number; ref_type: string | null; ref_id: number | string | null }>;
}

/** 仮承認へ遷移させる（§5.7.3：72時間の本人確認待ち）。 */
export async function markProvisional(
  env: Env,
  application: ApplicationRow,
  result: CtSetResult,
  previousClaimId: number | null,
): Promise<void> {
  const deadlines = await getDeadlines(env);
  const provisionalUntil = addHoursIso(new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), deadlines.provisional_confirm_hours);
  await env.DB.prepare(
    "UPDATE applications SET status = 'provisional', provisional_until = ?, payload = ? WHERE id = ?",
  )
    .bind(provisionalUntil, JSON.stringify({ ctResult: result, previousClaimId }), application.id)
    .run();
}

/** CTが held を返した場合の保留登録＋通知（§5.7.5）。 */
export async function markHeldAndNotify(env: Env, application: ApplicationRow, result: CtSetResult): Promise<void> {
  const blockingRefType = result.held_blocking_ref_type ?? null;
  const blockingRefId = result.held_blocking_ref_id ?? null;
  await markApplicationHeld(env, application.id, {
    blockingApplicationId: blockingRefType === "application" ? Number(blockingRefId) : null,
    blockingGroupKey: blockingRefType === "group" ? String(blockingRefId) : null,
    payload: { ctResult: result },
  });

  const deadlines = await getDeadlines(env);
  const blockerName = result.overlap_pending?.[0]?.owner_name ?? "他の参加者";
  const deadlineIso =
    blockingRefType === "application"
      ? await getProvisionalDeadline(env, Number(blockingRefId))
      : await getGroupDeadline(env, String(blockingRefId));

  const discordTs = deadlineIso ? `<t:${Math.floor(new Date(deadlineIso).getTime() / 1000)}:f>` : `最大${deadlines.conflict_hold_hours}時間後`;
  const embed = buildHeldNoticeEmbed({ representativeMention: `<@${application.submitted_by ?? application.requester}>`, blockingOwnerName: blockerName, deadlineDiscordTimestamp: discordTs });
  await sendDirectMessage(env.DISCORD_BOT_TOKEN, application.submitted_by ?? application.requester, "", [embed]).catch(() => {});
}

async function getProvisionalDeadline(env: Env, applicationId: number): Promise<string | null> {
  const row = await env.DB.prepare("SELECT provisional_until FROM applications WHERE id = ?").bind(applicationId).first<{ provisional_until: string | null }>();
  return row?.provisional_until ?? null;
}

async function getGroupDeadline(env: Env, groupKey: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT deadline_at FROM application_groups WHERE group_key = ?").bind(groupKey).first<{ deadline_at: string | null }>();
  return row?.deadline_at ?? null;
}

/** 正式承認の確定（set系）：claim登録・24h撤回猶予の設定・Dynmap反映ジョブ投入・通知・保留解放（§5.7.5）。 */
export async function finalizeApprovedSet(
  env: Env,
  application: ApplicationRow,
  result: CtSetResult,
  previousClaimId: number | null,
): Promise<void> {
  if (result.outcome !== "approved") return;

  if (previousClaimId) {
    await supersedeClaim(env, previousClaimId, "superseded");
  }
  const ownerUuid = application.owner_mc_uuid ?? "";
  const ownerName = application.owner_mc_name ?? "";
  const claimId = await insertClaim(env, {
    ownerUuid,
    ownerMcName: ownerName,
    maskRef: result.mask_saved_path ?? "",
    areaBlocks: result.area_blocks ?? 0,
    loc1: result.loc1 ?? { x: 0, y: 64, z: 0 },
    loc2: result.loc2 ?? { x: 0, y: 64, z: 0 },
    applicationId: application.id,
  });

  const deadlines = await getDeadlines(env);
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const revocableUntil = addHoursIso(nowIso, deadlines.revoke_window_hours);
  await updateApplicationStatus(env, application.id, "approved", {
    effectiveAt: application.submitted_at,
    payload: { ...result, claim_id: claimId },
    revocableUntil,
  });

  const decomposition = decomposeApplication({
    hadPreviousClaim: Boolean(previousClaimId),
    addedPixels: result.added_pixels ?? 0,
    removedPixels: result.removed_pixels ?? 0,
  });

  await writeAuditLog(env, {
    actor: "bot",
    action: "kaihatsu_set_approved_final",
    target: String(claimId),
    detail: { mc_name: ownerName, area_blocks: result.area_blocks, decomposition, application_id: application.id },
  });

  if (result.mask_saved_path) {
    await enqueueJob(env, "dynmap_sync", {
      op: "upsert",
      mc_name: ownerName,
      mask_local_path: result.mask_saved_path,
      loc1: result.loc1 ?? { x: 0, y: 64, z: 0 },
      loc2: result.loc2 ?? { x: 0, y: 64, z: 0 },
    }).catch((e) => console.error("dynmap_sync enqueue failed", e));
  }

  const channels = await getChannels(env);
  if (channels.kaihatsu_ryo) {
    const { content, embed } = buildApprovedEmbed({
      mentionDiscordId: application.requester,
      mcName: ownerName,
      areaBlocks: result.area_blocks ?? 0,
      loc1: result.loc1 ?? { x: 0, y: 64, z: 0 },
      loc2: result.loc2 ?? { x: 0, y: 64, z: 0 },
      decomposition,
      addedPixels: result.added_pixels ?? 0,
      removedPixels: result.removed_pixels ?? 0,
      revokeWindowHours: deadlines.revoke_window_hours,
    });
    const filename = `claim_${claimId}.png`;
    const file = result.confirmation_image_base64
      ? { filename, bytes: base64ToBytes(result.confirmation_image_base64) }
      : undefined;
    if (file) embed.image = { url: `attachment://${filename}` };
    await sendChannelMessageWithFileAndComponents(
      env.DISCORD_BOT_TOKEN,
      channels.kaihatsu_ryo,
      content,
      buildRevokeButtonRow(application.id),
      file,
      [embed],
    ).catch((e) => console.error("kaihatsu final approved post failed", e));
  }

  await releaseHoldsForResolvedApplication(env, application.id, "approved", ownerName);
}

/** 正式承認の確定（delete系・グループ内のdelete／代表者による他者delete）。 */
export async function finalizeApprovedDelete(env: Env, application: ApplicationRow): Promise<void> {
  if (!application.target_claim_id) return;
  const claim = await getClaim(env, application.target_claim_id);
  await supersedeClaim(env, application.target_claim_id, "deleted");

  const deadlines = await getDeadlines(env);
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const revocableUntil = addHoursIso(nowIso, deadlines.revoke_window_hours);
  await updateApplicationStatus(env, application.id, "approved", { effectiveAt: application.submitted_at, revocableUntil });

  await writeAuditLog(env, {
    actor: "bot",
    action: "kaihatsu_delete_approved_final",
    target: String(application.target_claim_id),
    detail: { mc_name: application.owner_mc_name, application_id: application.id },
  });

  const ownerName = application.owner_mc_name ?? claim?.owner_mc_name ?? "";
  await enqueueJob(env, "dynmap_sync", { op: "remove", mc_name: ownerName }).catch((e) => console.error("dynmap_sync enqueue failed", e));

  const channels = await getChannels(env);
  if (channels.kaihatsu_ryo) {
    const { content, embed } = buildGroupDeleteConfirmedEmbed({ mentionDiscordId: application.requester, mcName: ownerName });
    await sendChannelMessage(env.DISCORD_BOT_TOKEN, channels.kaihatsu_ryo, content, [embed]).catch(() => {});
  }

  // グループのdeleteが確定＝土地の予約が正式に解消される。ここに保留していた第三者の届出は
  // §5.7.4最終段落のとおり、グループ自体の成否（呼び出し元のtryResolveGroupが判断）に従って
  // 別途 releaseHoldsForResolvedGroup が処理するため、ここでは個別のholdは扱わない。
}

/**
 * 保留の解放（§5.7.5）。outcome="approved" なら、保留中の届出は正式承認確定を理由に却下する。
 * outcome="released" なら、保留の原因が消滅（取り下げ・期限切れ・グループ却下）したため、
 * 届出時刻の一番古いものから順に再キュー（残りは新しい先頭に対して held を付け替えて待たせる）。
 */
export async function releaseHoldsForResolvedApplication(
  env: Env,
  applicationId: number,
  outcome: "approved" | "released",
  confirmedOwnerName?: string,
): Promise<void> {
  const held = await listHeldByApplication(env, applicationId);
  await releaseHeldQueue(env, held, outcome, confirmedOwnerName);
}

export async function releaseHoldsForResolvedGroup(
  env: Env,
  groupKey: string,
  outcome: "approved" | "released",
  confirmedOwnerName?: string,
): Promise<void> {
  const held = await listHeldByGroup(env, groupKey);
  await releaseHeldQueue(env, held, outcome, confirmedOwnerName);
}

async function releaseHeldQueue(
  env: Env,
  held: ApplicationRow[],
  outcome: "approved" | "released",
  confirmedOwnerName?: string,
): Promise<void> {
  if (held.length === 0) return;

  if (outcome === "approved") {
    for (const row of held) {
      await updateApplicationStatus(env, row.id, "rejected", {
        payload: { reasons: [`条件⑥不合格（${confirmedOwnerName ?? "他の参加者"}さんの個人開発領として正式承認が確定したため重複が確定しました）`] },
      });
      await clearHeldBlocking(env, row.id);
      const embed = buildHeldRejectedEmbed({ mcName: row.owner_mc_name ?? "", confirmedOwnerName: confirmedOwnerName ?? "不明" });
      await sendDirectMessage(env.DISCORD_BOT_TOKEN, row.submitted_by ?? row.requester, "", [embed]).catch(() => {});
    }
    return;
  }

  const first = held[0];
  if (!first) return;
  const rest = held.slice(1);
  await clearHeldBlocking(env, first.id);
  await updateApplicationStatus(env, first.id, "processing");
  await requeueSingleApplication(env, first);

  for (const row of rest) {
    await setHeldBlockingApplication(env, row.id, first.id);
  }
}

/**
 * 保留から解放された申請を、最新の重複候補プールで再評価するジョブとして積み直す（§5.7.5：自動再審査）。
 * 代表者一括申請由来（submitted_by が本人と異なる）の場合は、再評価後も本人確認を省略してはならない
 * ため、単独申請ではなく1名分のバッチジョブ（kaihatsu_set_batch）として積み直し、承認時は
 * markProvisional経由（DM確認）を再度経由させる。グループ由来のset側holdは発生しない設計
 * （jobs/completion.tsのコメント参照）のため、ここでは単独／非グループ一括申請のみを扱う。
 */
async function requeueSingleApplication(env: Env, application: ApplicationRow): Promise<void> {
  const original = safeJsonParse<{ attachments: Array<{ filename: string; url: string }>; mc_name: string; mc_uuid: string; previous_own_claim_id?: number | null }>(
    application.payload,
  );
  if (!original) {
    console.error("requeueSingleApplication: 元のpayloadを復元できません", application.id);
    return;
  }

  const excludeUuid = application.owner_mc_uuid ?? original.mc_uuid;
  const candidates = await buildOverlapCandidatePool(env, { excludeOwnerUuids: [excludeUuid] });
  const protectedAreas = await listProtectedAreas(env);
  const previousOwnClaim = original.previous_own_claim_id ? await getClaim(env, original.previous_own_claim_id) : null;
  const ownerName = application.owner_mc_name ?? original.mc_name;

  const existingClaimsPayload = candidates.map((c) => ({ claim_id: c.claim_id, owner_uuid: c.owner_uuid, owner_name: c.owner_name, mask_ref: c.mask_ref, bbox: c.bbox, kind: c.kind, ref_type: c.ref_type, ref_id: c.ref_id }));
  const protectedAreasPayload = protectedAreas
    .map((a) => ({ a, bbox: a.mask_ref ? worldBBoxFromLocJson(a.bbox_loc1, a.bbox_loc2) : null }))
    .filter((x): x is { a: (typeof protectedAreas)[number]; bbox: WorldBBox } => x.bbox !== null)
    .map(({ a, bbox }) => ({ id: a.id, name: a.name, mask_ref: a.mask_ref, bbox }));
  const previousOwnClaimPayload =
    previousOwnClaim && previousOwnClaim.mask_ref
      ? {
          claim_id: previousOwnClaim.id,
          owner_uuid: previousOwnClaim.owner_uuid,
          owner_name: ownerName,
          mask_ref: previousOwnClaim.mask_ref,
          bbox: worldBBoxFromLocJson(previousOwnClaim.bbox_loc1, previousOwnClaim.bbox_loc2),
        }
      : null;

  const isRepresentativeSubmission = Boolean(application.submitted_by && application.submitted_by !== application.requester);

  if (isRepresentativeSubmission) {
    await enqueueJob(env, "image_process", {
      subkind: "kaihatsu_set_batch",
      players: [{ player_name: ownerName, application_id: application.id, attachments: original.attachments, previous_own_claim: previousOwnClaimPayload }],
      existing_claims: existingClaimsPayload,
      protected_areas: protectedAreasPayload,
    });
    return;
  }

  await enqueueJob(env, "image_process", {
    subkind: "kaihatsu_set",
    application_id: application.id,
    requester_discord_id: application.requester,
    requester_mc_name: ownerName,
    requester_mc_uuid: excludeUuid,
    attachments: original.attachments,
    existing_claims: existingClaimsPayload,
    protected_areas: protectedAreasPayload,
    previous_own_claim: previousOwnClaimPayload,
  });
}

export { KAIHATSU_MESSAGES };
