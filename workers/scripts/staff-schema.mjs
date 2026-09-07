// staff.yaml のスキーマ定義とバリデータ（要件定義 §4.4）。
// 依存を増やさないため素の JS で実装。CLI からもテストからも import する。

export const TAG_VOCAB = [
  "rule_drafting",
  "technical",
  "participant_support",
  "moderation",
  "community_management",
  "announcement",
  "survey",
  "controversial_review",
  "data_handling",
];

const PERMISSION_TIERS = ["admin", "broad", "standard"];
const RESPONSE_PATTERNS = ["fast", "normal", "slow", "deadline_driven"];
const NUDGE_STYLES = ["gentle", "standard", "firm"];
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
// from は当日開始のみ（00:00〜24:00）。to は深夜帯の継続を24時超で表記できる
// （例: 26:00 = 翌日02:00）。当番判定ロジック側で mod 24 して解釈すること。
const HHMM_FROM = /^([01]\d|2[0-4]):[0-5]\d$/;
const HHMM_TO = /^([01]\d|2[0-8]):[0-5]\d$/;

/**
 * @param {unknown} doc  YAML.parse の結果（{ staff: [...] } を期待）
 * @returns {string[]}    エラーメッセージの配列（空なら合格）
 */
export function validateStaffDoc(doc) {
  const errors = [];
  if (typeof doc !== "object" || doc === null || !Array.isArray(doc.staff)) {
    return ["トップレベルに staff 配列が必要です"];
  }
  const seenIds = new Set();

  doc.staff.forEach((s, i) => {
    const at = `staff[${i}]`;
    const req = (cond, msg) => { if (!cond) errors.push(`${at}: ${msg}`); };

    req(typeof s.discord_id === "string" && /^\d{17,20}$/.test(s.discord_id),
      "discord_id は17〜20桁の数値文字列（Discord Snowflake）である必要があります");
    if (typeof s.discord_id === "string") {
      req(!seenIds.has(s.discord_id), `discord_id が重複しています: ${s.discord_id}`);
      seenIds.add(s.discord_id);
    }
    req(typeof s.display_name === "string" && s.display_name.length > 0, "display_name は必須です");
    req(typeof s.active === "boolean", "active は真偽値である必要があります");

    for (const field of ["tags", "weak_tags"]) {
      const v = s[field];
      if (!Array.isArray(v)) { errors.push(`${at}.${field}: 配列である必要があります`); continue; }
      for (const t of v) {
        req(TAG_VOCAB.includes(t), `${field} に未知のタグ「${t}」（§4.4 の語彙のみ使用可）`);
      }
    }
    if (Array.isArray(s.tags) && Array.isArray(s.weak_tags)) {
      const overlap = s.tags.filter((t) => s.weak_tags.includes(t));
      req(overlap.length === 0, `tags と weak_tags が重複: ${overlap.join(", ")}`);
    }

    req(typeof s.is_technician === "boolean", "is_technician は真偽値である必要があります");
    req(PERMISSION_TIERS.includes(s.discord_permission_tier),
      `discord_permission_tier は ${PERMISSION_TIERS.join("|")} のいずれか`);
    req(typeof s.requires_cosign === "boolean", "requires_cosign は真偽値である必要があります");
    req(Number.isInteger(s.max_concurrent) && s.max_concurrent > 0, "max_concurrent は正の整数");
    req(RESPONSE_PATTERNS.includes(s.response_pattern),
      `response_pattern は ${RESPONSE_PATTERNS.join("|")} のいずれか`);
    req(NUDGE_STYLES.includes(s.nudge_style), `nudge_style は ${NUDGE_STYLES.join("|")} のいずれか`);

    if (!Array.isArray(s.active_hours)) {
      errors.push(`${at}.active_hours: 配列である必要があります`);
    } else {
      s.active_hours.forEach((w, j) => {
        const wat = `${at}.active_hours[${j}]`;
        if (!Array.isArray(w.days) || w.days.some((d) => !DAYS.includes(d))) {
          errors.push(`${wat}.days: ${DAYS.join("/")} の配列である必要があります`);
        }
        if (!HHMM_FROM.test(w.from ?? "")) errors.push(`${wat}.from: HH:MM 形式（00:00〜24:00）`);
        if (!HHMM_TO.test(w.to ?? "")) errors.push(`${wat}.to: HH:MM 形式（00:00〜28:59、24時超は翌日への継続を表す）`);
      });
    }

    const leave = s.on_leave;
    if (typeof leave !== "object" || leave === null || typeof leave.active !== "boolean") {
      errors.push(`${at}.on_leave: { active: bool, until: string|null } が必要です`);
    } else if (leave.active) {
      req(typeof leave.until === "string" && !Number.isNaN(Date.parse(leave.until)),
        "on_leave.active が true の場合 until に日付が必要です");
    }
  });

  return errors;
}

/** staff ドキュメントを D1 staff テーブルへの INSERT 文へ変換する。 */
export function toInsertSql(doc) {
  const rows = doc.staff.map((s) => {
    const vals = [
      q(s.discord_id),
      q(s.display_name),
      s.active ? 1 : 0,
      q(JSON.stringify(s.tags)),
      q(JSON.stringify(s.weak_tags)),
      s.is_technician ? 1 : 0,
      q(s.discord_permission_tier),
      s.requires_cosign ? 1 : 0,
      s.max_concurrent,
      q(JSON.stringify(s.active_hours)),
      q(s.response_pattern),
      q(s.nudge_style),
      s.on_leave.active ? 1 : 0,
      s.on_leave.until ? q(s.on_leave.until) : "NULL",
      s.notes ? q(s.notes) : "NULL",
    ].join(", ");
    return `  (${vals})`;
  });
  return (
    "INSERT INTO staff (discord_id, display_name, active, tags, weak_tags, is_technician,\n" +
    "  discord_permission_tier, requires_cosign, max_concurrent, active_hours, response_pattern,\n" +
    "  nudge_style, on_leave_active, on_leave_until, notes) VALUES\n" +
    rows.join(",\n") +
    "\nON CONFLICT(discord_id) DO UPDATE SET\n" +
    "  display_name=excluded.display_name, active=excluded.active, tags=excluded.tags,\n" +
    "  weak_tags=excluded.weak_tags, is_technician=excluded.is_technician,\n" +
    "  discord_permission_tier=excluded.discord_permission_tier, requires_cosign=excluded.requires_cosign,\n" +
    "  max_concurrent=excluded.max_concurrent, active_hours=excluded.active_hours,\n" +
    "  response_pattern=excluded.response_pattern, nudge_style=excluded.nudge_style,\n" +
    "  on_leave_active=excluded.on_leave_active, on_leave_until=excluded.on_leave_until,\n" +
    "  notes=excluded.notes, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now');"
  );
}

function q(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}
