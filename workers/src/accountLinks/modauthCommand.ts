// /modauth（運営者による紐づけ登録・変更・解除・§6.4.2）
// すべての実行を実行者名・対象・変更前後の値とともに監査ログへ記名で永久保存する。

import type { Env } from "../env";
import { InteractionResponseType, type Interaction, type CommandOption, findOption, optionValue } from "../discord/types";
import { getRoles, getGuildId } from "../settings";
import { resolveMinecraftProfile } from "../mojang";
import { decideModauth } from "./domain";
import { d1AccountLinkRepo, insertLink, reactivateLink, deactivateLink, getByDiscordId } from "./repo";
import { resolveUneiActor } from "../staff/subaccountEligibility";
import { enqueueWhitelistAdd, enqueueWhitelistRemove } from "./whitelist";
import { writeAuditLog } from "../auditLog";
import { getGuildMember } from "../discord/rest";
import { sendFollowupMessage, EPHEMERAL_FLAG } from "../discord/rest";
import type { DeferredResult } from "./authoriseCommand";

const CONFIRM_PREFIX = "modauth:confirm:";
const CANCEL_PREFIX = "modauth:cancel";

function immediate(content: string): DeferredResult {
  return {
    ack: { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content, flags: EPHEMERAL_FLAG } },
    followUp: async () => {},
  };
}

export async function handleModauth(env: Env, interaction: Interaction): Promise<DeferredResult> {
  const resolved = await resolveUneiActor(env, interaction.member);
  if (!resolved.ok) return immediate(resolved.message);
  const operatorId = resolved.actorId;

  // Discord APIの制約でサブコマンド化している（register-commands.mjs 参照）：
  // /modauth link discord:... mcuser:... と /modauth remove discord:... の2本立て。
  const top = interaction.data?.options;
  const removeSub = findOption(top, "remove");
  if (removeSub) {
    return handleRemove(env, interaction, operatorId, removeSub.options);
  }
  const linkSub = findOption(top, "link");
  if (!linkSub) {
    return immediate("link または remove サブコマンドを指定してください。");
  }

  const targetUserId = optionValue(linkSub.options, "discord");
  const mcUsername = optionValue(linkSub.options, "mcuser");
  if (!targetUserId || !mcUsername) {
    return immediate("discord・mcuser オプションが必要です。");
  }

  return {
    ack: { type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: EPHEMERAL_FLAG } },
    followUp: async () => {
      const result = await processModauth(env, operatorId, targetUserId, mcUsername, false);
      await sendFollowupMessage(env.DISCORD_APP_ID, interaction.token, result);
    },
  };
}

async function handleRemove(
  env: Env,
  interaction: Interaction,
  operatorId: string,
  options: CommandOption[] | undefined,
): Promise<DeferredResult> {
  const targetUserId = optionValue(options, "discord");
  if (!targetUserId) return immediate("discord オプションが必要です。");

  return {
    ack: { type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: EPHEMERAL_FLAG } },
    followUp: async () => {
      const link = await getByDiscordId(env, targetUserId);
      if (!link) {
        await sendFollowupMessage(env.DISCORD_APP_ID, interaction.token, {
          content: "対象者の有効な紐づけが見つかりませんでした。",
        });
        return;
      }
      await deactivateLink(env, link.minecraft_uuid);
      await enqueueWhitelistRemove(env, link.minecraft_name, link.minecraft_uuid).catch(() => {});
      await writeAuditLog(env, {
        actor: operatorId,
        action: "modauth_remove",
        target: link.minecraft_uuid,
        detail: { discord_id: targetUserId, mc_name: link.minecraft_name },
      });
      await sendFollowupMessage(env.DISCORD_APP_ID, interaction.token, {
        content: `<@${targetUserId}> の紐づけ（${link.minecraft_name}）を解除しました。ホワイトリストからの削除を行っています。`,
      });
    },
  };
}

interface ModauthResult {
  content: string;
  components?: unknown[];
}

