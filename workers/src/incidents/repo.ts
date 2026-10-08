// 障害お知らせ（/shogai・decisions.md #66）の D1 アクセス。

import type { Env } from "../env";
import type { ReportKind } from "./domain";

export interface IncidentRow {
  id: number;
  subject: string;
  started_at: string;
  resolved_at: string | null;
  status: "open" | "resolved";
  minecraft_down: number;
  created_by: string;
  created_at: string;
}

/** 全般用お知らせの入力（incident_reports.announce の JSON）。null なら全般用お知らせを投稿しない。 */
export interface AnnounceInput {
  causeShort?: string | null;
  resumeEta?: string | null;
  worldDataSafe?: boolean;
  rollbackTo?: string | null;
}

export interface IncidentReportRow {
  id: number;
  incident_id: number | null;
  kind: ReportKind;
  status: "draft" | "posted";
  report_no: number | null;
  subject: string | null;
  event_at: string | null;
  headline: string;
  lead: string | null;
  impact: string | null;
  cause: string | null;
  eta: string | null;
  data_impact: string | null;
  timeline: string | null;
  prevention: string | null;
  compensation: string | null;
  next_notice: string | null;
  channel_id: string | null;
  message_id: string | null;
  created_by: string;
  created_at: string;
  posted_at: string | null;
  minecraft_down: number | null;
  announce: string | null;
  announce_message_id: string | null;
}

export async function getIncident(env: Env, id: number): Promise<IncidentRow | null> {
  return env.DB.prepare("SELECT * FROM incidents WHERE id = ?").bind(id).first<IncidentRow>();
}

export async function listOpenIncidents(env: Env): Promise<IncidentRow[]> {
  const res = await env.DB.prepare("SELECT * FROM incidents WHERE status = 'open' ORDER BY id DESC").all<IncidentRow>();
  return res.results ?? [];
}

/** 直近に投稿された報（続報・復旧報の入力欄の初期値に使う）。 */
export async function getLatestPostedReport(env: Env, incidentId: number): Promise<IncidentReportRow | null> {
  return env.DB.prepare(
    "SELECT * FROM incident_reports WHERE incident_id = ? AND status = 'posted' ORDER BY report_no DESC LIMIT 1",
  )
    .bind(incidentId)
    .first<IncidentReportRow>();
}

export async function nextReportNo(env: Env, incidentId: number): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COALESCE(MAX(report_no), 0) + 1 AS n FROM incident_reports WHERE incident_id = ? AND report_no IS NOT NULL",
  )
    .bind(incidentId)
    .first<{ n: number }>();
  return row?.n ?? 1;
}

export async function insertDraftReport(
  env: Env,
  args: {
    incidentId: number | null;
    kind: ReportKind;
    subject: string | null;
    eventAt: string | null;
    headline: string;
    nextNotice: string | null;
    compensation: string | null;
    minecraftDown: boolean | null;
    announce: AnnounceInput | null;
    createdBy: string;
  },
): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO incident_reports (incident_id, kind, subject, event_at, headline, next_notice, compensation, minecraft_down, announce, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      args.incidentId,
      args.kind,
      args.subject,
      args.eventAt,
      args.headline,
      args.nextNotice,
      args.compensation,
      args.minecraftDown === null ? null : args.minecraftDown ? 1 : 0,
      args.announce ? JSON.stringify(args.announce) : null,
      args.createdBy,
    )
    .run();
  return Number(res.meta.last_row_id);
}

export async function getReport(env: Env, id: number): Promise<IncidentReportRow | null> {
  return env.DB.prepare("SELECT * FROM incident_reports WHERE id = ?").bind(id).first<IncidentReportRow>();
}

/** モーダルで入力された長文項目を draft に書き込む。 */
export async function fillDraftReport(
  env: Env,
  id: number,
  f: { lead: string | null; impact: string; cause: string; eta: string | null; dataImpact: string; timeline: string | null; prevention: string | null },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE incident_reports SET lead = ?, impact = ?, cause = ?, eta = ?, data_impact = ?, timeline = ?, prevention = ?
     WHERE id = ? AND status = 'draft'`,
  )
    .bind(f.lead, f.impact, f.cause, f.eta, f.dataImpact, f.timeline, f.prevention, id)
    .run();
}

/** 第1報の投稿前に障害を作成する（投稿に失敗したら deleteIncident で取り消す）。 */
export async function insertIncident(
  env: Env,
  args: { subject: string; startedAt: string; minecraftDown: boolean; createdBy: string },
): Promise<number> {
  const res = await env.DB.prepare("INSERT INTO incidents (subject, started_at, minecraft_down, created_by) VALUES (?, ?, ?, ?)")
    .bind(args.subject, args.startedAt, args.minecraftDown ? 1 : 0, args.createdBy)
    .run();
  return Number(res.meta.last_row_id);
}

export async function deleteIncident(env: Env, id: number): Promise<void> {
  await env.DB.prepare("DELETE FROM incidents WHERE id = ? AND status = 'open'").bind(id).run();
}

/**
 * 投稿前に番号を確保する。同じ番号が既に使われていれば（同時投稿の競合）UNIQUE制約で失敗するため false を返す。
 * draft でなくなっていた場合（二重送信）も false。
 */
export async function reserveReportNo(env: Env, reportId: number, incidentId: number, reportNo: number): Promise<boolean> {
  try {
    const res = await env.DB.prepare(
      "UPDATE incident_reports SET incident_id = ?, report_no = ? WHERE id = ? AND status = 'draft' AND report_no IS NULL",
    )
      .bind(incidentId, reportNo, reportId)
      .run();
    return (res.meta.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

/** 投稿に失敗したときに番号の確保を取り消す（draft のまま残す）。 */
export async function releaseReportNo(env: Env, reportId: number, isFirst: boolean): Promise<void> {
  await env.DB.prepare(
    `UPDATE incident_reports SET report_no = NULL${isFirst ? ", incident_id = NULL" : ""} WHERE id = ? AND status = 'draft'`,
  )
    .bind(reportId)
    .run();
}

export async function markReportPosted(env: Env, reportId: number, args: { channelId: string; messageId: string; postedAt: string }): Promise<void> {
  await env.DB.prepare("UPDATE incident_reports SET status = 'posted', channel_id = ?, message_id = ?, posted_at = ? WHERE id = ?")
    .bind(args.channelId, args.messageId, args.postedAt, reportId)
    .run();
}

export async function setAnnounceMessageId(env: Env, reportId: number, messageId: string): Promise<void> {
  await env.DB.prepare("UPDATE incident_reports SET announce_message_id = ? WHERE id = ?").bind(messageId, reportId).run();
}

/** 復旧報の投稿前に障害を復旧済みにする。既に復旧済みなら false（二重の復旧報を防ぐ）。 */
export async function markIncidentResolved(env: Env, incidentId: number, resolvedAt: string): Promise<boolean> {
  const res = await env.DB.prepare("UPDATE incidents SET status = 'resolved', resolved_at = ? WHERE id = ? AND status = 'open'")
    .bind(resolvedAt, incidentId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function reopenIncident(env: Env, incidentId: number): Promise<void> {
  await env.DB.prepare("UPDATE incidents SET status = 'open', resolved_at = NULL WHERE id = ?").bind(incidentId).run();
}
