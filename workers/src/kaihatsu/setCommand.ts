// /kaihatsu set（個人開発領の設定届出・宣言型・§5.7.1／§6.2）。
// 3つの経路を持つ：
//   1. 単独申請（自分の画像のみ）：Phase 2互換の即時確定（§5.7.2）。
//   2. 代表者一括申請（複数参加者の画像・groupなし）：仮承認＋72時間本人確認（§5.7.3）。
//   3. 同時処理グループ（group指定）：受付を蓄積するのみ。評価は /kaihatsu group_finalize で開始（§5.7.4）。

import type { Env } from "../env";
import { InteractionResponseType, type CommandOption, type Interaction, optionValue, resolvedAttachment } from "../discord/types";
import { sendFollowupMessage, EPHEMERAL_FLAG } from "../discord/rest";
import { getByDiscordId, getByMcNameCaseInsensitive } from "../accountLinks/repo";
import { enqueueJob } from "../jobs/queue";
import { getAttachmentZoneCountDefault } from "../settings";
import { bboxMayOverlap, playerNameFromFilename, unionZoneBBoxFromFilenames, worldBBoxFromLocJson, type WorldBBox } from "./domain";
import { buildOverlapCandidatePool } from "./phase3";
import {
  getActiveClaimByOwnerUuid,
  getClaim,
  getOrCreateGroup,
  hasOpenApplication,
  hasProcessingKaihatsuSet,
  insertApplication,
  listActiveClaimsExcludingOwner,
  listProtectedAreas,
  updateApplicationStatus,
  type ClaimWithOwner,
} from "./repo";
import { KAIHATSU_MESSAGES } from "./templates";
import type { DeferredResult } from "../accountLinks/authoriseCommand";

interface Attachment {
  filename: string;
  url: string;
}

export async function handleKaihatsuSet(env: Env, interaction: Interaction, options: CommandOption[]): Promise<DeferredResult> {
  const member = interaction.member;
  if (!member) return immediateReject("このコマンドはサーバー内でのみ実行できます。");

  const discordId = member.user.id;
  const maxN = await getAttachmentZoneCountDefault(env).catch(() => 16);
  const attachments: Attachment[] = [];
  for (let i = 1; i <= maxN; i++) {
    const att = resolvedAttachment(interaction, `image${i}`, options);
    if (att) attachments.push({ filename: att.filename, url: att.url });
  }
  if (attachments.length === 0) return immediateReject(KAIHATSU_MESSAGES.noAttachments);

  const link = await getByDiscordId(env, discordId);
  if (!link) return immediateReject(KAIHATSU_MESSAGES.needsAuthorise);

  const groupKey = optionValue(options, "group");

  // プレイヤーごとにグルーピング（§5.7.3：代表者一括申請の識別）。
  const byPlayer = new Map<string, Attachment[]>();
  for (const a of attachments) {
    const player = playerNameFromFilename(a.filename);
    const key = (player ?? "").toLowerCase();
    if (!byPlayer.has(key)) byPlayer.set(key, []);
    byPlayer.get(key)?.push(a);
  }
  const playerKeys = [...byPlayer.keys()].filter((k) => k.length > 0);

  if (groupKey) {
    return {
      ack: { type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: EPHEMERAL_FLAG } },
      followUp: async () => {
        const content = await addToGroup(env, { representativeDiscordId: discordId, groupKey, byPlayer });
        await sendFollowupMessage(env.DISCORD_APP_ID, interaction.token, { content });
      },
    };
  }

  const isSoleSelfSubmission = playerKeys.length === 1 && playerKeys[0] === link.minecraft_name.toLowerCase();

  if (isSoleSelfSubmission) {
    if (await hasProcessingKaihatsuSet(env, discordId)) {
      return immediateReject(KAIHATSU_MESSAGES.alreadyProcessing);
    }
    if (await hasOpenApplication(env, link.minecraft_uuid)) {
      return immediateReject(KAIHATSU_MESSAGES.alreadyOpenElsewhere);
    }
    return {
      ack: { type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: EPHEMERAL_FLAG } },
      followUp: async () => {
        const content = await startSingleKaihatsuSetJob(env, {
          discordId,
          mcName: link.minecraft_name,
          mcUuid: link.minecraft_uuid,
          attachments,
        });
        await sendFollowupMessage(env.DISCORD_APP_ID, interaction.token, { content });
      },
    };
  }

  // 代表者一括申請（§5.7.3）：複数参加者、または自分以外の1名分のみの提出。
  return {
    ack: { type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: EPHEMERAL_FLAG } },
    followUp: async () => {
      const content = await startBatchKaihatsuSetJob(env, { representativeDiscordId: discordId, byPlayer });
      await sendFollowupMessage(env.DISCORD_APP_ID, interaction.token, { content });
    },
  };
}

