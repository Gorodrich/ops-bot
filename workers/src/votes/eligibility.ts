// 母数の算出（§5.1）：staff.yamlではなくDiscordの実際の「運営」ロール保有状況をその都度取得し、
// 休暇中（on_leave.active）の除外判定のみD1 staffテーブルを参照する。

import type { Env } from "../env";
import { listAllGuildMembers } from "../discord/rest";
import { getGuildId, getRoles } from "../settings";
import { computeEligibleVoters } from "./domain";

export async function currentUneiMemberIds(env: Env): Promise<string[]> {
  const [guildId, roles] = await Promise.all([getGuildId(env), getRoles(env)]);
  const members = await listAllGuildMembers(env.DISCORD_BOT_TOKEN, guildId);
  return members.filter((m) => m.roles.includes(roles.unei)).map((m) => m.id);
}

async function onLeaveStaffIds(env: Env): Promise<Set<string>> {
  const res = await env.DB.prepare("SELECT discord_id FROM staff WHERE on_leave_active = 1").all<{ discord_id: string }>();
  return new Set((res.results ?? []).map((r) => r.discord_id));
}

/** 現時点の投票母数（休暇者・exclude_self対象を除く・§5.1／§5.5）を計算する。 */
export async function computeCurrentEligibleVoters(env: Env, excludeTarget?: string | null): Promise<string[]> {
  const [uneiMemberIds, onLeaveIds] = await Promise.all([currentUneiMemberIds(env), onLeaveStaffIds(env)]);
  return computeEligibleVoters({ uneiMemberIds, onLeaveIds, excludeTarget });
}

/**
 * 参加者投票（/vote）の母数：「人民」ロール（settings.roles.hito）保有者。
 * 休暇制度は運営者のみに適用されるため除外判定は行わない（本人除外の対象もない・2026-09-06決定）。
 */
export async function currentParticipantMemberIds(env: Env): Promise<string[]> {
  const [guildId, roles] = await Promise.all([getGuildId(env), getRoles(env)]);
  const members = await listAllGuildMembers(env.DISCORD_BOT_TOKEN, guildId);
  return members.filter((m) => m.roles.includes(roles.hito)).map((m) => m.id);
}

export async function computeCurrentParticipantEligibleVoters(env: Env): Promise<string[]> {
  const memberIds = await currentParticipantMemberIds(env);
  return computeEligibleVoters({ uneiMemberIds: memberIds, onLeaveIds: new Set() });
}
