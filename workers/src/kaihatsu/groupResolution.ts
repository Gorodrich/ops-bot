// 同時処理グループの状態遷移（§5.7.4）。原子性の判定（全員confirmed→approved、
// 1人でもrejected/withdrawn/expired→rejected）は kaihatsu/domain.ts の resolveGroup（純粋関数）が
// 担い、ここではD1の読み書き・通知・Dynmap反映・保留解放までの副作用をまとめる。
//
// 設計上の単純化（jobs/completion.tsのコメントも参照）：グループのset側メンバーがCT評価で
// "held"（§5.7.5の保留）になった場合、仕様はグループとの相互作用を明記していないため、
// 安全側（土地の二重割当を絶対に起こさない）に倒し、グループ全体を却下する。held単体の
// 場合と異なり再審査待ちにはしない。

import type { Env } from "../env";
import { getChannels, getDeadlines } from "../settings";
import { sendChannelMessage, sendDirectMessage, sendDirectMessageWithComponents } from "../discord/rest";
import { writeAuditLog } from "../auditLog";
import { addHoursIso, resolveGroup, orderGroupMembersForEvaluation, type GroupMemberStatus } from "./domain";
import { listApplicationsByGroup, resolveGroupStatus, type ApplicationGroupRow, type ApplicationRow } from "./repo";
import { finalizeApprovedDelete, finalizeApprovedSet, releaseHoldsForResolvedApplication, releaseHoldsForResolvedGroup } from "./phase3";
import {
  buildGroupMemberAddedNoticeEmbed,
  buildGroupRejectedEmbed,
  buildProvisionalWithdrawnOrExpiredEmbed,
  buildWithdrawOnlyButtonRow,
} from "./templates";

function safeJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function toGroupMemberStatus(row: ApplicationRow): GroupMemberStatus {
  if (row.status === "collecting" || row.status === "provisional" || row.status === "confirmed" || row.status === "rejected" || row.status === "withdrawn" || row.status === "expired") {
    return row.status;
  }
  // approved/failed/held等はここでは想定しない（グループ内のset側holdは即rejectedへ倒す設計・上記コメント）。
  return "rejected";
}

/** グループの現状を見て、成立・却下が確定していれば確定処理まで行う。まだなら何もしない。 */
export async function tryResolveGroup(env: Env, groupKey: string): Promise<void> {
  const members = await listApplicationsByGroup(env, groupKey);
  if (members.length === 0) return;

  const resolution = resolveGroup(members.map((m) => ({ status: toGroupMemberStatus(m) })));
  if (resolution === "waiting") return;

  if (resolution === "rejected") {
    await rejectGroup(env, groupKey, members);
    return;
  }

  await approveGroup(env, groupKey, members);
}

async function rejectGroup(env: Env, groupKey: string, members: ApplicationRow[]): Promise<void> {
  // 同時に複数のメンバー操作から呼ばれても、確定処理は1回だけ行う。
  if (!(await resolveGroupStatus(env, groupKey, "rejected"))) return;

  const reasons: string[] = [];
  for (const m of members) {
    if (m.status === "rejected") {
      const payload = safeJsonParse<{ reasons?: string[] }>(m.payload);
      reasons.push(...(payload?.reasons ?? [`${m.owner_mc_name ?? m.requester}: 却下`]));
    } else if (m.status === "withdrawn" || m.status === "expired") {
      reasons.push(`${m.owner_mc_name ?? m.requester}: ${m.status === "withdrawn" ? "本人が取り下げました" : "本人確認期限切れ"}`);
    }
  }

  // まだ結論の出ていない（collecting/provisional/confirmed）メンバーもグループ却下に巻き込む。
  // collecting を残すと、受付中のまま却下されたグループの届出が対象者の新たな届出を塞ぎ続けるため含める。
  for (const m of members) {
    if (m.status === "collecting" || m.status === "provisional" || m.status === "confirmed") {
      await env.DB.prepare("UPDATE applications SET status = 'rejected' WHERE id = ?").bind(m.id).run();
      const embed = buildProvisionalWithdrawnOrExpiredEmbed({
        mentionDiscordId: m.requester,
        mcName: m.owner_mc_name ?? "",
        representativeMention: `<@${m.submitted_by ?? m.requester}>`,
        reason: "withdrawn",
        groupRejectedNote: true,
      });
      await sendDirectMessage(env.DISCORD_BOT_TOKEN, m.requester, "", [embed]).catch(() => {});
    }
  }

  await writeAuditLog(env, { actor: "bot", action: "kaihatsu_group_rejected", target: groupKey, detail: { reasons } });

  const channels = await getChannels(env);
  const representative = members[0]?.submitted_by ?? members[0]?.requester;
  if (channels.kaihatsu_ryo && representative) {
    const { content, embed } = buildGroupRejectedEmbed({ representativeMention: `<@${representative}>`, reasons });
    await sendChannelMessage(env.DISCORD_BOT_TOKEN, channels.kaihatsu_ryo, content, [embed]).catch(() => {});
  }

  // 仮承認中のset側メンバーは、他者の届出から application 単位（held_blocking_application_id）で
  // 保留の原因として参照されうる（phase3.ts の重複候補プール）。グループ単位の解放だけでは
  // それらが held のまま残るため、メンバーごとにも解放する（監査指摘・2026-10-07）。
  for (const m of members) {
    if (m.op === "set") await releaseHoldsForResolvedApplication(env, m.id, "released");
  }
  await releaseHoldsForResolvedGroup(env, groupKey, "released");
}