// ── 1. 単独申請（Phase 2互換・即時確定） ─────────────────────────────────

async function startSingleKaihatsuSetJob(
  env: Env,
  args: { discordId: string; mcName: string; mcUuid: string; attachments: Attachment[] },
): Promise<string> {
  const applicationId = await insertApplication(env, {
    kind: "kaihatsu_set",
    requester: args.discordId,
    status: "processing",
    payload: { attachments: args.attachments, mc_name: args.mcName, mc_uuid: args.mcUuid },
    ownerMcUuid: args.mcUuid,
    ownerMcName: args.mcName,
    op: "set",
  });

  try {
    const previousOwn = await getActiveClaimByOwnerUuid(env, args.mcUuid);
    const others = await listActiveClaimsExcludingOwner(env, args.mcUuid);
    const protectedAreas = await listProtectedAreas(env);

    const unionBBox = unionZoneBBoxFromFilenames(args.attachments.map((a) => a.filename));
    const candidateClaims = filterByUnionBBox(others, unionBBox);

    await enqueueJob(env, "image_process", {
      subkind: "kaihatsu_set",
      application_id: applicationId,
      requester_discord_id: args.discordId,
      requester_mc_name: args.mcName,
      requester_mc_uuid: args.mcUuid,
      attachments: args.attachments,
      existing_claims: candidateClaims
        .map((c) => ({ c, bbox: c.mask_ref ? worldBBoxFromLocJson(c.bbox_loc1, c.bbox_loc2) : null }))
        .filter((x): x is { c: ClaimWithOwner; bbox: WorldBBox } => x.bbox !== null)
        .map(({ c, bbox }) => ({ claim_id: c.id, owner_uuid: c.owner_uuid, owner_name: c.owner_name, mask_ref: c.mask_ref, bbox })),
      protected_areas: protectedAreas
        .map((a) => ({ a, bbox: a.mask_ref ? worldBBoxFromLocJson(a.bbox_loc1, a.bbox_loc2) : null }))
        .filter((x): x is { a: (typeof protectedAreas)[number]; bbox: WorldBBox } => x.bbox !== null)
        .map(({ a, bbox }) => ({ id: a.id, name: a.name, mask_ref: a.mask_ref, bbox })),
      previous_own_claim:
        previousOwn && previousOwn.mask_ref && worldBBoxFromLocJson(previousOwn.bbox_loc1, previousOwn.bbox_loc2)
          ? {
              claim_id: previousOwn.id,
              owner_uuid: previousOwn.owner_uuid,
              owner_name: args.mcName,
              mask_ref: previousOwn.mask_ref,
              bbox: worldBBoxFromLocJson(previousOwn.bbox_loc1, previousOwn.bbox_loc2),
            }
          : null,
    });

    return KAIHATSU_MESSAGES.accepted;
  } catch (err) {
    console.error("kaihatsu_set ジョブ投入に失敗", err);
    await updateApplicationStatus(env, applicationId, "failed").catch(() => {});
    return KAIHATSU_MESSAGES.processingFailed;
  }
}

function filterByUnionBBox(claims: ClaimWithOwner[], unionBBox: WorldBBox | null): ClaimWithOwner[] {
  if (!unionBBox) return claims;
  return claims.filter((c) => {
    const bbox = worldBBoxFromLocJson(c.bbox_loc1, c.bbox_loc2);
    return !bbox || bboxMayOverlap(bbox, unionBBox);
  });
}

// ── 2. 代表者一括申請（§5.7.3） ──────────────────────────────────────────

