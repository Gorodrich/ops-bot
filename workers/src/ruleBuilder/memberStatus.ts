// rule-builder のログイン判定（decisions.md #67）。
// 運営者かどうかの判定は OpsBot を正とし、rule-builder には Bot トークンやロール ID を持たせない。
// サブ垢の扱いは /コマンドの実行資格（resolveUneiActor）と同じにする：
//   「運営」ロールを直接持てば本人、「運営サブ垢」ロールだけなら連携済みのメイン垢として判定する。
// Discord API が失敗したとき（メイン垢の確認を除く）は例外を投げ、rule-builder 側でログインを断る。

import type { Env } from "../env";
import { getGuildMember, type DiscordGuildMember } from "../discord/rest";
import { getGuildId } from "../settings";
import { resolveUneiActor } from "../staff/subaccountEligibility";
import type { MemberStatus } from "./types";

const SNOWFLAKE = /^\d{17,20}$/;
const CDN = "https://cdn.discordapp.com";

export function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && SNOWFLAKE.test(value);
}

export function displayNameOf(member: DiscordGuildMember): string {
  return member.nick || member.user?.global_name || member.user?.username || "";
}

export function avatarUrlOf(member: DiscordGuildMember, guildId: string): string | null {
  const user = member.user;
  if (!user) return null;
  if (member.avatar) return `${CDN}/guilds/${guildId}/users/${user.id}/avatars/${member.avatar}.png?size=64`;
  if (user.avatar) return `${CDN}/avatars/${user.id}/${user.avatar}.png?size=64`;
  // 既定のアイコン（新しいユーザー名の方式：(ID >> 22) % 6）
  return `${CDN}/embed/avatars/${Number((BigInt(user.id) >> 22n) % 6n)}.png`;
}

async function isOnLeave(env: Env, discordId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT on_leave_active FROM staff WHERE discord_id = ?")
    .bind(discordId)
    .first<{ on_leave_active: number }>();
  return row?.on_leave_active === 1;
}

export async function getMemberStatus(env: Env, discordUserId: string): Promise<MemberStatus> {
  if (!isSnowflake(discordUserId)) throw new Error("Discord ユーザー ID の形式ではありません");

  const notUnei = (member: DiscordGuildMember | null, guildId: string): MemberStatus => ({
    isUnei: false,
    onLeave: false,
    userId: discordUserId,
    viaSubaccount: false,
    displayName: member ? displayNameOf(member) : "",
    avatarUrl: member ? avatarUrlOf(member, guildId) : null,
  });

  const guildId = await getGuildId(env);
  const member = await getGuildMember(env.DISCORD_BOT_TOKEN, guildId, discordUserId);
  if (!member) return notUnei(null, guildId);

  const resolved = await resolveUneiActor(env, {
    user: { id: discordUserId, username: member.user?.username ?? "" },
    roles: member.roles,
  });
  if (!resolved.ok) return notUnei(member, guildId);

  // サブ垢なら、表示名・アイコンもメイン垢のものにする（rule-builder 上ではメイン垢として扱う）
  const actor = resolved.viaSubaccount
    ? await getGuildMember(env.DISCORD_BOT_TOKEN, guildId, resolved.actorId)
    : member;
  if (!actor) return notUnei(member, guildId);

  return {
    isUnei: true,
    onLeave: await isOnLeave(env, resolved.actorId),
    userId: resolved.actorId,
    viaSubaccount: resolved.viaSubaccount,
    displayName: displayNameOf(actor),
    avatarUrl: avatarUrlOf(actor, guildId),
  };
}
