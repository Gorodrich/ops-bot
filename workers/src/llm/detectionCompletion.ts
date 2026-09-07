// CT102からの claude_code ジョブ完了報告の処理（§7.3・§7.4・migrations/0009・0010）。
//
// 2つのsubkindを扱う：
//   detect_tasks         … §7.3の出力（tasksスキーマ）を受け取り、llm_shadow_detectionsへ記録し、
//                           §4.5の割当アルゴリズムを実行する。
//   assignment_tiebreak  … §4.5のスコア同点・閾値未満フォールバック時のみ、次点候補のnotesを
//                           渡して選ばせた結果を受け取る（notesの内容そのものは絶対に保存・転送しない。
//                           safety.tsを通過した positive_note のみ許可する）。
//
// settings.llm.shadow_mode（Phase 7）で挙動が分岐する：
//   true（既定）  … Phase 6と同じ。結果はllm_shadow_detectionsに記録するのみで、本物の tasks
//                   テーブルには一切書き込まない。通知は developer_discord_id 宛のDMのみ（§9のドライラン）。
//   false（本稼働）… 同じ検出・割当ロジックの結果を実際に tasks テーブルへ書き込み、実担当者・
//                   運営専用チャンネルへ本番の通知を行う（materializeDetectedTask）。confidenceが
//                   閾値未満のものは自動タスク化せず、運営専用チャンネルに採否ボタン付きで提示する
//                   （§7.3・C-3）。

import type { Env } from "../env";
import { enqueueJob, markFailedTerminal, type JobRow } from "../jobs/queue";
import { getChannels, getJobRetrySetting, getLlmSetting, getTaskTargetDays, patchLlmSetting } from "../settings";
import { sendChannelMessage, sendChannelMessageWithComponents, sendDirectMessage } from "../discord/rest";
import { autoAssign } from "../tasks/autoAssign";
import { getTask, insertDetectedTask } from "../tasks/repo";
import { computeBotDefaultDueAt } from "../tasks/deadlines";
import { buildCoSignUnavailableNote, buildLlmDetectedAssignedNoticeEmbed } from "../tasks/templates";
import { postTaskAttentionPush, syncTaskMessage } from "../tasks/notify";
import { getStaffById } from "../staff/repo";
import { isValidTag } from "../staff/tags";
import { getTicketRequester } from "./ticketScan";
import { sanitizePositiveNote } from "./safety";
import { buildLlmCandidateButtonRow, buildLlmCandidateReviewEmbed } from "./templates";
import { writeAuditLog } from "../auditLog";

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

interface DetectTasksJobPayload {
  subkind: "detect_tasks";
  // messageScan.tsが積んだ元メッセージ（§7.1）。requester特定（Phase 7・T-B）のためだけに参照する。
  messages?: Array<{ source_message_url: string; author_discord_id: string }>;
}

interface TiebreakJobPayload {
  subkind: "assignment_tiebreak";
  source_message_url: string;
  required_tags: string[];
  candidates: Array<{ staff_id: string }>;
}

interface DetectedTaskFromCt {
  source_message_url?: string;
  type?: string;
  title?: string;
  summary?: string;
  required_tags?: string[];
  suggested_priority?: string | null;
  suggested_rule?: string | null;
  confidence?: number;
}

interface TiebreakResultFromCt {
  selected_staff_id?: string | null;
  positive_note?: string | null;
}

// CT側（ct/opsbot_ct/llm.py）が結果オブジェクトに埋め込む利用状況メタ情報（§7.4：利用枠消費の可視化）。
// CLIの--output-format jsonエンベロープからそのまま転記されるため、フィールドの有無・型はCLIバージョンに依存する。
interface LlmMeta {
  model?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  } | null;
  total_cost_usd?: number | null;
  num_turns?: number | null;
  duration_ms?: number | null;
}

