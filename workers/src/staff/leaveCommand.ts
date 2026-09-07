// /staff leave（休暇の登録・解除・基本ルール第14条）。
// on_leave はD1 staffテーブルのon_leave_active/on_leave_untilで管理し、投票・記名許可の
// 母数計算（§5.1・§5.2・§5.3）から本人を除外する判定にそのまま使われる。

import type { Env } from "../env";
import { type CommandOption, type Interaction, InteractionResponseType, optionValue } from "../discord/types";
import { getGuildId } from "../settings";
import { EPHEMERAL_FLAG, getGuildMember } from "../discord/rest";
import { writeAuditLog } from "../auditLog";
import { resolveUneiActor } from "./subaccountEligibility";
import type { DeferredResult } from "../accountLinks/authoriseCommand";

function immediate(content: string): DeferredResult {
  return {
    ack: { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content, flags: EPHEMERAL_FLAG } },
    followUp: async () => {},
  };
}

const RESUME_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function handleStaffLeave(env: Env, interaction: Interaction, options: CommandOption[]): Promise<DeferredResult> {
  const resolved = await resolveUneiActor(env, interaction.member);
  if (!resolved.ok) return immediate(resolved.message);

  const action = optionValue(options, "action");
  if (action !== "start" && action !== "end") return immediate("action は start または end のいずれかです。");

  const discordId = resolved.actorId;
  // サブ垢経由の場合はメイン垢の表示名をstaffテーブルに反映する（休暇はメイン垢の状態として扱うため）。
  const displayName = resolved.viaSubaccount
    ? await getGuildMember(env.DISCORD_BOT_TOKEN, await getGuildId(env), discordId).then((m) => m?.user?.username ?? discordId).catch(() => discordId)
    : interaction.member!.user.username;

  if (action === "end") {
    await env.DB.prepare(
      `INSERT INTO staff (discord_id, display_name, on_leave_active, on_leave_until, updated_at)
       VALUES (?, ?, 0, NULL, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
       ON CONFLICT(discord_id) DO UPDATE SET on_leave_active = 0, on_leave_until = NULL, updated_at = excluded.updated_at`,
    )
      .bind(discordId, displayName)
      .run();
    await writeAuditLog(env, { actor: discordId, action: "staff_leave_ended", target: discordId });
    return immediate("休暇を解除しました。投票・記名許可の母数に復帰します。");
  }

  const until = optionValue(options, "until");
  if (!until || !RESUME_DATE_PATTERN.test(until) || Number.isNaN(Date.parse(`${until}T00:00:00Z`))) {
    return immediate("休暇の登録には until オプション（YYYY-MM-DD形式の復帰予定日）が必要です。");
  }
  const untilIso = `${until}T00:00:00Z`;

  await env.DB.prepare(
    `INSERT INTO staff (discord_id, display_name, on_leave_active, on_leave_until, updated_at)
     VALUES (?, ?, 1, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT(discord_id) DO UPDATE SET on_leave_active = 1, on_leave_until = excluded.on_leave_until, updated_at = excluded.updated_at`,
  )
    .bind(discordId, displayName, untilIso)
    .run();
  await writeAuditLog(env, { actor: discordId, action: "staff_leave_started", target: discordId, detail: { until } });
  return immediate(`休暇を登録しました（復帰予定：${until}）。それまでの間、投票・記名許可の母数から除外されます（基本ルール第14条第2項）。`);
}
