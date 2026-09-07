// D1 `settings` テーブルの読み出し（ルールc：ID・重み・閾値をハードコードしない）。
// リクエスト単位で読み直す（Workers はリクエストごとに短命なため、長期キャッシュは持たない）。

import type { Env } from "./env";

export interface RolesSetting {
  hito: string;
  kari_sanka: string;
  sub_aka: string;
  unei: string;
  unei_sub: string; // 運営サブ垢ロール（/subaccount 連携対象・2026-09-07追加）
}

export interface AccountLinkSetting {
  allow_self_overwrite: boolean;
  whitelist_removal_grace_hours: number;
  inactive_retention_days: number | null;
}

export interface JobRetrySetting {
  crafty_max_attempts: number;
  crafty_retry_backoff_sec: number;
  crafty_audit_report_hour_utc: number;
  stale_after_sec: number;
}

export interface DeadlinesSetting {
  vote_hours: number;
  provisional_confirm_hours: number;
  revoke_window_hours: number;
  conflict_hold_hours: number;
  quick_vote_minutes: number;
  subaccount_confirm_hours: number;
}

export interface ChannelsSetting {
  [name: string]: string;
}

// 承認事項の分類表（§5.5）。事項ごとに quorum_type/threshold/exclude_self/method を持たせ、
// コードにハードコードしない（ルールc・§11-2）。
export type ApprovalMethod = "A" | "B";

// A（秘密投票）の定足数計算方式（§5.1・§5.2・§5.3・§5.5）：
//   voters_majority           棄権者を除く運営投票者の過半数（通常の秘密投票・§5.2-6）
//   supermajority_voters      同上の分母に対する特別多数（例：3分の2以上）
//   total_majority_excl_abstain  明示的棄権者を除く運営者総数の過半数（短縮投票・§5.3）
//   supermajority_total       運営者総数に対する特別多数（例：総数の3分の2以上）
//   total_majority_incl_abstain  棄権者も母数に含めた総数の過半数（thresholdは使わない。§5.5：
//                             参加者投票「ワールドデータの外部利用（非参加者含む）」・2026-09-06決定）
//   unanimous_excl_target     対象者本人を除くすべての運営者の賛成（運営者の処罰・解任／再任・§5.5）
export type QuorumType =
  | "voters_majority"
  | "supermajority_voters"
  | "total_majority_excl_abstain"
  | "supermajority_total"
  | "total_majority_incl_abstain"
  | "unanimous_excl_target";

export interface ApprovalTypeEntry {
  label: string;
  method: ApprovalMethod;
  // method: "A" のみ使用
  quorum_type?: QuorumType;
  threshold?: number; // supermajority系の割合（例 0.6667）。voters_majority/unanimousでは無視
  exclude_self: boolean; // 対象者自身を母数・投票権から除外するか（§5.5）
  // method: "B" のみ使用（記名許可の必要人数・§5.4）
  required_count?: number;
  // 参考情報のみ：参加者側の承認も別途必要な事項か（本Botは運営側の手続のみを扱う・§5.5）
  participant_vote_required?: boolean;
}

export interface ApprovalTypesSetting {
  [approvalKey: string]: ApprovalTypeEntry;
}

// 参加者投票（/vote）の承認事項の分類表。運営投票側（approval_types）とはテーブルが別のため
// 同じキー名を使っても競合しない（2026-09-06決定：参加者投票の新設）。
export type ParticipantApprovalTypesSetting = ApprovalTypesSetting;

// 割当アルゴリズムの重み・閾値（§4.5）。
export interface AssignmentWeightsSetting {
  w1: number;
  w1_prime: number;
  w2: number;
  w3: number;
  w4: number;
  w5: number;
  tag_match_threshold: number;
  consecutive_assign_limit: number;
}

// 督促の段階的エスカレーション（§4.7）。target は Lv1:DM Lv2:担当者メンション Lv3:全体共有 Lv4:自動再割当。
export type NudgeTarget = "dm" | "mention" | "broadcast" | "reassign";

export interface NudgeLevelEntry {
  level: number;
  hours_after_due: number; // due_at からの経過時間（時間）。この時間を過ぎたら当該levelを発火対象にする
  target: NudgeTarget;
}

export interface NudgeSetting {
  quiet_hours: { from: string; to: string };
  max_per_day: number;
  levels: NudgeLevelEntry[];
}