export interface LlmShadowDetectionRow {
  id: number;
  job_id: number | null;
  source_message_url: string;
  type: string;
  title: string;
  summary: string;
  required_tags: string;
  suggested_priority: string | null;
  suggested_rule: string | null;
  confidence: number;
  status: string;
  would_assign_primary: string | null;
  would_assign_cosigner: string | null;
  would_assign_reason: string | null;
  positive_note: string | null;
  notified_at: string | null;
  source_channel_id: string | null;
  requester_discord_id: string | null;
  task_id: number | null;
  decided_by: string | null;
  decided_at: string | null;
  review_channel_id: string | null;
  review_message_id: string | null;
  created_at: string;
}

export async function getDetectionById(env: Env, id: number): Promise<LlmShadowDetectionRow | null> {
  return env.DB.prepare("SELECT * FROM llm_shadow_detections WHERE id = ?").bind(id).first<LlmShadowDetectionRow>();
}

export async function handleClaudeCodeJobComplete(
  env: Env,
  job: JobRow,
  outcome: { status: "done" | "failed"; result?: unknown; error?: string },
): Promise<void> {
  const payload = JSON.parse(job.payload) as DetectTasksJobPayload | TiebreakJobPayload;
  const llmMeta = (outcome.result as { _llm_meta?: LlmMeta } | null | undefined)?._llm_meta ?? null;

  await env.DB.prepare(`INSERT INTO llm_usage (job_id, kind, ok, detail) VALUES (?, 'claude_code', ?, ?)`)
    .bind(
      job.id,
      outcome.status === "done" ? 1 : 0,
      JSON.stringify({ subkind: payload.subkind, error: outcome.error ?? null, ...llmMeta }),
    )
    .run();

  await maybeAutoPauseOnFailures(env);

  if (outcome.status !== "done") {
    // 失敗：completeJob側で既に再試行スケジュール済み（status='pending'に戻る）。
    // 再試行上限に達した場合のみ終端化し、通知の連投を防ぐ（crafty_op等と同じパターン）。
    const retry = await getJobRetrySetting(env);
    if (job.attempts < retry.crafty_max_attempts) return;
    await markFailedTerminal(env, job.id);
    const channels = await getChannels(env);
    if (channels.unei_only) {
      await sendChannelMessage(
        env.DISCORD_BOT_TOKEN,
        channels.unei_only,
        `【要対応】LLM検出ジョブ（${payload.subkind}）が${job.attempts}回失敗しました。エラー: ${outcome.error ?? "不明"}`,
      ).catch(() => {});
    }
    return;
  }

  if (payload.subkind === "detect_tasks") {
    await handleDetectTasksResult(env, payload, outcome.result);
  } else if (payload.subkind === "assignment_tiebreak") {
    await handleTiebreakResult(env, payload, outcome.result);
  }
}

