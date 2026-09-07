// staff テーブルの読み出し・割当アルゴリズム（§4.5）が必要とする統計値の算出。

import type { Env } from "../env";

export interface StaffRow {
  discord_id: string;
  display_name: string;
  active: number;
  tags: string; // JSON配列
  weak_tags: string; // JSON配列
  is_technician: number;
  discord_permission_tier: "admin" | "broad" | "standard";
  requires_cosign: number;
  max_concurrent: number;
  active_hours: string; // JSON配列
  response_pattern: string;
  nudge_style: string;
  on_leave_active: number;
  on_leave_until: string | null;
  notes: string | null;
}

export async function listStaff(env: Env): Promise<StaffRow[]> {
  const res = await env.DB.prepare("SELECT * FROM staff").all<StaffRow>();
  return res.results ?? [];
}

export async function getStaffById(env: Env, discordId: string): Promise<StaffRow | null> {
  return env.DB.prepare("SELECT * FROM staff WHERE discord_id = ?").bind(discordId).first<StaffRow>();
}

/** 現在の未完了負荷（§4.5：max_concurrentに対する充足率の算出に使う）。主担当分のみを数える。 */
export async function getCurrentLoad(env: Env, discordId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) as n FROM tasks WHERE assignee = ? AND status IN ('assigned','in_progress','on_hold','co_sign_pending')",
  )
    .bind(discordId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * 直近30日の完了率（§4.5）。分母＝直近30日にcompleted_atまたはdeclineが発生した件数（辞退分は分子に含めない）。
 * 実績が無い者を不当に減点しないよう、分母0の場合は中立値1.0を返す。
 */
export async function getRecentCompletionRate(env: Env, discordId: string): Promise<number> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const completed = await env.DB.prepare(
    "SELECT COUNT(*) as n FROM tasks WHERE assignee = ? AND status = 'done' AND completed_at >= ?",
  )
    .bind(discordId, since)
    .first<{ n: number }>();
  const declined = await env.DB.prepare(
    "SELECT COUNT(*) as n FROM audit_log WHERE actor = ? AND action = 'task_declined' AND created_at >= ?",
  )
    .bind(discordId, since)
    .first<{ n: number }>();
  const completedN = completed?.n ?? 0;
  const declinedN = declined?.n ?? 0;
  const denom = completedN + declinedN;
  if (denom === 0) return 1.0;
  return completedN / denom;
}

/**
 * 直近N件の割当履歴の担当者ID（新しい順）。連続割当バランサ（§4.5：直近N回連続で同一人物への
 * 割当が続いた場合、次点者へ強制的に回す）の判定に使う。
 */
export async function getRecentAssignees(env: Env, limit: number): Promise<string[]> {
  const res = await env.DB.prepare(
    "SELECT assignee FROM tasks WHERE assignee IS NOT NULL AND assigned_at IS NOT NULL ORDER BY assigned_at DESC LIMIT ?",
  )
    .bind(limit)
    .all<{ assignee: string }>();
  return (res.results ?? []).map((r) => r.assignee);
}
