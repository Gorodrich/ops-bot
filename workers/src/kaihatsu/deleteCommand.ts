// /kaihatsu delete（個人開発領の全部削除の届出・§5.7.1／§6.2）。
// 全部削除は機械的に一意に判定できる（画像判定不要）ため、Bot形式審査として即時処理する。
// 自分自身・groupなしの削除は即時確定（Phase 2互換）。他者を対象とする削除は必ずgroupを
// 伴わせ、対象者本人の72時間確認を要する同時処理グループのメンバーとして受け付ける（§5.7.4）。

import type { Env } from "../env";
import { InteractionResponseType, type CommandOption, type Interaction, optionValue } from "../discord/types";
import { EPHEMERAL_FLAG, sendChannelMessage, sendFollowupMessage } from "../discord/rest";
import { getByDiscordId, getByMcNameCaseInsensitive } from "../accountLinks/repo";
import { getChannels } from "../settings";
import { writeAuditLog } from "../auditLog";
import { enqueueJob } from "../jobs/queue";
import { getActiveClaimByOwnerUuid, getOrCreateGroup, hasOpenApplication, insertApplication, supersedeClaim, updateApplicationStatus } from "./repo";
import { KAIHATSU_MESSAGES, buildDeletedEmbed } from "./templates";
import type { DeferredResult } from "../accountLinks/authoriseCommand";

export async function handleKaihatsuDelete(env: Env, interaction: Interaction, options: CommandOption[]): Promise<DeferredResult> {
  const member = interaction.member;
  if (!member) return immediateReject("このコマンドはサーバー内でのみ実行できます。");

  const discordId = member.user.id;
  const link = await getByDiscordId(env, discordId);
  if (!link) return immediateReject(KAIHATSU_MESSAGES.needsAuthorise);

  const mcuser = optionValue(options, "mcuser");
  const groupKey = optionValue(options, "group");
  const isSelfTarget = !mcuser || mcuser.toLowerCase() === link.minecraft_name.toLowerCase();

  if (!isSelfTarget && !groupKey) {
    return immediateReject(KAIHATSU_MESSAGES.groupRequiresOtherPlayerDelete);
  }

  if (groupKey) {
    return {
      ack: { type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: EPHEMERAL_FLAG } },
      followUp: async () => {
        const content = await addDeleteToGroup(env, { representativeDiscordId: discordId, groupKey, targetMcName: isSelfTarget ? link.minecraft_name : (mcuser as string) });
        await sendFollowupMessage(env.DISCORD_APP_ID, interaction.token, { content });
      },
    };
  }

  // 自分自身・groupなし：Phase 2互換の即時確定。
  const claim = await getActiveClaimByOwnerUuid(env, link.minecraft_uuid);
  if (!claim) return immediateReject(KAIHATSU_MESSAGES.noActiveClaim);

  const applicationId = await insertApplication(env, {
    kind: "kaihatsu_delete",
    requester: discordId,
    status: "approved",
    payload: { mc_name: link.minecraft_name, mc_uuid: link.minecraft_uuid, claim_id: claim.id, area_blocks: claim.area_blocks },
    ownerMcUuid: link.minecraft_uuid,
    ownerMcName: link.minecraft_name,
    targetClaimId: claim.id,
    op: "delete",
  });
  await updateApplicationStatus(env, applicationId, "approved", { effectiveAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") });
  await supersedeClaim(env, claim.id, "deleted");
  await writeAuditLog(env, {
    actor: discordId,
    action: "kaihatsu_delete",
    target: String(claim.id),
    detail: { mc_name: link.minecraft_name, area_blocks: claim.area_blocks },
  });

  await enqueueJob(env, "dynmap_sync", { op: "remove", mc_name: link.minecraft_name }).catch(() => {});

  return {
    ack: {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "個人開発領を削除しました（復元はできません）。", flags: EPHEMERAL_FLAG },
    },
    followUp: async () => {
      const channels = await getChannels(env);
      const channelId = channels.kaihatsu_ryo;
      if (!channelId) return;
      const { content, embed } = buildDeletedEmbed({ mentionDiscordId: discordId, mcName: link.minecraft_name, areaBlocks: claim.area_blocks ?? 0 });
      await sendChannelMessage(env.DISCORD_BOT_TOKEN, channelId, content, [embed]).catch((e) => console.error("kaihatsu_delete: channel post failed", e));
    },
  };
}

async function addDeleteToGroup(env: Env, args: { representativeDiscordId: string; groupKey: string; targetMcName: string }): Promise<string> {
  const group = await getOrCreateGroup(env, args.groupKey, args.representativeDiscordId);
  if (group.status !== "collecting") return KAIHATSU_MESSAGES.groupAlreadyFinalized;

  const link = await getByMcNameCaseInsensitive(env, args.targetMcName);
  if (!link) return `${args.targetMcName}: Discordアカウントとの紐づけが未登録のため受け付けられません（条件⑦）。`;

  if (await hasOpenApplication(env, link.minecraft_uuid)) {
    return `${args.targetMcName}: ${KAIHATSU_MESSAGES.alreadyOpenElsewhere}`;
  }

  const claim = await getActiveClaimByOwnerUuid(env, link.minecraft_uuid);
  if (!claim) return `${args.targetMcName}: 削除対象の個人開発領が登録されていません。`;

  await insertApplication(env, {
    kind: "kaihatsu_delete",
    requester: link.discord_id,
    submittedBy: args.representativeDiscordId,
    status: "collecting",
    groupKey: args.groupKey,
    payload: { mc_name: link.minecraft_name, mc_uuid: link.minecraft_uuid, claim_id: claim.id, area_blocks: claim.area_blocks },
    ownerMcUuid: link.minecraft_uuid,
    ownerMcName: link.minecraft_name,
    targetClaimId: claim.id,
    op: "delete",
  });

  return KAIHATSU_MESSAGES.groupAccepted;
}

function immediateReject(message: string): DeferredResult {
  return {
    ack: { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: message, flags: EPHEMERAL_FLAG } },
    followUp: async () => {},
  };
}
