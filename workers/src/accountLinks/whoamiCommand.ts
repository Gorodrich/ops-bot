// /whoami（自身の紐づけ状況の確認・ephemeral・§6.4.5：自分自身の紐づけのみ表示）

import type { Env } from "../env";
import { InteractionResponseType, type Interaction } from "../discord/types";
import { getByDiscordId } from "./repo";
import { EPHEMERAL_FLAG } from "../discord/rest";

export async function handleWhoami(env: Env, interaction: Interaction): Promise<{ ack: object }> {
  const member = interaction.member;
  if (!member) {
    return {
      ack: {
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "このコマンドはサーバー内でのみ実行できます。", flags: EPHEMERAL_FLAG },
      },
    };
  }

  const link = await getByDiscordId(env, member.user.id);
  const content = link
    ? `紐づけ済みのMinecraftアカウント：${link.minecraft_name}（UUID: ${link.minecraft_uuid}）`
    : "現在、Minecraftアカウントの紐づけはありません。/authorise で紐づけできます。";

  return {
    ack: { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content, flags: EPHEMERAL_FLAG } },
  };
}
