// /kaihatsu group_finalize（§5.7.4：同時処理グループの受付締切）。
// 締切前は本人確認の照会を開始しない（§5.7.4）。締切操作で初めてCT評価・本人確認DM送信を行う。

import type { Env } from "../env";
import { InteractionResponseType, type CommandOption, type Interaction, optionValue } from "../discord/types";
import { EPHEMERAL_FLAG, sendDirectMessageWithComponents, sendFollowupMessage } from "../discord/rest";
import { getDeadlines } from "../settings";
import { addHoursIso, orderGroupMembersForEvaluation, worldBBoxFromLocJson, type WorldBBox } from "./domain";
import { buildOverlapCandidatePool } from "./phase3";
import { buildConfirmWithdrawButtonRow, buildDeleteProvisionalConfirmEmbed, KAIHATSU_MESSAGES } from "./templates";
import {
  finalizeGroup,
  getClaim,
  getGroup,
  listApplicationsByGroup,
  listProtectedAreas,
  markDeleteMemberProvisional,
  resolveGroupStatus,
  updateApplicationStatus,
  type ApplicationRow,
} from "./repo";
import { enqueueJob } from "../jobs/queue";
import type { DeferredResult } from "../accountLinks/authoriseCommand";

function immediateReject(message: string): DeferredResult {
  return {
    ack: { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: message, flags: EPHEMERAL_FLAG } },
    followUp: async () => {},
  };
}

export async function handleKaihatsuGroupFinalize(env: Env, interaction: Interaction, options: CommandOption[]): Promise<DeferredResult> {
  const member = interaction.member;
  if (!member) return immediateReject("このコマンドはサーバー内でのみ実行できます。");

  const groupKey = optionValue(options, "group");
  if (!groupKey) return immediateReject("group オプションを指定してください。");

  const group = await getGroup(env, groupKey);
  if (!group) return immediateReject(KAIHATSU_MESSAGES.groupNotFound);
  if (group.status !== "collecting") return immediateReject(KAIHATSU_MESSAGES.groupAlreadyFinalized);
  if (group.representative_discord_id !== member.user.id) {
    return immediateReject("このグループを締め切れるのは、最初に届け出た代表者のみです。");
  }

  const members = await listApplicationsByGroup(env, groupKey);
  if (members.length === 0) return immediateReject(KAIHATSU_MESSAGES.groupEmpty);

  return {
    ack: { type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: EPHEMERAL_FLAG } },
    followUp: async () => {
      const content = await finalizeGroupAndDispatch(env, groupKey, members);
      await sendFollowupMessage(env.DISCORD_APP_ID, interaction.token, { content });
    },
  };
}

async function finalizeGroupAndDispatch(env: Env, groupKey: string, members: ApplicationRow[]): Promise<string> {
  const deleteMembers = members.filter((m) => m.op === "delete");
  const setMembers = members.filter((m) => m.op === "set");

  // delete対象の妥当性はここで機械的に一意に判定できる（§5.7.4：1人でも不合格ならグループ全体を却下）。
  for (const m of deleteMembers) {
    if (!m.target_claim_id) {
      return await rejectGroupAtFinalize(env, groupKey, members, `${m.owner_mc_name ?? m.requester}: 削除対象の個人開発領が指定されていません`);
    }
    const claim = await getClaim(env, m.target_claim_id);
    if (!claim || claim.status !== "active" || claim.owner_uuid !== m.owner_mc_uuid) {
      return await rejectGroupAtFinalize(env, groupKey, members, `${m.owner_mc_name ?? m.requester}: 削除対象の個人開発領が既に存在しないか、対象者と一致しません`);
    }
  }

  const deadlines = await getDeadlines(env);
  const deadlineIso = addHoursIso(new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), deadlines.provisional_confirm_hours);
  await finalizeGroup(env, groupKey, deadlineIso);

  const discordTs = `<t:${Math.floor(new Date(deadlineIso).getTime() / 1000)}:f>`;
  for (const m of deleteMembers) {
    await markDeleteMemberProvisional(env, m.id, deadlineIso);
    const deleteConfirmEmbed = buildDeleteProvisionalConfirmEmbed({
      mcName: m.owner_mc_name ?? "",
      representativeMention: `<@${m.submitted_by ?? m.requester}>`,
      confirmDeadlineDiscordTimestamp: discordTs,
    });
    await sendDirectMessageWithComponents(
      env.DISCORD_BOT_TOKEN,
      m.requester,
      "",
      buildConfirmWithdrawButtonRow(m.id),
      [deleteConfirmEmbed],
    ).catch((e) => console.error("group delete confirm DM failed", e));
  }

  if (setMembers.length > 0) {
    const excludeUuids = members.map((m) => m.owner_mc_uuid).filter((u): u is string => Boolean(u));
    const candidates = await buildOverlapCandidatePool(env, { excludeOwnerUuids: excludeUuids, excludeGroupKey: groupKey });
    const protectedAreas = await listProtectedAreas(env);

    const players = await Promise.all(
      setMembers.map(async (m) => {
        const original = JSON.parse(m.payload) as {
          attachments: Array<{ filename: string; url: string }>;
          mc_name: string;
          mc_uuid: string;
          previous_own_claim_id?: number | null;
        };
        const previousOwnClaim = original.previous_own_claim_id ? await getClaim(env, original.previous_own_claim_id) : null;
        return {
          player_name: original.mc_name,
          application_id: m.id,
          attachments: original.attachments,
          previous_own_claim:
            previousOwnClaim && previousOwnClaim.mask_ref
              ? {
                  claim_id: previousOwnClaim.id,
                  owner_uuid: previousOwnClaim.owner_uuid,
                  owner_name: original.mc_name,
                  mask_ref: previousOwnClaim.mask_ref,
                  bbox: worldBBoxFromLocJson(previousOwnClaim.bbox_loc1, previousOwnClaim.bbox_loc2),
                }
              : null,
        };
      }),
    );

    await enqueueJob(env, "image_process", {
      subkind: "kaihatsu_group",
      players,
      existing_claims: candidates.map((c) => ({ claim_id: c.claim_id, owner_uuid: c.owner_uuid, owner_name: c.owner_name, mask_ref: c.mask_ref, bbox: c.bbox, kind: c.kind, ref_type: c.ref_type, ref_id: c.ref_id })),
      protected_areas: protectedAreas
        .map((a) => ({ a, bbox: a.mask_ref ? worldBBoxFromLocJson(a.bbox_loc1, a.bbox_loc2) : null }))
        .filter((x): x is { a: (typeof protectedAreas)[number]; bbox: WorldBBox } => x.bbox !== null)
        .map(({ a, bbox }) => ({ id: a.id, name: a.name, mask_ref: a.mask_ref, bbox })),
    });
  }

  return KAIHATSU_MESSAGES.groupFinalized;
}

async function rejectGroupAtFinalize(env: Env, groupKey: string, members: ApplicationRow[], reason: string): Promise<string> {
  await resolveGroupStatus(env, groupKey, "rejected");
  for (const m of members) {
    await updateApplicationStatus(env, m.id, "rejected", { payload: { reasons: [reason] } });
  }
  return `グループを却下しました：${reason}`;
}
