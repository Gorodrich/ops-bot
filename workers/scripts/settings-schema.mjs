// settings.yaml のスキーマ定義とバリデータ（D1 settings テーブル・ルールc / 要件定義 §9）。
// staff-schema.mjs と同じ方針：依存を増やさず素の JS。CLI からもテストからも import する。
//
// settings テーブルは key-value。value 列は TEXT だが中身は JSON 文字列で、
// 呼び出し側が JSON.parse する前提（migrations/0001_init.sql 参照）。
// このスクリプトは YAML のネイティブ型で書いた値を JSON 化して UPSERT SQL を生成する。

const SNOWFLAKE = /^\d{17,20}$/;
const HHMM = /^([01]\d|2[0-4]):[0-5]\d$/;

// 投入可能なトップレベルキー（migrations/0001_init.sql の INSERT INTO settings と対応）。
export const KNOWN_KEYS = [
  "discord_guild_id",
  "channels",
  "ticket_tool",
  "deadlines",
  "assignment_weights",
  "nudge",
  "attachment_zone_count_default",
  "polling",
  "account_link",
  "roles",
  "job_retry",
  "approval_types",
  "participant_approval_types",
  "task_target_days",
  "llm",
];

// 督促の段階的エスカレーション（§4.7）で許される送信先
const NUDGE_TARGETS = ["dm", "mention", "broadcast", "reassign"];

