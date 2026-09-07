// /kaihatsu list（既存の個人開発領の確認・§6.2）。可視化そのものは既存Dynmapに委ねる（決定#18）。

import type { Env } from "../env";
import { InteractionResponseType, type Interaction } from "../discord/types";
import { EPHEMERAL_FLAG } from "../discord/rest";
import { getByDiscordId } from "../accountLinks/repo";
import { getActiveClaimByOwnerUuid } from "./repo";
import { formatBlocks } from "./templates";
import type { DeferredResult } from "../accountLinks/authoriseCommand";

export async function handleKaihatsuList(env: Env, interaction: Interaction): Promise<DeferredResult> {
  const member = interaction.member;
  if (!member) return reply("このコマンドはサーバー内でのみ実行できます。");

  const link = await getByDiscordId(env, member.user.id);
  if (!link) return reply("Minecraftアカウントが紐づけられていません。/authorise で紐づけてください。");

  const claim = await getActiveClaimByOwnerUuid(env, link.minecraft_uuid);
  if (!claim) return reply(`${link.minecraft_name} さんの個人開発領は登録されていません。`);

  const loc1 = claim.bbox_loc1 ? (JSON.parse(claim.bbox_loc1) as { x: number; y: number; z: number }) : null;
  const loc2 = claim.bbox_loc2 ? (JSON.parse(claim.bbox_loc2) as { x: number; y: number; z: number }) : null;
  const lines = [
    `${link.minecraft_name} さんの個人開発領`,
    `面積：${formatBlocks(claim.area_blocks ?? 0)}ブロック`,
    loc1 && loc2 ? `座標：loc1(${loc1.x}, ${loc1.y}, ${loc1.z}) / loc2(${loc2.x}, ${loc2.y}, ${loc2.z})` : null,
    "詳細な形状はDynmapのオーバーレイでご確認ください。",
  ].filter(Boolean);

  return reply(lines.join("\n"));
}

function reply(content: string): DeferredResult {
  return {
    ack: { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content, flags: EPHEMERAL_FLAG } },
    followUp: async () => {},
  };
}