async function startBatchKaihatsuSetJob(
  env: Env,
  args: { representativeDiscordId: string; byPlayer: Map<string, Attachment[]> },
): Promise<string> {
  const resolvedPlayers: Array<{ playerName: string; uuid: string; discordId: string; attachments: Attachment[]; previousClaimId: number | null }> = [];
  const problems: string[] = [];

  for (const [, files] of args.byPlayer) {
    const displayName = playerNameFromFilename(files[0]?.filename ?? "") ?? "";
    if (!displayName) continue;
    const link = await getByMcNameCaseInsensitive(env, displayName);
    if (!link) {
      problems.push(`${displayName}: Discordアカウントとの紐づけが未登録のため受け付けられません（条件⑦）。`);
      continue;
    }
    if (await hasOpenApplication(env, link.minecraft_uuid)) {
      problems.push(`${displayName}: ${KAIHATSU_MESSAGES.alreadyOpenElsewhere}`);
      continue;
    }
    const previousOwn = await getActiveClaimByOwnerUuid(env, link.minecraft_uuid);
    resolvedPlayers.push({ playerName: link.minecraft_name, uuid: link.minecraft_uuid, discordId: link.discord_id, attachments: files, previousClaimId: previousOwn?.id ?? null });
  }

  if (resolvedPlayers.length === 0) {
    return ["受け付けられる参加者がいませんでした。", ...problems].join("\n");
  }

  const excludeUuids = resolvedPlayers.map((p) => p.uuid);
  const candidates = await buildOverlapCandidatePool(env, { excludeOwnerUuids: excludeUuids });
  const protectedAreas = await listProtectedAreas(env);

  const players = [];
  for (const p of resolvedPlayers) {
    const applicationId = await insertApplication(env, {
      kind: "kaihatsu_set",
      requester: p.discordId,
      submittedBy: args.representativeDiscordId,
      status: "processing",
      payload: { attachments: p.attachments, mc_name: p.playerName, mc_uuid: p.uuid, previous_own_claim_id: p.previousClaimId },
      ownerMcUuid: p.uuid,
      ownerMcName: p.playerName,
      op: "set",
    });
    players.push({
      player_name: p.playerName,
      application_id: applicationId,
      attachments: p.attachments,
      previous_own_claim: await loadPreviousOwnClaimDetail(env, p.previousClaimId, p.playerName),
    });
  }

  await enqueueJob(env, "image_process", {
    subkind: "kaihatsu_set_batch",
    players,
    existing_claims: candidates.map((c) => ({ claim_id: c.claim_id, owner_uuid: c.owner_uuid, owner_name: c.owner_name, mask_ref: c.mask_ref, bbox: c.bbox, kind: c.kind, ref_type: c.ref_type, ref_id: c.ref_id })),
    protected_areas: protectedAreas
      .map((a) => ({ a, bbox: a.mask_ref ? worldBBoxFromLocJson(a.bbox_loc1, a.bbox_loc2) : null }))
      .filter((x): x is { a: (typeof protectedAreas)[number]; bbox: WorldBBox } => x.bbox !== null)
      .map(({ a, bbox }) => ({ id: a.id, name: a.name, mask_ref: a.mask_ref, bbox })),
  });

  return [
    `受付しました（${resolvedPlayers.length}名分）。判定処理を開始します。仮承認となった参加者には本人確認のDMを送信します。`,
    ...problems,
  ].join("\n");
}

async function loadPreviousOwnClaimDetail(
  env: Env,
  claimId: number | null,
  ownerName: string,
): Promise<{ claim_id: number; owner_uuid: string; owner_name: string; mask_ref: string; bbox: WorldBBox | null } | null> {
  if (!claimId) return null;
  const row = await getClaim(env, claimId);
  if (!row || !row.mask_ref) return null;
  return { claim_id: row.id, owner_uuid: row.owner_uuid, owner_name: ownerName, mask_ref: row.mask_ref, bbox: worldBBoxFromLocJson(row.bbox_loc1, row.bbox_loc2) };
}

// ── 3. 同時処理グループ（§5.7.4）：受付を蓄積するのみ ────────────────────

async function addToGroup(
  env: Env,
  args: { representativeDiscordId: string; groupKey: string; byPlayer: Map<string, Attachment[]> },
): Promise<string> {
  const group = await getOrCreateGroup(env, args.groupKey, args.representativeDiscordId);
  if (group.status !== "collecting") {
    return KAIHATSU_MESSAGES.groupAlreadyFinalized;
  }

  const problems: string[] = [];
  let added = 0;
  for (const [, files] of args.byPlayer) {
    const displayName = playerNameFromFilename(files[0]?.filename ?? "") ?? "";
    if (!displayName) continue;
    const link = await getByMcNameCaseInsensitive(env, displayName);
    if (!link) {
      problems.push(`${displayName}: Discordアカウントとの紐づけが未登録のため受け付けられません（条件⑦）。`);
      continue;
    }
    if (await hasOpenApplication(env, link.minecraft_uuid)) {
      problems.push(`${displayName}: ${KAIHATSU_MESSAGES.alreadyOpenElsewhere}`);
      continue;
    }
    const previousOwn = await getActiveClaimByOwnerUuid(env, link.minecraft_uuid);
    await insertApplication(env, {
      kind: "kaihatsu_set",
      requester: link.discord_id,
      submittedBy: args.representativeDiscordId,
      status: "collecting",
      groupKey: args.groupKey,
      payload: { attachments: files, mc_name: link.minecraft_name, mc_uuid: link.minecraft_uuid, previous_own_claim_id: previousOwn?.id ?? null },
      ownerMcUuid: link.minecraft_uuid,
      ownerMcName: link.minecraft_name,
      op: "set",
    });
    added += 1;
  }

  return [KAIHATSU_MESSAGES.groupAccepted, added > 0 ? `（${added}名分を追加しました）` : null, ...problems].filter(Boolean).join("\n");
}

function immediateReject(message: string): DeferredResult {
  return {
    ack: { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: message, flags: EPHEMERAL_FLAG } },
    followUp: async () => {},
  };
}