// 承認事項の分類表（§5.5）で許される quorum_type（method:"A"のみ・votes/domain.tsのQuorumTypeと対応）。
const QUORUM_TYPES = [
  "voters_majority",
  "supermajority_voters",
  "total_majority_excl_abstain",
  "supermajority_total",
  "total_majority_incl_abstain",
  "unanimous_excl_target",
];

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPositiveNumber(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function isNonNegativeNumber(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function isValidRegex(s) {
  if (typeof s !== "string" || s.length === 0) return false;
  try {
    new RegExp(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {unknown} doc  YAML.parse の結果（{ settings: { ... } } を期待）
 * @returns {string[]}    エラーメッセージの配列（空なら合格）
 */
export function validateSettingsDoc(doc) {
  const errors = [];
  if (!isPlainObject(doc) || !isPlainObject(doc.settings)) {
    return ["トップレベルに settings マッピングが必要です"];
  }
  const s = doc.settings;
  const keys = Object.keys(s);

  if (keys.length === 0) {
    errors.push("settings に投入するキーが1つもありません");
  }
  for (const k of keys) {
    if (!KNOWN_KEYS.includes(k)) {
      errors.push(`未知のキー「${k}」（投入可能なキー: ${KNOWN_KEYS.join(" / ")}）`);
    }
  }

  const has = (k) => Object.prototype.hasOwnProperty.call(s, k);
  const push = (msg) => errors.push(msg);

  if (has("discord_guild_id")) {
    if (typeof s.discord_guild_id !== "string" || !SNOWFLAKE.test(s.discord_guild_id)) {
      push("discord_guild_id は17〜20桁の数値文字列（Discord Snowflake）である必要があります");
    }
  }

  if (has("channels")) {
    const c = s.channels;
    if (!isPlainObject(c)) {
      push("channels はマッピングである必要があります");
    } else if (Object.keys(c).length === 0) {
      push("channels が空です（少なくとも1つのチャンネルIDを記入してください）");
    } else {
      for (const [name, id] of Object.entries(c)) {
        if (typeof id !== "string" || !SNOWFLAKE.test(id)) {
          push(`channels.${name} はチャンネルID（17〜20桁の数値文字列）である必要があります`);
        }
      }
    }
  }

  if (has("ticket_tool")) {
    const t = s.ticket_tool;
    if (!isPlainObject(t)) {
      push("ticket_tool はマッピングである必要があります");
    } else {
      const idArray = (field, minLen) => {
        const v = t[field];
        if (!Array.isArray(v)) {
          push(`ticket_tool.${field}: カテゴリIDの配列である必要があります`);
          return;
        }
        if (minLen && v.length < minLen) {
          push(`ticket_tool.${field}: 少なくとも ${minLen} 件必要です`);
        }
        v.forEach((id, i) => {
          if (typeof id !== "string" || !SNOWFLAKE.test(id)) {
            push(`ticket_tool.${field}[${i}]: カテゴリID（17〜20桁の数値文字列）である必要があります`);
          }
        });
      };
      idArray("ticket_open_category_ids", 1);
      idArray("ticket_closed_category_ids", 0);
      for (const field of ["ticket_open_name_pattern", "ticket_closed_name_pattern"]) {
        if (!isValidRegex(t[field])) {
          push(`ticket_tool.${field}: 有効な正規表現文字列である必要があります`);
        }
      }
      if (!Number.isInteger(t.ticket_channel_scan_interval_sec) || t.ticket_channel_scan_interval_sec <= 0) {
        push("ticket_tool.ticket_channel_scan_interval_sec: 正の整数（秒）である必要があります");
      }
      const thr = t.ticket_keyword_filter_threshold;
      if (thr !== null && typeof thr !== "number") {
        push("ticket_tool.ticket_keyword_filter_threshold: null または数値である必要があります");
      }
    }
  }

  if (has("deadlines")) {
    const d = s.deadlines;
    if (!isPlainObject(d)) {
      push("deadlines はマッピングである必要があります");
    } else {
      for (const field of ["vote_hours", "provisional_confirm_hours", "revoke_window_hours", "conflict_hold_hours"]) {
        if (!isPositiveNumber(d[field])) {
          push(`deadlines.${field}: 正の数値（時間）である必要があります`);
        }
      }
      if (!isPositiveNumber(d.quick_vote_minutes)) {
        push("deadlines.quick_vote_minutes: 正の数値（分）である必要があります（§5.3：短縮投票の締切）");
      }
    }
  }

  if (has("assignment_weights")) {
    const w = s.assignment_weights;
    if (!isPlainObject(w)) {
      push("assignment_weights はマッピングである必要があります");
    } else {
      for (const field of ["w1", "w1_prime", "w2", "w3", "w4", "w5"]) {
        if (typeof w[field] !== "number" || !Number.isFinite(w[field])) {
          push(`assignment_weights.${field}: 数値である必要があります`);
        }
      }
      if (!isNonNegativeNumber(w.tag_match_threshold)) {
        push("assignment_weights.tag_match_threshold: 0 以上の数値である必要があります");
      }
      if (!Number.isInteger(w.consecutive_assign_limit) || w.consecutive_assign_limit <= 0) {
        push("assignment_weights.consecutive_assign_limit: 正の整数である必要があります");
      }
    }
  }

  if (has("nudge")) {
    const n = s.nudge;
    if (!isPlainObject(n)) {
      push("nudge はマッピングである必要があります");
    } else {
      if (!isPlainObject(n.quiet_hours) || !HHMM.test(n.quiet_hours.from ?? "") || !HHMM.test(n.quiet_hours.to ?? "")) {
        push("nudge.quiet_hours: { from: HH:MM, to: HH:MM } が必要です");
      }
      if (!Number.isInteger(n.max_per_day) || n.max_per_day <= 0) {
        push("nudge.max_per_day: 正の整数である必要があります");
      }
      if (!Array.isArray(n.levels)) {
        push("nudge.levels: 配列である必要があります");
      } else {
        n.levels.forEach((lvl, i) => {
          const p = (msg) => push(`nudge.levels[${i}]: ${msg}`);
          if (!isPlainObject(lvl)) { p("マッピングである必要があります"); return; }
          if (!Number.isInteger(lvl.level) || lvl.level < 1) p("level は1以上の整数である必要があります");
          if (!isNonNegativeNumber(lvl.hours_after_due)) p("hours_after_due: 0以上の数値（due_atからの経過時間）である必要があります");
          if (!NUDGE_TARGETS.includes(lvl.target)) p(`target は ${NUDGE_TARGETS.join("/")} のいずれかである必要があります`);
        });
      }
    }
  }

  if (has("task_target_days")) {
    const t = s.task_target_days;
    if (!isPlainObject(t)) {
      push("task_target_days はマッピングである必要があります");
    } else {
      if (!isPositiveNumber(t.default_days)) {
        push("task_target_days.default_days: 正の数値（日数）である必要があります");
      }
      if (!isPlainObject(t.by_type)) {
        push("task_target_days.by_type: マッピングである必要があります（空可）");
      } else {
        for (const [type, days] of Object.entries(t.by_type)) {
          if (!isPositiveNumber(days)) push(`task_target_days.by_type.${type}: 正の数値（日数）である必要があります`);
        }
      }
    }
  }

  if (has("attachment_zone_count_default")) {
    // /kaihatsu set の image1..imageN オプション本数（§6.3.2）。ゾーンは 01〜16 なので上限16。
    const n = s.attachment_zone_count_default;
    if (!Number.isInteger(n) || n <= 0 || n > 16) {
      push("attachment_zone_count_default: 1〜16 の整数である必要があります（image1..imageN の本数）");
    }
  }

  if (has("polling")) {
    const p = s.polling;
    if (!isPlainObject(p)) {
      push("polling はマッピングである必要があります");
    } else {
      for (const field of ["active_interval_sec", "idle_interval_sec"]) {
        if (!isPositiveNumber(p[field])) {
          push(`polling.${field}: 正の数値（秒）である必要があります`);
        }
      }
      if (isPositiveNumber(p.active_interval_sec) && isPositiveNumber(p.idle_interval_sec)
        && p.active_interval_sec > p.idle_interval_sec) {
        push("polling.active_interval_sec は idle_interval_sec 以下である必要があります");
      }
    }
  }

  if (has("account_link")) {
    const a = s.account_link;
    if (!isPlainObject(a)) {
      push("account_link はマッピングである必要があります");
    } else {
      if (typeof a.allow_self_overwrite !== "boolean") {
        push("account_link.allow_self_overwrite: 真偽値である必要があります");
      }
      if (!isNonNegativeNumber(a.whitelist_removal_grace_hours)) {
        push("account_link.whitelist_removal_grace_hours: 0 以上の数値である必要があります");
      }
      const ret = a.inactive_retention_days;
      if (ret !== null && !isPositiveNumber(ret)) {
        push("account_link.inactive_retention_days: null または正の数値である必要があります");
      }
    }
  }

  if (has("roles")) {
    const r = s.roles;
    if (!isPlainObject(r)) {
      push("roles はマッピングである必要があります");
    } else {
      for (const field of ["hito", "kari_sanka", "sub_aka", "unei"]) {
        if (typeof r[field] !== "string" || !SNOWFLAKE.test(r[field])) {
          push(`roles.${field}: ロールID（17〜20桁の数値文字列）である必要があります`);
        }
      }
    }
  }

  if (has("job_retry")) {
    const j = s.job_retry;
    if (!isPlainObject(j)) {
      push("job_retry はマッピングである必要があります");
    } else {
      if (!Number.isInteger(j.crafty_max_attempts) || j.crafty_max_attempts <= 0) {
        push("job_retry.crafty_max_attempts: 正の整数である必要があります");
      }
      if (!isPositiveNumber(j.crafty_retry_backoff_sec)) {
        push("job_retry.crafty_retry_backoff_sec: 正の数値（秒）である必要があります");
      }
      if (
        !Number.isInteger(j.crafty_audit_report_hour_utc) ||
        j.crafty_audit_report_hour_utc < 0 ||
        j.crafty_audit_report_hour_utc > 23
      ) {
        push("job_retry.crafty_audit_report_hour_utc: 0〜23 の整数（UTC時）である必要があります");
      }
      if (!isPositiveNumber(j.stale_after_sec)) {
        push("job_retry.stale_after_sec: 正の数値（秒）である必要があります");
      }
    }
  }

  function validateApprovalTypesMap(key, emptyMessage) {
    const a = s[key];
    if (!isPlainObject(a)) {
      push(`${key} はマッピングである必要があります`);
    } else if (Object.keys(a).length === 0) {
      push(emptyMessage);
    } else {
      for (const [entryKey, entry] of Object.entries(a)) {
        const p = (msg) => push(`${key}.${entryKey}: ${msg}`);
        if (!isPlainObject(entry)) {
          p("マッピングである必要があります");
          continue;
        }
        if (typeof entry.label !== "string" || entry.label.length === 0) {
          p("label は空でない文字列である必要があります");
        }
        if (entry.method !== "A" && entry.method !== "B") {
          p('method は "A" または "B" である必要があります');
        }
        if (typeof entry.exclude_self !== "boolean") {
          p("exclude_self は真偽値である必要があります");
        }
        if (entry.method === "A") {
          if (!QUORUM_TYPES.includes(entry.quorum_type)) {
            p(`quorum_type は次のいずれかである必要があります: ${QUORUM_TYPES.join(" / ")}`);
          }
          const NO_THRESHOLD_QUORUM_TYPES = ["unanimous_excl_target", "voters_majority", "total_majority_excl_abstain", "total_majority_incl_abstain"];
          if (!NO_THRESHOLD_QUORUM_TYPES.includes(entry.quorum_type)) {
            if (typeof entry.threshold !== "number" || entry.threshold <= 0 || entry.threshold > 1) {
              p("threshold は0より大きく1以下の数値である必要があります（特別多数の割合）");
            }
          }
        }
        if (entry.method === "B") {
          if (!Number.isInteger(entry.required_count) || entry.required_count <= 0) {
            p("required_count は正の整数である必要があります（記名許可の必要人数）");
          }
        }
        if (entry.participant_vote_required !== undefined && typeof entry.participant_vote_required !== "boolean") {
          p("participant_vote_required は真偽値である必要があります");
        }
      }
    }
  }

  if (has("approval_types")) {
    validateApprovalTypesMap("approval_types", "approval_types が空です（§5.5の分類表を記入してください）");
  }

  if (has("participant_approval_types")) {
    validateApprovalTypesMap(
      "participant_approval_types",
      "participant_approval_types が空です（参加者投票／voteの分類表を記入してください）",
    );
  }

  if (has("llm")) {
    const l = s.llm;
    if (!isPlainObject(l)) {
      push("llm はマッピングである必要があります");
    } else {
      if (typeof l.developer_discord_id !== "string" || (l.developer_discord_id !== "" && !SNOWFLAKE.test(l.developer_discord_id))) {
        push("llm.developer_discord_id: 空文字列（未確定）またはDiscordユーザーID（17〜20桁の数値文字列）である必要があります");
      }
      if (typeof l.confidence_threshold !== "number" || l.confidence_threshold < 0 || l.confidence_threshold > 1) {
        push("llm.confidence_threshold: 0以上1以下の数値である必要があります（§7.3）");
      }
      if (!Number.isInteger(l.max_tokens) || l.max_tokens <= 0) {
        push("llm.max_tokens: 正の整数である必要があります（§7.3）");
      }
      if (!Number.isInteger(l.min_message_chars) || l.min_message_chars < 0) {
        push("llm.min_message_chars: 0以上の整数である必要があります（§7.2）");
      }
      if (!Array.isArray(l.coarse_filter_patterns)) {
        push("llm.coarse_filter_patterns: 正規表現文字列の配列である必要があります（§7.2）");
      } else {
        l.coarse_filter_patterns.forEach((p, i) => {
          if (!isValidRegex(p)) push(`llm.coarse_filter_patterns[${i}]: 有効な正規表現文字列である必要があります`);
        });
      }
      if (!isPositiveNumber(l.scan_interval_sec)) {
        push("llm.scan_interval_sec: 正の数値（秒）である必要があります（§7.1）");
      }
      if (!Number.isInteger(l.consecutive_failure_pause_threshold) || l.consecutive_failure_pause_threshold <= 0) {
        push("llm.consecutive_failure_pause_threshold: 正の整数である必要があります（§7.4）");
      }
      if (typeof l.paused !== "boolean") {
        push("llm.paused: 真偽値である必要があります（§7.4：手動/自動の一時停止フラグ）");
      }
      if (typeof l.shadow_mode !== "boolean") {
        push("llm.shadow_mode: 真偽値である必要があります（Phase 7：falseで本稼働に切り替わる）");
      }
    }
  }

  return errors;
}

/** settings ドキュメントを D1 settings テーブルへの UPSERT 文へ変換する。 */
export function toUpsertSql(doc) {
  const s = doc.settings;
  const rows = KNOWN_KEYS
    .filter((k) => Object.prototype.hasOwnProperty.call(s, k))
    .map((k) => `  (${q(k)}, ${q(JSON.stringify(s[k]))})`);

  return (
    "INSERT INTO settings (key, value) VALUES\n" +
    rows.join(",\n") +
    "\nON CONFLICT(key) DO UPDATE SET\n" +
    "  value=excluded.value,\n" +
    "  updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now');"
  );
}

function q(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}