function extractChannelId(sourceMessageUrl: string): string | null {
  const m = sourceMessageUrl.match(/\/channels\/\d+\/(\d+)\//);
  return m ? (m[1] as string) : null;
}

/** T-B（参加者からの問い合わせ）のrequester特定：チケット開設者を優先し、無ければ検出元メッセージの投稿者にフォールバックする。 */
async function resolveRequesterId(
  env: Env,
  channelId: string | null,
  sourceMessageUrl: string,
  payload: DetectTasksJobPayload,
): Promise<string | null> {
  if (channelId) {
    const ticketRequester = await getTicketRequester(env, channelId);
    if (ticketRequester) return ticketRequester;
  }
  const fromPayload = payload.messages?.find((m) => m.source_message_url === sourceMessageUrl);
  return fromPayload?.author_discord_id ?? null;
}

function mapSuggestedPriority(suggested: string | null): "high" | "medium" | "low" {
  if (suggested === "高") return "high";
  if (suggested === "低") return "low";
  return "medium";
}

async function handleDetectTasksResult(env: Env, payload: DetectTasksJobPayload, rawResult: unknown): Promise<void> {
  const result = rawResult as { tasks?: DetectedTaskFromCt[] } | null;
  const tasks = result?.tasks ?? [];
  if (tasks.length === 0) return;

  const llmSetting = await getLlmSetting(env);
  const shadowMode = llmSetting.shadow_mode !== false; // 未設定時はシャドー側にフェイルセーフする

  for (const t of tasks) {
    if (!t.source_message_url || (t.type !== "T-B" && t.type !== "T-C") || !t.title || !t.summary || typeof t.confidence !== "number") {
      continue; // §7.3のスキーマを満たさない出力は無視する（前置き・Markdown混入等の防御）
    }
    const requiredTags = Array.isArray(t.required_tags) ? t.required_tags.filter(isValidTag) : [];
    const sourceChannelId = extractChannelId(t.source_message_url);
    const requesterId = t.type === "T-B" ? await resolveRequesterId(env, sourceChannelId, t.source_message_url, payload) : null;

    const insertRes = await env.DB.prepare(
      `INSERT OR IGNORE INTO llm_shadow_detections
         (source_message_url, type, title, summary, required_tags, suggested_priority, suggested_rule, confidence,
          source_channel_id, requester_discord_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_assignment')`,
    )
      .bind(
        t.source_message_url,
        t.type,
        t.title.slice(0, 40),
        t.summary.slice(0, 200),
        JSON.stringify(requiredTags),
        t.suggested_priority ?? null,
        t.suggested_rule ?? null,
        Math.max(0, Math.min(1, t.confidence)),
        sourceChannelId,
        requesterId,
      )
      .run();
    if (!insertRes.meta.changes) continue; // 既に検出済み（source_message_urlのUNIQUE制約・§9冪等性）

    if (t.confidence < llmSetting.confidence_threshold) {
      if (shadowMode) {
        await resolveDetection(env, t.source_message_url, { reason: "below_confidence_threshold" });
      } else {
        const detectionId = Number(insertRes.meta.last_row_id);
        await env.DB.prepare("UPDATE llm_shadow_detections SET status = 'candidate_pending' WHERE id = ?").bind(detectionId).run();
        await postCandidateForReview(env, detectionId);
      }
      continue;
    }

    const outcome = await autoAssign(env, {
      requiredTags,
      requiresTechnician: false,
      requiredPermissionTier: null,
      isControversial: requiredTags.includes("controversial_review"),
    });

    if (outcome.reason !== "tie_or_below_threshold") {
      if (shadowMode) {
        await resolveDetection(env, t.source_message_url, {
          reason: outcome.reason,
          primary: outcome.primary,
          cosigner: outcome.coSigner,
        });
      } else {
        await materializeDetectedTask(env, t.source_message_url, {
          primary: outcome.primary,
          coSigner: outcome.coSigner,
          coSignRequiredButUnavailable: outcome.coSignRequiredButUnavailable,
        });
      }
      continue;
    }

    const candidates: Array<{ staff_id: string; tags: string[]; notes: string | null }> = [];
    for (const staffId of outcome.llmFallbackCandidateIds) {
      const staff = await getStaffById(env, staffId);
      if (!staff) continue;
      candidates.push({ staff_id: staffId, tags: JSON.parse(staff.tags) as string[], notes: staff.notes });
    }

    if (candidates.length === 0) {
      if (shadowMode) {
        await resolveDetection(env, t.source_message_url, { reason: "tie_or_below_threshold" });
      } else {
        await materializeDetectedTask(env, t.source_message_url, { primary: null, coSigner: null, coSignRequiredButUnavailable: false });
      }
      continue;
    }

    await env.DB.prepare(
      `UPDATE llm_shadow_detections SET status = 'pending_tiebreak', would_assign_reason = 'tie_or_below_threshold' WHERE source_message_url = ?`,
    )
      .bind(t.source_message_url)
      .run();

    // §4.5・§7.3：スコア同点時のみ、候補のnotesをここでjob_queue.payload（CT向け）へ渡す。
    // notesはこのペイロード以外のどこにも保存しない。LLMの出力はsafety.tsで検査するまで信用しない。
    await enqueueJob(env, "claude_code", {
      subkind: "assignment_tiebreak",
      max_tokens: llmSetting.max_tokens,
      source_message_url: t.source_message_url,
      required_tags: requiredTags,
      candidates,
    });
  }

  if (shadowMode) await notifyDeveloperOfPendingDetections(env);
}

async function handleTiebreakResult(env: Env, payload: TiebreakJobPayload, rawResult: unknown): Promise<void> {
  const result = rawResult as TiebreakResultFromCt | null;
  const validStaffIds = new Set(payload.candidates.map((c) => c.staff_id));
  const selected = result?.selected_staff_id && validStaffIds.has(result.selected_staff_id) ? result.selected_staff_id : null;
  const note = sanitizePositiveNote(result?.positive_note ?? null);

  const llmSetting = await getLlmSetting(env);
  const shadowMode = llmSetting.shadow_mode !== false;

  if (shadowMode) {
    await env.DB.prepare(
      `UPDATE llm_shadow_detections
         SET status = 'resolved', would_assign_primary = ?, would_assign_reason = 'llm_tiebreak', positive_note = ?
       WHERE source_message_url = ?`,
    )
      .bind(selected, note, payload.source_message_url)
      .run();
    await notifyDeveloperOfPendingDetections(env);
    return;
  }

  // 本稼働：LLMのタイブレーク結果を実際の割当として使う。§4.5.1の共同確認要否は、通常の割当と
  // 同じ条件（論争性タグ／選定された者のrequires_cosign）で再判定し、次点候補（スコア順の残り）を
  // 共同確認者として補う（autoAssign通常経路のneedsCosign判定と揃える）。
  let coSigner: string | null = null;
  let coSignRequiredButUnavailable = false;
  if (selected) {
    const selectedStaff = await getStaffById(env, selected);
    const needsCosign = payload.required_tags.includes("controversial_review") || selectedStaff?.requires_cosign === 1;
    if (needsCosign) {
      const runnerUp = payload.candidates.find((c) => c.staff_id !== selected) ?? null;
      coSigner = runnerUp?.staff_id ?? null;
      coSignRequiredButUnavailable = coSigner === null;
    }
  }

  await materializeDetectedTask(
    env,
    payload.source_message_url,
    { primary: selected, coSigner, coSignRequiredButUnavailable },
    note,
  );
}

async function resolveDetection(
  env: Env,
  sourceMessageUrl: string,
  outcome: { reason: string; primary?: string | null; cosigner?: string | null },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE llm_shadow_detections
       SET status = 'resolved', would_assign_primary = ?, would_assign_cosigner = ?, would_assign_reason = ?
     WHERE source_message_url = ?`,
  )
    .bind(outcome.primary ?? null, outcome.cosigner ?? null, outcome.reason, sourceMessageUrl)
    .run();
}

/**
 * 本稼働（shadow_mode=false）：検出結果を実際の tasks テーブルへ書き込み、実担当者・運営専用
 * チャンネルへ本番の通知を行う（§7.3・§4.5）。detect_tasks・assignment_tiebreak・LLM候補の採用
 * ボタン（candidateReview.ts）のいずれの経路からも呼ばれる共通処理。既にtask_idが記録済みなら
 * 何もせずそのIDを返す（ジョブ再実行等に対する冪等性・§9）。
 */
export async function materializeDetectedTask(
  env: Env,
  sourceMessageUrl: string,
  assignment: { primary: string | null; coSigner: string | null; coSignRequiredButUnavailable: boolean },
  positiveNote: string | null = null,
): Promise<number> {
  const detection = await env.DB.prepare("SELECT * FROM llm_shadow_detections WHERE source_message_url = ?")
    .bind(sourceMessageUrl)
    .first<LlmShadowDetectionRow>();
  if (!detection) throw new Error(`materializeDetectedTask: 検出レコードが見つかりません（${sourceMessageUrl}）`);
  if (detection.task_id) return detection.task_id;

  const requiredTags = JSON.parse(detection.required_tags || "[]") as string[];
  const isControversial = requiredTags.includes("controversial_review");
  const priority = mapSuggestedPriority(detection.suggested_priority);
  const targetDays = await getTaskTargetDays(env);
  const dueAt = assignment.primary ? computeBotDefaultDueAt(targetDays, detection.type, new Date()) : null;

  const taskId = await insertDetectedTask(env, {
    type: detection.type as "T-B" | "T-C",
    title: detection.title,
    summary: detection.summary,
    sourceChannelId: detection.source_channel_id,
    sourceMessageUrl: detection.source_message_url,
    relatedRule: detection.suggested_rule,
    requester: detection.requester_discord_id,
    assignee: assignment.primary,
    coSigner: assignment.coSigner,
    priority,
    requiredTags,
    isControversial,
    dueAt,
    deadlineSource: assignment.primary ? "bot_default" : null,
  });

  await env.DB.prepare(
    `UPDATE llm_shadow_detections
       SET status = 'resolved', task_id = ?, would_assign_primary = ?, would_assign_cosigner = ?, would_assign_reason = ?,
           positive_note = COALESCE(?, positive_note)
     WHERE source_message_url = ?`,
  )
    .bind(taskId, assignment.primary, assignment.coSigner, assignment.primary ? "ok" : "no_eligible_or_tie", positiveNote, sourceMessageUrl)
    .run();

  await writeAuditLog(env, {
    actor: "system",
    action: "llm_task_created",
    target: String(taskId),
    detail: {
      sourceMessageUrl,
      type: detection.type,
      confidence: detection.confidence,
      assignee: assignment.primary,
      coSigner: assignment.coSigner,
    },
  });

  const channels = await getChannels(env);
  if (channels.unei_only) {
    const needsManualReview = !assignment.primary;
    const manualReviewNote = needsManualReview ? "自動割当できませんでした（候補者なし、またはスコア確定不可）" : null;
    await syncTaskMessage(env, taskId, {
      confidence: detection.confidence,
      sourceMessageUrl: detection.source_message_url,
      manualReviewNote,
    }).catch((e) => console.error("タスク起票通知の送信に失敗", e));
    if (needsManualReview) {
      const freshTask = await getTask(env, taskId);
      if (freshTask) {
        await postTaskAttentionPush(env, freshTask, "LLM自動検出タスクの自動割当に失敗しました（候補者なし、またはスコア確定不可）。");
      }
    }
  } else {
    console.error("settings.channels.unei_only が未設定のためLLM検出タスクの起票通知を投稿できません");
  }

  if (assignment.primary) {
    await sendDirectMessage(env.DISCORD_BOT_TOKEN, assignment.primary, "", [
      buildLlmDetectedAssignedNoticeEmbed({
        taskId,
        title: detection.title,
        assigneeMention: `<@${assignment.primary}>`,
        coSignerMention: assignment.coSigner ? `<@${assignment.coSigner}>` : null,
        dueAt,
        confidence: detection.confidence,
        positiveNote,
      }),
    ]).catch((e) => console.error("LLM検出タスクの担当者DM送信に失敗", e));
    if (assignment.coSigner) {
      await sendDirectMessage(
        env.DISCORD_BOT_TOKEN,
        assignment.coSigner,
        `タスク #${taskId}「${detection.title}」（LLM自動検出）の共同確認者に選定されました（§4.5.1）。`,
      ).catch((e) => console.error("共同確認者DM送信に失敗", e));
    }
    if (assignment.coSignRequiredButUnavailable && channels.unei_only) {
      await sendChannelMessage(env.DISCORD_BOT_TOKEN, channels.unei_only, buildCoSignUnavailableNote({ taskId, title: detection.title })).catch(() => {});
    }
  }

  return taskId;
}

