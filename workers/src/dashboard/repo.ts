// ダッシュボード固定メッセージの参照先（channel_id・message_id）の保存（§4.8）。

import type { Env } from "../env";

export interface DashboardMessageRow {
  kind: string;
  channel_id: string;
  message_id: string;
}

export async function getDashboardMessage(env: Env, kind: string): Promise<DashboardMessageRow | null> {
  return env.DB.prepare("SELECT kind, channel_id, message_id FROM dashboard_messages WHERE kind = ?").bind(kind).first<DashboardMessageRow>();
}

export async function deleteDashboardMessage(env: Env, kind: string): Promise<void> {
  await env.DB.prepare("DELETE FROM dashboard_messages WHERE kind = ?").bind(kind).run();
}

export async function upsertDashboardMessage(env: Env, kind: string, channelId: string, messageId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO dashboard_messages (kind, channel_id, message_id, updated_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT(kind) DO UPDATE SET channel_id = excluded.channel_id, message_id = excluded.message_id, updated_at = excluded.updated_at`,
  )
    .bind(kind, channelId, messageId)
    .run();
}
