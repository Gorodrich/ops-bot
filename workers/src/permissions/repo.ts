// permission_requests / permissions への読み書き（§5.4・§5.4.1・§8：記名許可は永久保持）。

import type { Env } from "../env";

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface PermissionRequestRow {
  id: number;
  approval_key: string;
  subject: string;
  requester_id: string;
  required_count: number;
  status: "open" | "approved" | "withdrawn";
  description: string | null;
  image_url: string | null;
  channel_id: string | null;
  message_id: string | null;
  task_id: number | null;
  created_at: string;
  decided_at: string | null;
}

export async function insertPermissionRequest(
  env: Env,
  args: { approvalKey: string; subject: string; requesterId: string; requiredCount: number; description: string | null; imageUrl: string | null },
): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO permission_requests (approval_key, subject, requester_id, required_count, status, description, image_url, created_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`,
  )
    .bind(args.approvalKey, args.subject, args.requesterId, args.requiredCount, args.description, args.imageUrl, nowIso())
    .run();
  return Number(res.meta.last_row_id);
}

export async function setPermissionRequestMessage(env: Env, id: number, channelId: string, messageId: string): Promise<void> {
  await env.DB.prepare("UPDATE permission_requests SET channel_id = ?, message_id = ? WHERE id = ?").bind(channelId, messageId, id).run();
}

export async function setPermissionRequestTaskId(env: Env, id: number, taskId: number): Promise<void> {
  await env.DB.prepare("UPDATE permission_requests SET task_id = ? WHERE id = ?").bind(taskId, id).run();
}

export async function getPermissionRequest(env: Env, id: number): Promise<PermissionRequestRow | null> {
  return env.DB.prepare("SELECT * FROM permission_requests WHERE id = ?").bind(id).first<PermissionRequestRow>();
}

export async function markPermissionRequestDecided(env: Env, id: number, status: "approved" | "withdrawn"): Promise<void> {
  await env.DB.prepare("UPDATE permission_requests SET status = ?, decided_at = ? WHERE id = ?").bind(status, nowIso(), id).run();
}

/** ダッシュボード（§4.8：進行中の許可要請）向け。 */
export async function listOpenPermissionRequests(env: Env): Promise<PermissionRequestRow[]> {
  const res = await env.DB.prepare("SELECT * FROM permission_requests WHERE status = 'open' ORDER BY created_at ASC").all<PermissionRequestRow>();
  return res.results ?? [];
}

export interface SignatureRow {
  granter_id: string;
  decision: "ok" | "ng";
  decided_at: string;
}

/** 記名（一意制約 permission_request_id+granter_id・§9：二重の記名防止）。既存の記名があれば上書きを許す（撤回前の意思変更）。 */
export async function upsertSignature(env: Env, requestId: number, granterId: string, decision: "ok" | "ng", reason: string | null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO permissions (subject, granter_id, decision, reason, decided_at, context, permission_request_id)
     VALUES ((SELECT subject FROM permission_requests WHERE id = ?), ?, ?, ?, ?, ?, ?)
     ON CONFLICT(permission_request_id, granter_id) DO UPDATE SET decision = excluded.decision, reason = excluded.reason, decided_at = excluded.decided_at`,
  )
    .bind(requestId, granterId, decision, reason, nowIso(), JSON.stringify({ permission_request_id: requestId }), requestId)
    .run();
}

export async function listSignatures(env: Env, requestId: number): Promise<SignatureRow[]> {
  const res = await env.DB.prepare(
    "SELECT granter_id, decision, decided_at FROM permissions WHERE permission_request_id = ? ORDER BY decided_at ASC",
  )
    .bind(requestId)
    .all<SignatureRow>();
  return res.results ?? [];
}