/** confidenceが閾値未満の検出を、運営専用チャンネルへ採否ボタン付きで提示する（§7.3・C-3）。 */
async function postCandidateForReview(env: Env, detectionId: number): Promise<void> {
  const detection = await getDetectionById(env, detectionId);
  if (!detection) return;
  const channels = await getChannels(env);
  if (!channels.unei_only) {
    console.error("settings.channels.unei_only が未設定のためLLM検出候補を提示できません");
    return;
  }
  const embed = buildLlmCandidateReviewEmbed(detection);
  const messageId = await sendChannelMessageWithComponents(
    env.DISCORD_BOT_TOKEN,
    channels.unei_only,
    "",
    buildLlmCandidateButtonRow(detection.id),
    [embed],
  );
  await env.DB.prepare("UPDATE llm_shadow_detections SET review_channel_id = ?, review_message_id = ? WHERE id = ?")
    .bind(channels.unei_only, messageId, detection.id)
    .run();
}

interface PendingNotificationRow {
  id: number;
  type: string;
  title: string;
  summary: string;
  confidence: number;
  would_assign_primary: string | null;
  would_assign_cosigner: string | null;
  would_assign_reason: string | null;
  positive_note: string | null;
  source_message_url: string;
}

/** シャドーモード：解決済み（resolved）で未通知のものをまとめて開発者DMへ送る（§9：通知は開発者にのみ）。 */
async function notifyDeveloperOfPendingDetections(env: Env): Promise<void> {
  const llmSetting = await getLlmSetting(env);
  if (!llmSetting.developer_discord_id) return;

  const res = await env.DB.prepare(
    `SELECT id, type, title, summary, confidence, would_assign_primary, would_assign_cosigner, would_assign_reason, positive_note, source_message_url
     FROM llm_shadow_detections WHERE status = 'resolved' AND notified_at IS NULL ORDER BY id ASC LIMIT 20`,
  ).all<PendingNotificationRow>();
  const rows = res.results ?? [];
  if (rows.length === 0) return;

  const lines = rows.map((r) => {
    const assignLine = r.would_assign_primary
      ? `→ 割当プレビュー：<@${r.would_assign_primary}>${r.would_assign_cosigner ? `（共同確認：<@${r.would_assign_cosigner}>）` : ""}${
          r.positive_note ? `（AI補足：${r.positive_note}）` : ""
        }`
      : `→ 割当プレビューなし（${r.would_assign_reason ?? "-"}）`;
    return `[${r.type}] ${r.title}（確信度${r.confidence.toFixed(2)}）\n${r.summary}\n${assignLine}\n${r.source_message_url}`;
  });

  await sendDirectMessage(
    env.DISCORD_BOT_TOKEN,
    llmSetting.developer_discord_id,
    [
      "【シャドーモード：LLM検出結果（開発者にのみ通知・§9ドライラン）】",
      "実際のタスク起票・割当通知・DM送信は一切行っていません。誤検出率の確認用です。",
      ...lines,
    ].join("\n\n"),
  ).catch((e) => console.error("shadow notify DM failed", e));

  const ids = rows.map((r) => r.id);
  await env.DB.prepare(`UPDATE llm_shadow_detections SET notified_at = ? WHERE id IN (${ids.map(() => "?").join(",")})`)
    .bind(nowIso(), ...ids)
    .run();
}

