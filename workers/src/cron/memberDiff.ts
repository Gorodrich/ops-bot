// 脱退・資格喪失時の自動削除（§6.4.3）。
// Cron Trigger（既定1時間ごと）でギルドメンバー一覧を取得し、紐づけ済みユーザーと突き合わせる。
// GUILD_MEMBERS特権インテントが必要（Phase 0 B-4 で有効化済み）。

import type { Env } from "../env";
import { listAllGuildMembers, sendChannelMessage } from "../discord/rest";
import { getRoles, getChannels, getGuildId } from "../settings";
import { deactivateLink } from "../accountLinks/repo";
import { enqueueWhitelistRemove } from "../accountLinks/whitelist";
import { writeAuditLog } from "../auditLog";

interface ActiveLinkRow {
  minecraft_uuid: string;
  minecraft_name: string;
  discord_id: string;
}

export async function runMemberDiff(env: Env): Promise<void> {
  const [roles, channels, guildId] = await Promise.all([getRoles(env), getChannels(env), getGuildId(env)]);
  if (!guildId) return; // 未セットアップ（#4未確定のプレースホルダのまま）は何もしない

  const members = await listAllGuildMembers(env.DISCORD_BOT_TOKEN, guildId);
  const memberById = new Map(members.map((m) => [m.id, m]));

  const active = await env.DB.prepare(
    "SELECT minecraft_uuid, minecraft_name, discord_id FROM account_links WHERE status = 'active'",
  ).all<ActiveLinkRow>();

  for (const link of active.results ?? []) {
    const member = memberById.get(link.discord_id);
    const left = !member;
    const lostRole = !left && !member!.roles.includes(roles.hito) && !member!.roles.includes(roles.kari_sanka);

    if (!left && !lostRole) continue;

    await deactivateLink(env, link.minecraft_uuid);
    await enqueueWhitelistRemove(env, link.minecraft_name, link.minecraft_uuid).catch(() => {});
    await writeAuditLog(env, {
      actor: "system",
      action: left ? "member_left_auto_deactivate" : "member_role_lost_auto_deactivate",
      target: link.minecraft_uuid,
      detail: { discord_id: link.discord_id, mc_name: link.minecraft_name },
    });

    if (channels.unei_only) {
      const reason = left ? "ギルドから脱退" : "人民・仮参加者ロールを喪失";
      await sendChannelMessage(
        env.DISCORD_BOT_TOKEN,
        channels.unei_only,
        `【紐づけ自動削除】<@${link.discord_id}>（${link.minecraft_name}）：${reason}のため紐づけを解除し、ホワイトリスト削除を行いました。` +
          `個人開発領は自動削除していません（本人の届出が前提のため）。扱いは運営の判断に委ねます。`,
      ).catch(() => {});
    }
  }
}