async function approveGroup(env: Env, groupKey: string, members: ApplicationRow[]): Promise<void> {
  // 同時に複数のメンバーの確認から呼ばれても、claim登録を伴う確定処理は1回だけ行う。
  if (!(await resolveGroupStatus(env, groupKey, "approved"))) return;

  const ordered = orderGroupMembersForEvaluation(members.map((m) => ({ op: m.op, row: m })));
  for (const { row, op } of ordered) {
    if (op === "delete") {
      await finalizeApprovedDelete(env, row);
    } else {
      const payload = safeJsonParse<{ ctResult: Parameters<typeof finalizeApprovedSet>[2]; previousClaimId: number | null }>(row.payload);
      if (payload?.ctResult) {
        await finalizeApprovedSet(env, row, payload.ctResult, payload.previousClaimId ?? null);
      }
    }
  }

  await writeAuditLog(env, { actor: "bot", action: "kaihatsu_group_approved", target: groupKey, detail: { member_count: members.length } });

  const lastOwnerName = members.find((m) => m.op === "set")?.owner_mc_name;
  await releaseHoldsForResolvedGroup(env, groupKey, "approved", lastOwnerName ?? undefined);
}

/**
 * 受付中グループの失効時刻（作成から本人確認期限と同じ時間）。
 * 受付中の届出は対象者の新たな届出を塞ぐため、代表者が締め切らないまま無期限に残さない（監査指摘・2026-10-07）。
 */
export async function collectingGroupExpiresAt(env: Env, group: Pick<ApplicationGroupRow, "created_at">): Promise<string> {
  const deadlines = await getDeadlines(env);
  return addHoursIso(group.created_at, deadlines.provisional_confirm_hours);
}

/** 他者が対象者を受付中グループへ追加したことを本人にDMで通知する（取り下げボタン付き）。本人自身の追加では送らない。 */
export async function notifyGroupMemberAddedByOther(
  env: Env,
  args: { applicationId: number; targetDiscordId: string; representativeDiscordId: string; mcName: string; op: "set" | "delete"; group: Pick<ApplicationGroupRow, "created_at"> },
): Promise<void> {
  if (args.targetDiscordId === args.representativeDiscordId) return;
  const expiresAt = await collectingGroupExpiresAt(env, args.group);
  const embed = buildGroupMemberAddedNoticeEmbed({
    mcName: args.mcName,
    representativeMention: `<@${args.representativeDiscordId}>`,
    op: args.op,
    expiresDiscordTimestamp: `<t:${Math.floor(new Date(expiresAt).getTime() / 1000)}:f>`,
  });
  await sendDirectMessageWithComponents(env.DISCORD_BOT_TOKEN, args.targetDiscordId, "", buildWithdrawOnlyButtonRow(args.applicationId), [embed]).catch((e) =>
    console.error("group member added notice DM failed", e),
  );
}