/** §7.4：直近N回（consecutive_failure_pause_threshold）のclaude_code呼び出しが連続で失敗したら自動一時停止。 */
async function maybeAutoPauseOnFailures(env: Env): Promise<void> {
  const llmSetting = await getLlmSetting(env);
  if (llmSetting.paused) return;

  const n = llmSetting.consecutive_failure_pause_threshold;
  const res = await env.DB.prepare("SELECT ok FROM llm_usage WHERE kind = 'claude_code' ORDER BY id DESC LIMIT ?").bind(n).all<{ ok: number }>();
  const rows = res.results ?? [];
  if (rows.length < n || !rows.every((r) => r.ok === 0)) return;

  await patchLlmSetting(env, { paused: true });
  const msg = `【要対応】LLM呼び出しが連続${n}回失敗したため、LLM層を自動的に一時停止しました（C-2：他の全機能は継続動作します）。復旧後は \`/ops llm action:resume\` で再開してください。`;
  const channels = await getChannels(env);
  if (channels.unei_only) await sendChannelMessage(env.DISCORD_BOT_TOKEN, channels.unei_only, msg).catch(() => {});
  if (llmSetting.developer_discord_id) await sendDirectMessage(env.DISCORD_BOT_TOKEN, llmSetting.developer_discord_id, msg).catch(() => {});
}