async function processModauth(
  env: Env,
  operatorId: string,
  targetUserId: string,
  mcUsername: string,
  confirmedOverwrite: boolean,
): Promise<ModauthResult> {
  const [{ profile, timedOut }, roles, targetMember] = await Promise.all([
    resolveMinecraftProfile(env, mcUsername).catch((err) => {
      console.error("resolveMinecraftProfile failed", mcUsername, err);
      return { profile: null, timedOut: true };
    }),
    getRoles(env),
    getGuildId(env).then((gid) => getGuildMember(env.DISCORD_BOT_TOKEN, gid, targetUserId)).catch(() => null),
  ]);

  if (!targetMember) {
    return { content: "対象者がこのサーバーに見つかりませんでした。" };
  }
  if (timedOut) {
    return { content: "Minecraftアカウントの実在確認に時間がかかっています。しばらくしてからもう一度お試しください。" };
  }
  const targetEligibility = {
    hasHito: targetMember.roles.includes(roles.hito),
    hasKariSanka: targetMember.roles.includes(roles.kari_sanka),
  };

  const decision = await decideModauth(d1AccountLinkRepo(env), {
    targetDiscordId: targetUserId,
    mojangUuid: profile?.uuid ?? null,
    mojangName: profile?.name ?? mcUsername,
    targetEligibility,
    confirmedOverwrite,
  });

  if (decision.kind === "reject") {
    return { content: `紐づけを受け付けられませんでした：${decision.message}` };
  }

  if (decision.kind === "noop") {
    return { content: `<@${targetUserId}> は既に「${decision.name}」に紐づけ済みです（変更なし）。` };
  }

  if (decision.kind === "confirm_overwrite") {
    return {
      content:
        `<@${targetUserId}> は既に「${decision.targetPreviousLink.minecraft_name}」に紐づけ済みです。` +
        `「${decision.name}」へ上書きしますか？（旧アカウントはホワイトリストから削除されます）`,
      components: [
        {
          type: 1, // ACTION_ROW
          components: [
            {
              type: 2, // BUTTON
              style: 4, // DANGER
              label: "上書きする",
              custom_id: buildConfirmOverwriteCustomId(targetUserId, decision.uuid, decision.name),
            },
            { type: 2, style: 2, label: "キャンセル", custom_id: MODAUTH_CANCEL_CUSTOM_ID },
          ],
        },
      ],
    };
  }

  const before = confirmedOverwrite ? await getByDiscordId(env, targetUserId) : null;
  if (confirmedOverwrite && before) {
    await deactivateLink(env, before.minecraft_uuid);
    await enqueueWhitelistRemove(env, before.minecraft_name, before.minecraft_uuid).catch(() => {});
  }

  if (decision.kind === "reactivate") {
    await reactivateLink(env, {
      uuid: decision.uuid,
      name: decision.name,
      discordId: targetUserId,
      linkedBy: `modauth:${operatorId}`,
    });
  } else {
    await insertLink(env, {
      uuid: decision.uuid,
      name: decision.name,
      discordId: targetUserId,
      linkedBy: `modauth:${operatorId}`,
    });
  }
  await enqueueWhitelistAdd(env, decision.name, decision.uuid).catch(() => {});

  await writeAuditLog(env, {
    actor: operatorId,
    action: decision.kind === "reactivate" ? "modauth_reactivate" : "modauth_create",
    target: decision.uuid,
    detail: {
      discord_id: targetUserId,
      mc_name: decision.name,
      before: before ? { mc_name: before.minecraft_name, mc_uuid: before.minecraft_uuid } : null,
    },
  });

  return { content: `<@${targetUserId}> をMinecraftアカウント「${decision.name}」に紐づけました。` };
}

/** confirm_overwrite の確認ボタン（MESSAGE_COMPONENT）用ハンドラ。 */
export async function handleModauthComponent(env: Env, interaction: Interaction): Promise<DeferredResult> {
  const customId = interaction.data?.custom_id ?? "";
  const resolved = await resolveUneiActor(env, interaction.member);
  if (!resolved.ok) return immediate(resolved.message);

  if (customId === CANCEL_PREFIX) {
    return {
      ack: {
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: { content: "操作をキャンセルしました。", components: [] },
      },
      followUp: async () => {},
    };
  }

  if (!customId.startsWith(CONFIRM_PREFIX)) {
    return immediate("不明な操作です。");
  }
  const rest = customId.slice(CONFIRM_PREFIX.length);
  const [targetUserId, , ...nameParts] = rest.split(":");
  const mcName = nameParts.join(":");
  if (!targetUserId || !mcName) return immediate("不正なボタンデータです。");

  return {
    ack: {
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: { content: "上書き処理を実行しています…", components: [] },
    },
    followUp: async () => {
      const result = await processModauth(env, resolved.actorId, targetUserId, mcName, true);
      await sendFollowupMessage(env.DISCORD_APP_ID, interaction.token, result);
    },
  };
}

export function buildConfirmOverwriteCustomId(targetUserId: string, uuid: string, mcName: string): string {
  return `${CONFIRM_PREFIX}${targetUserId}:${uuid}:${mcName}`;
}
export const MODAUTH_CANCEL_CUSTOM_ID = CANCEL_PREFIX;
