// tasks への読み書き（§4.3）。
// Phase 4：/task add/done/decline/hold の基本的な状態遷移。
// Phase 5：割当アルゴリズム（§4.5）・共同確認（§4.5.1）・期限管理（§4.6）・辞退時の自動再割当を追加。

import type { Env } from "../env";
import type { PermissionTier } from "./assignment";

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface TaskRow {
  id: number;
  type: string;
  title: string;
  summary: string | null;
  status: string;
  priority: string;
  assignee: string | null;
  co_signer: string | null;
  co_sign_status: string | null;
  requester: string | null;
  required_tags: string;
  requires_technician: number;
  required_permission_tier: string | null;
  is_controversial: number;
  estimated_load: number | null;
  due_at: string | null;
  deadline_source: string | null;
  resume_at: string | null;
  declined_by: string;
  nudge_count: number;
  last_nudged_at: string | null;
  escalation_level: number;
  completion_evidence: string | null;
  created_at: string;
  assigned_at: string | null;
  completed_at: string | null;
  notify_channel_id: string | null;
  notify_message_id: string | null;
  notify_last_status: string | null;
}

export interface InsertTaskArgs {
  title: string;
  summary: string | null;
  assignee: string | null;
  coSigner: string | null;
  priority: "high" | "medium" | "low";
  createdBy: string;
  requiredTags: string[];
  requiresTechnician: boolean;
  requiredPermissionTier: PermissionTier | null;
  isControversial: boolean;
  estimatedLoad: number | null;
  dueAt: string | null;
  deadlineSource: "rule" | "bot_default" | "manual" | null;
}

