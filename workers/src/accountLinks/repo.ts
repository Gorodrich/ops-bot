// account_links テーブルの D1 実装（§8：主キーはUUID）。

import type { Env } from "../env";
import type { AccountLinkRecord, AccountLinkRepo } from "./domain";

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function d1AccountLinkRepo(env: Env): AccountLinkRepo {
  return {
    async getByUuid(uuid: string) {
      const row = await env.DB.prepare("SELECT * FROM account_links WHERE minecraft_uuid = ?")
        .bind(uuid)
        .first<AccountLinkRecord>();
      return row ?? null;
    },
    async getActiveByDiscordId(discordId: string) {
      const row = await env.DB.prepare(
        "SELECT * FROM account_links WHERE discord_id = ? AND status = 'active'",
      )
        .bind(discordId)
        .first<AccountLinkRecord>();
      return row ?? null;
    },
  };
}

export async function insertLink(
  env: Env,
  args: { uuid: string; name: string; discordId: string; linkedBy: string },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO account_links (minecraft_uuid, minecraft_name, discord_id, status, linked_by, linked_at, deactivated_at)
     VALUES (?, ?, ?, 'active', ?, ?, NULL)`,
  )
    .bind(args.uuid, args.name, args.discordId, args.linkedBy, nowIso())
    .run();
}

export async function reactivateLink(
  env: Env,
  args: { uuid: string; name: string; discordId: string; linkedBy: string },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE account_links
     SET status = 'active', minecraft_name = ?, discord_id = ?, linked_by = ?, linked_at = ?, deactivated_at = NULL
     WHERE minecraft_uuid = ?`,
  )
    .bind(args.name, args.discordId, args.linkedBy, nowIso(), args.uuid)
    .run();
}

/** /modauth の上書き：対象者の現在のactiveリンクを非activate化し、新しいUUIDで作成/復元する。 */
export async function deactivateLink(env: Env, uuid: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE account_links SET status = 'inactive', deactivated_at = ? WHERE minecraft_uuid = ? AND status = 'active'`,
  )
    .bind(nowIso(), uuid)
    .run();
}

export async function getByDiscordId(env: Env, discordId: string): Promise<AccountLinkRecord | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM account_links WHERE discord_id = ? AND status = 'active'",
  )
    .bind(discordId)
    .first<AccountLinkRecord>();
  return row ?? null;
}

/** Minecraftユーザー名（大文字小文字を無視）から紐づけを引く（代表者一括申請・§5.7.3の条件⑦判定に使う）。 */
export async function getByMcNameCaseInsensitive(env: Env, mcName: string): Promise<AccountLinkRecord | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM account_links WHERE status = 'active' AND LOWER(minecraft_name) = LOWER(?)",
  )
    .bind(mcName)
    .first<AccountLinkRecord>();
  return row ?? null;
}