// ルール由来でない期限のBot既定目標日数（§4.6）。
export interface TaskTargetDaysSetting {
  default_days: number;
  by_type: { [taskType: string]: number };
}

// ticket tool（docs/appendix/ticket-tool-spec.md §6）。
export interface TicketToolSetting {
  ticket_open_category_ids: string[];
  ticket_closed_category_ids: string[];
  ticket_open_name_pattern: string;
  ticket_closed_name_pattern: string;
  ticket_channel_scan_interval_sec: number;
  ticket_keyword_filter_threshold: number | null;
}

// LLM層（§7）の起動条件・前処理フィルタ・利用枠の縮退運転条件。
export interface LlmSetting {
  developer_discord_id: string; // シャドーモード通知（DM）先（§9のドライラン期間中はここにのみ通知）
  confidence_threshold: number; // §7.3：これ未満は「候補」扱い（shadow_mode=falseでは運営専用チャンネルへの候補提示・採否ボタンに回る）
  max_tokens: number; // §7.3
  min_message_chars: number; // §7.2 粗フィルタ
  coarse_filter_patterns: string[]; // 通常監視チャンネル用のキーワード正規表現（空なら文字数のみで判定）
  scan_interval_sec: number; // §7.1：メッセージ差分取得の間隔（実行はCron発火間隔以下・絶対時刻で間引く）
  consecutive_failure_pause_threshold: number; // §7.4：直近の連続失敗がこの回数に達したら自動的に一時停止
  paused: boolean; // 手動（/ops llm pause）または自動一時停止フラグ（C-2：縮退運転）
  shadow_mode: boolean; // Phase 7：true＝Phase 6と同じ（検出結果はllm_shadow_detectionsに記録し開発者DMのみ）。
    // false＝本稼働（実タスク起票・実担当者への通知。§9のドライランで誤検出率を確認してから切り替えること）
}

async function getSetting<T>(env: Env, key: string): Promise<T> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  if (!row) throw new Error(`settings に ${key} がありません（migration 未適用の可能性）`);
  return JSON.parse(row.value) as T;
}

export const getRoles = (env: Env) => getSetting<RolesSetting>(env, "roles");
export const getAccountLinkSetting = (env: Env) => getSetting<AccountLinkSetting>(env, "account_link");
export const getJobRetrySetting = (env: Env) => getSetting<JobRetrySetting>(env, "job_retry");
export const getChannels = (env: Env) => getSetting<ChannelsSetting>(env, "channels");
export const getGuildId = (env: Env) => getSetting<string>(env, "discord_guild_id");
export const getDeadlines = (env: Env) => getSetting<DeadlinesSetting>(env, "deadlines");
export const getAttachmentZoneCountDefault = (env: Env) => getSetting<number>(env, "attachment_zone_count_default");
export const getApprovalTypes = (env: Env) => getSetting<ApprovalTypesSetting>(env, "approval_types");
export const getParticipantApprovalTypes = (env: Env) => getSetting<ParticipantApprovalTypesSetting>(env, "participant_approval_types");
export const getAssignmentWeights = (env: Env) => getSetting<AssignmentWeightsSetting>(env, "assignment_weights");
export const getNudgeSetting = (env: Env) => getSetting<NudgeSetting>(env, "nudge");
export const getTaskTargetDays = (env: Env) => getSetting<TaskTargetDaysSetting>(env, "task_target_days");
export const getTicketToolSetting = (env: Env) => getSetting<TicketToolSetting>(env, "ticket_tool");
export const getLlmSetting = (env: Env) => getSetting<LlmSetting>(env, "llm");

/**
 * settings.llm の一部フィールドだけを更新する（read-modify-write）。
 * 用途：自動一時停止（連続失敗検知）／`/ops llm pause`・`resume`（§7.4）。
 * settingsテーブルはキー単位のJSON blobのため、行ロックは行わず素朴に読み直して書き戻す
 * （呼び出し頻度が低く、競合の実害が小さいことを踏まえた単純化）。
 */
export async function patchLlmSetting(env: Env, patch: Partial<LlmSetting>): Promise<LlmSetting> {
  const current = await getLlmSetting(env);
  const next: LlmSetting = { ...current, ...patch };
  await env.DB.prepare(
    `UPDATE settings SET value = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE key = 'llm'`,
  )
    .bind(JSON.stringify(next))
    .run();
  return next;
}