export async function insertManualTask(env: Env, args: InsertTaskArgs): Promise<number> {
  const status = args.assignee ? "assigned" : "unassigned";
  const res = await env.DB.prepare(
    `INSERT INTO tasks (
       type, title, summary, related_rule, status, priority, assignee, co_signer,
       requester, required_tags, requires_technician, required_permission_tier,
       is_controversial, estimated_load, due_at, deadline_source, created_at, assigned_at
     ) VALUES ('T-C', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      args.title,
      args.summary,
      status,
      args.priority,
      args.assignee,
      args.coSigner,
      args.createdBy,
      JSON.stringify(args.requiredTags),
      args.requiresTechnician ? 1 : 0,
      args.requiredPermissionTier,
      args.isControversial ? 1 : 0,
      args.estimatedLoad,
      args.dueAt,
      args.deadlineSource,
      nowIso(),
      args.assignee ? nowIso() : null,
    )
    .run();
  return Number(res.meta.last_row_id);
}

export interface InsertDetectedTaskArgs {
  type: "T-B" | "T-C";
  title: string;
  summary: string | null;
  sourceChannelId: string | null;
  sourceMessageUrl: string;
  relatedRule: string | null;
  requester: string | null;
  assignee: string | null;
  coSigner: string | null;
  priority: "high" | "medium" | "low";
  requiredTags: string[];
  isControversial: boolean;
  dueAt: string | null;
  deadlineSource: "bot_default" | null;
}

/**
 * LLM検出タスク（T-B・T-C）の実書き込み（Phase 7・§7.3）。
 * source_message_url のUNIQUE制約で冪等性を担保する（§9：同一メッセージから重複タスクを作らない）。
 * ジョブの再実行等で二重に呼ばれても、既存のタスクIDをそのまま返す。
 */
export async function insertDetectedTask(env: Env, args: InsertDetectedTaskArgs): Promise<number> {
  const status = args.assignee ? "assigned" : "unassigned";
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO tasks (
       type, title, summary, source_channel_id, source_message_url, related_rule, status, priority,
       assignee, co_signer, requester, required_tags, is_controversial, due_at, deadline_source,
       created_at, assigned_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      args.type,
      args.title,
      args.summary,
      args.sourceChannelId,
      args.sourceMessageUrl,
      args.relatedRule,
      status,
      args.priority,
      args.assignee,
      args.coSigner,
      args.requester,
      JSON.stringify(args.requiredTags),
      args.isControversial ? 1 : 0,
      args.dueAt,
      args.deadlineSource,
      nowIso(),
      args.assignee ? nowIso() : null,
    )
    .run();

  if (res.meta.changes) return Number(res.meta.last_row_id);

  const existing = await env.DB.prepare("SELECT id FROM tasks WHERE source_message_url = ?")
    .bind(args.sourceMessageUrl)
    .first<{ id: number }>();
  if (!existing) throw new Error(`insertDetectedTask: UNIQUE制約で失敗したが既存タスクが見つからない（${args.sourceMessageUrl}）`);
  return existing.id;
}

export async function getTask(env: Env, id: number): Promise<TaskRow | null> {
  return env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first<TaskRow>();
}

/** タスク起票通知（1タスク1メッセージ）の投稿先を初回登録する（`notify.ts`）。 */
export async function setTaskNotifyMessage(env: Env, id: number, channelId: string, messageId: string, status: string): Promise<void> {
  await env.DB.prepare("UPDATE tasks SET notify_channel_id = ?, notify_message_id = ?, notify_last_status = ? WHERE id = ?")
    .bind(channelId, messageId, status, id)
    .run();
}

/** 既存のタスク起票通知メッセージを編集した後、直近の表示状態を更新する（`notify.ts`）。 */
export async function updateTaskNotifyStatus(env: Env, id: number, status: string): Promise<void> {
  await env.DB.prepare("UPDATE tasks SET notify_last_status = ? WHERE id = ?").bind(status, id).run();
}

/** 割当（新規割当・辞退後の再割当・自動再割当のいずれでも使う共通処理）。 */
export async function assignTask(
  env: Env,
  id: number,
  args: { assignee: string; coSigner: string | null },
): Promise<void> {
  await env.DB.prepare(
    "UPDATE tasks SET status = 'assigned', assignee = ?, co_signer = ?, co_sign_status = NULL, assigned_at = ? WHERE id = ?",
  )
    .bind(args.assignee, args.coSigner, nowIso(), id)
    .run();
}

/** 全候補が除外された、またはスコア同点／閾値未満で自動確定できない場合（§4.5：手動対応が必要）。 */
export async function markUnassignedNeedsManualReview(env: Env, id: number): Promise<void> {
  await env.DB.prepare("UPDATE tasks SET status = 'unassigned', assignee = NULL, co_signer = NULL, co_sign_status = NULL, assigned_at = NULL WHERE id = ?")
    .bind(id)
    .run();
}

/**
 * 完了操作（§4.2・§4.5.1）。共同確認者が設定されているタスクは、主担当・共同確認者の双方が
 * 完了操作を行って初めて `done` になる（片方のみは `co_sign_pending`）。
 * 戻り値：このタスクが最終的に完了に至ったか。
 */
export async function recordCompletion(
  env: Env,
  task: TaskRow,
  actorId: string,
  evidence: string,
): Promise<{ fullyDone: boolean; role: "primary" | "co_signer" }> {
  const role: "primary" | "co_signer" = actorId === task.co_signer ? "co_signer" : "primary";
  const otherAlreadyDone =
    (role === "primary" && task.co_sign_status === "cosigner_done") ||
    (role === "co_signer" && task.co_sign_status === "primary_done");

  if (!task.co_signer || otherAlreadyDone) {
    const combinedEvidence = task.completion_evidence ? `${task.completion_evidence}\n【${role === "co_signer" ? "共同確認者" : "担当者"}】${evidence}` : evidence;
    await env.DB.prepare("UPDATE tasks SET status = 'done', completed_at = ?, completion_evidence = ?, co_sign_status = ? WHERE id = ?")
      .bind(nowIso(), combinedEvidence, task.co_signer ? "both_done" : null, task.id)
      .run();
    return { fullyDone: true, role };
  }

  const newStatus = role === "primary" ? "primary_done" : "cosigner_done";
  await env.DB.prepare("UPDATE tasks SET status = 'co_sign_pending', co_sign_status = ?, completion_evidence = ? WHERE id = ?")
    .bind(newStatus, evidence, task.id)
    .run();
  return { fullyDone: false, role };
}

/** 辞退：辞退者を除外リストに積んだ上で未割当に戻す（§4.2：即座に次順位の運営者へ再割当する前段）。 */
export async function declineTask(env: Env, id: number, declinedBy: string, declinedByHistory: string[]): Promise<void> {
  const updated = Array.from(new Set([...declinedByHistory, declinedBy]));
  await env.DB.prepare(
    "UPDATE tasks SET status = 'unassigned', assignee = NULL, co_signer = NULL, co_sign_status = NULL, assigned_at = NULL, declined_by = ? WHERE id = ?",
  )
    .bind(JSON.stringify(updated), id)
    .run();
}

/** 保留（§4.2：再開予定日必須。due_at＝本来の期限とは別にresume_atで管理する・Phase4の不具合修正）。 */
export async function holdTask(env: Env, id: number, resumeAtIso: string, reason: string | null): Promise<void> {
  await env.DB.prepare("UPDATE tasks SET status = 'on_hold', resume_at = ?, summary = COALESCE(summary, '') || ? WHERE id = ?")
    .bind(resumeAtIso, reason ? `\n【保留理由】${reason}` : "", id)
    .run();
}

/** 保留の自動復帰対象（§4.2：再開予定日到来分）。 */
export async function listHeldTasksPastResume(env: Env, nowIsoValue: string): Promise<TaskRow[]> {
  const res = await env.DB.prepare("SELECT * FROM tasks WHERE status = 'on_hold' AND resume_at IS NOT NULL AND resume_at <= ?")
    .bind(nowIsoValue)
    .all<TaskRow>();
  return res.results ?? [];
}

export async function resumeHeldTask(env: Env, id: number): Promise<void> {
  await env.DB.prepare("UPDATE tasks SET status = 'assigned', resume_at = NULL WHERE id = ?").bind(id).run();
}

/** 督促対象（§4.7：due_at経過中の未完了タスク）。 */
export async function listNudgeCandidates(env: Env, nowIsoValue: string): Promise<TaskRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM tasks WHERE status IN ('assigned','in_progress','co_sign_pending') AND due_at IS NOT NULL AND due_at <= ? AND assignee IS NOT NULL",
  )
    .bind(nowIsoValue)
    .all<TaskRow>();
  return res.results ?? [];
}

export async function recordNudge(env: Env, taskId: number, level: number, targetId: string | null): Promise<void> {
  await env.DB.prepare("INSERT INTO nudge_log (task_id, level, target_id, sent_at) VALUES (?, ?, ?, ?)")
    .bind(taskId, level, targetId, nowIso())
    .run();
  await env.DB.prepare("UPDATE tasks SET nudge_count = nudge_count + 1, last_nudged_at = ?, escalation_level = ? WHERE id = ?")
    .bind(nowIso(), level, taskId)
    .run();
}

/** Lv4自動再割当後、新担当者にゼロから督促サイクルを回すための状態リセット（§4.7）。 */
export async function resetEscalationAfterReassign(env: Env, id: number, newDueAt: string | null): Promise<void> {
  await env.DB.prepare(
    "UPDATE tasks SET escalation_level = 0, nudge_count = 0, last_nudged_at = NULL, due_at = COALESCE(?, due_at) WHERE id = ?",
  )
    .bind(newDueAt, id)
    .run();
}

export async function countNudgesToday(env: Env, taskId: number): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const row = await env.DB.prepare("SELECT COUNT(*) as n FROM nudge_log WHERE task_id = ? AND sent_at >= ?")
    .bind(taskId, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** ダッシュボード（§4.8）向け集計。 */
export async function listUnassignedTasks(env: Env): Promise<TaskRow[]> {
  const res = await env.DB.prepare("SELECT * FROM tasks WHERE status = 'unassigned' ORDER BY created_at ASC").all<TaskRow>();
  return res.results ?? [];
}

export async function listIncompleteTasksByAssignee(env: Env): Promise<TaskRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM tasks WHERE status IN ('assigned','in_progress','on_hold','co_sign_pending') AND assignee IS NOT NULL ORDER BY assignee, due_at",
  ).all<TaskRow>();
  return res.results ?? [];
}

export async function listOverdueTasks(env: Env, nowIsoValue: string): Promise<TaskRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM tasks WHERE status IN ('assigned','in_progress','on_hold','co_sign_pending') AND due_at IS NOT NULL AND due_at <= ? ORDER BY due_at ASC",
  )
    .bind(nowIsoValue)
    .all<TaskRow>();
  return res.results ?? [];
}

/** `/task list`向け：本人が担当または共同確認者になっている未完了タスク（§4.2・2026-09-06追加）。 */
export async function listOwnIncompleteTasks(env: Env, userId: string): Promise<TaskRow[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM tasks
     WHERE status IN ('assigned','in_progress','on_hold','co_sign_pending') AND (assignee = ? OR co_signer = ?)
     ORDER BY due_at IS NULL, due_at ASC`,
  )
    .bind(userId, userId)
    .all<TaskRow>();
  return res.results ?? [];
}

