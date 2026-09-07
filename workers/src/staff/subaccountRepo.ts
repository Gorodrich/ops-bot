// 運営サブ垢連携（staff_subaccounts）のD1アクセス。

import type { Env } from "../env";

export interface SubaccountLinkRow {
  sub_discord_id: string;
  main_discord_id: string;
  status: "pending" | "confirmed";
  requested_at: string;
  expires_at: string;
  confirmed_at: string | null;
  created_by: string;
  updated_at: string;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function getSubaccountLink(env: Env, subDiscordId: string): Promise<SubaccountLinkRow | null> {
  return env.DB.prepare("SELECT * FROM staff_subaccounts WHERE sub_discord_id = ?").bind(subDiscordId).first<SubaccountLinkRow>();
}

export async function listSubaccountLinksByMain(env: Env, mainDiscordId: string): Promise<SubaccountLinkRow[]> {
  const res = await env.DB.prepare("SELECT * FROM staff_subaccounts WHERE main_discord_id = ? ORDER BY updated_at DESC")
    .bind(mainDiscordId)
    .all<SubaccountLinkRow>();
  return res.results ?? [];
}

/** 本人確認DM送信時にpending状態で登録・再送信時は既存行を上書きする（sub_discord_idが主キー）。 */
export async function upsertPendingLink(
  env: Env,
  args: { subDiscordId: string; mainDiscordId: string; expiresAt: string; createdBy: string },
): Promise<void> {
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO staff_subaccounts (sub_discord_id, main_discord_id, status, requested_at, expires_at, confirmed_at, created_by, updated_at)
     VALUES (?, ?, 'pending', ?, ?, NULL, ?, ?)
     ON CONFLICT(sub_discord_id) DO UPDATE SET
       main_discord_id = excluded.main_discord_id,
       status = 'pending',
       requested_at = excluded.requested_at,
       expires_at = excluded.expires_at,
       confirmed_at = NULL,
       created_by = excluded.created_by,
       updated_at = excluded.updated_at`,
  )
    .bind(args.subDiscordId, args.mainDiscordId, now, args.expiresAt, args.createdBy, now)
    .run();
}

export async function confirmLink(env: Env, subDiscordId: string): Promise<void> {
  const now = nowIso();
  await env.DB.prepare(
    `UPDATE staff_subaccounts SET status = 'confirmed', confirmed_at = ?, updated_at = ? WHERE sub_discord_id = ? AND status = 'pending'`,
  )
    .bind(now, now, subDiscordId)
    .run();
}

/** 指定したメイン垢が連携したサブ垢のみ解除できる（status問わず）。削除できた場合 true。 */
export async function deleteSubaccountLink(env: Env, subDiscordId: string, mainDiscordId: string): Promise<boolean> {
  const res = await env.DB.prepare("DELETE FROM staff_subaccounts WHERE sub_discord_id = ? AND main_discord_id = ?")
    .bind(subDiscordId, mainDiscordId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** サブ垢に連携済みのメイン垢discord_idを返す（confirmed状態のみ・実行資格解決用）。 */
export async function getConfirmedMainId(env: Env, subDiscordId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT main_discord_id FROM staff_subaccounts WHERE sub_discord_id = ? AND status = 'confirmed'")
    .bind(subDiscordId)
    .first<{ main_discord_id: string }>();
  return row?.main_discord_id ?? null;
}