export async function countCompletedSince(env: Env, sinceIso: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) as n FROM tasks WHERE status = 'done' AND completed_at >= ?")
    .bind(sinceIso)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * `/task done`・`/task decline`・`/task hold` の task_id オプション（autocomplete）向け検索。
 * タスクIDは投稿本文でしか確認できず直接入力させるのは実用上困難なため、タイトルの部分一致で
 * 「タイトル（#id）」の形式から選べるようにする（2026-09-06追加）。
 * `assigneeId`指定時はその担当者のタスクのみに絞る（decline/hold＝担当者本人のみ実行可のため）。
 */
export async function searchTasksForAutocomplete(
  env: Env,
  args: { query: string; assigneeId?: string; excludeDone?: boolean; limit?: number },
): Promise<TaskRow[]> {
  const limit = args.limit ?? 25;
  const like = `%${args.query.replace(/[\\%_]/g, "\\$&")}%`;
  const conditions = ["title LIKE ? ESCAPE '\\'"];
  const binds: unknown[] = [like];
  if (args.assigneeId) {
    conditions.push("assignee = ?");
    binds.push(args.assigneeId);
  }
  if (args.excludeDone) {
    conditions.push("status != 'done'");
  }
  const res = await env.DB.prepare(
    `SELECT * FROM tasks WHERE ${conditions.join(" AND ")} ORDER BY id DESC LIMIT ?`,
  )
    .bind(...binds, limit)
    .all<TaskRow>();
  return res.results ?? [];
}
