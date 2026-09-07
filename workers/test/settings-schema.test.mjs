import { describe, it, expect } from "vitest";
import { validateSettingsDoc, toUpsertSql, KNOWN_KEYS } from "../scripts/settings-schema.mjs";

const base = () => ({
  settings: {
    discord_guild_id: "123456789012345678",
    channels: {
      kaihatsu_ryo: "111111111111111111",
      notify_default: "222222222222222222",
    },
    ticket_tool: {
      ticket_open_category_ids: ["333333333333333333"],
      ticket_closed_category_ids: [],
      ticket_open_name_pattern: "^ticket-",
      ticket_closed_name_pattern: "^closed-",
      ticket_channel_scan_interval_sec: 3600,
      ticket_keyword_filter_threshold: null,
    },
    deadlines: {
      vote_hours: 24,
      provisional_confirm_hours: 72,
      revoke_window_hours: 24,
      conflict_hold_hours: 72,
      quick_vote_minutes: 15,
    },
    assignment_weights: {
      w1: 1.0, w1_prime: 1.0, w2: 1.0, w3: 1.0, w4: 1.0, w5: 1.0,
      tag_match_threshold: 0.0,
      consecutive_assign_limit: 3,
    },
    nudge: {
      quiet_hours: { from: "23:00", to: "08:00" },
      max_per_day: 3,
      levels: [],
    },
    attachment_zone_count_default: 5,
    polling: { active_interval_sec: 4, idle_interval_sec: 45 },
    account_link: {
      allow_self_overwrite: false,
      whitelist_removal_grace_hours: 0,
      inactive_retention_days: null,
    },
    roles: {
      hito: "444444444444444444",
      kari_sanka: "555555555555555555",
      sub_aka: "666666666666666666",
      unei: "777777777777777777",
    },
    job_retry: {
      crafty_max_attempts: 5,
      crafty_retry_backoff_sec: 60,
      crafty_audit_report_hour_utc: 9,
      stale_after_sec: 300,
    },
    approval_types: {
      punishment_decision: { label: "処罰の決定・執行", method: "A", quorum_type: "voters_majority", exclude_self: false },
      land_reclamation: { label: "海の埋立ての許可", method: "B", required_count: 2, exclude_self: false },
      rule_enactment: {
        label: "ルールの制定・改正",
        method: "A",
        quorum_type: "supermajority_voters",
        threshold: 0.6667,
        exclude_self: false,
        participant_vote_required: true,
      },
    },
    participant_approval_types: {
      former_participant_readmission: { label: "参加者となる権利の取得（元参加者）", method: "A", quorum_type: "voters_majority", exclude_self: false },
      worlddata_external_include_nonparticipants: {
        label: "ワールドデータの外部利用（非参加者含む・特別多数）",
        method: "A",
        quorum_type: "total_majority_incl_abstain",
        exclude_self: false,
      },
    },
    llm: {
      developer_discord_id: "888888888888888888",
      confidence_threshold: 0.6,
      max_tokens: 1024,
      min_message_chars: 8,
      coarse_filter_patterns: [],
      scan_interval_sec: 1800,
      consecutive_failure_pause_threshold: 5,
      paused: false,
      shadow_mode: true,
    },
  },
});

describe("validateSettingsDoc", () => {
  it("完全なドキュメントは合格する", () => {
    expect(validateSettingsDoc(base())).toEqual([]);
  });

  it("一部キーだけでも合格する（部分更新）", () => {
    expect(validateSettingsDoc({ settings: { discord_guild_id: "123456789012345678" } })).toEqual([]);
  });

  it("トップレベルに settings が無いと不合格", () => {
    expect(validateSettingsDoc({})).toHaveLength(1);
    expect(validateSettingsDoc({ settings: [] })).toHaveLength(1);
  });

  it("空の settings を検出する", () => {
    expect(validateSettingsDoc({ settings: {} }).some((e) => e.includes("1つもありません"))).toBe(true);
  });

  it("未知のキーを検出する", () => {
    const d = base();
    d.settings.bogus_key = 1;
    expect(validateSettingsDoc(d).some((e) => e.includes("未知のキー"))).toBe(true);
  });

  it("不正な guild id を検出する", () => {
    const d = base();
    d.settings.discord_guild_id = "abc";
    expect(validateSettingsDoc(d).some((e) => e.includes("discord_guild_id"))).toBe(true);
  });

  it("チャンネルIDが Snowflake でないと検出する", () => {
    const d = base();
    d.settings.channels.kaihatsu_ryo = "not-an-id";
    expect(validateSettingsDoc(d).some((e) => e.includes("channels.kaihatsu_ryo"))).toBe(true);
  });

  it("ticket_open_category_ids が空だと検出する", () => {
    const d = base();
    d.settings.ticket_tool.ticket_open_category_ids = [];
    expect(validateSettingsDoc(d).some((e) => e.includes("ticket_open_category_ids"))).toBe(true);
  });

  it("不正な正規表現を検出する", () => {
    const d = base();
    d.settings.ticket_tool.ticket_open_name_pattern = "[unclosed";
    expect(validateSettingsDoc(d).some((e) => e.includes("ticket_open_name_pattern"))).toBe(true);
  });

  it("期限が非正だと検出する", () => {
    const d = base();
    d.settings.deadlines.vote_hours = 0;
    expect(validateSettingsDoc(d).some((e) => e.includes("deadlines.vote_hours"))).toBe(true);
  });

  it("quiet_hours の時刻形式を検証する", () => {
    const d = base();
    d.settings.nudge.quiet_hours.from = "9:00";
    expect(validateSettingsDoc(d).some((e) => e.includes("quiet_hours"))).toBe(true);
  });

  it("polling の active > idle を検出する", () => {
    const d = base();
    d.settings.polling.active_interval_sec = 99;
    expect(validateSettingsDoc(d).some((e) => e.includes("polling.active_interval_sec"))).toBe(true);
  });

  it("attachment_zone_count_default は 1〜16 の整数", () => {
    for (const bad of [0, -1, 17, 2.5]) {
      const d = base();
      d.settings.attachment_zone_count_default = bad;
      expect(validateSettingsDoc(d).some((e) => e.includes("attachment_zone_count_default"))).toBe(true);
    }
    const ok = base();
    ok.settings.attachment_zone_count_default = 16;
    expect(validateSettingsDoc(ok)).toEqual([]);
  });

  it("KNOWN_KEYS は migration の settings キーと一致（15件・参加者投票でparticipant_approval_types追加）", () => {
    expect(KNOWN_KEYS).toHaveLength(15);
  });

  it("participant_approval_types が空だと検出する（参加者投票）", () => {
    const d = base();
    d.settings.participant_approval_types = {};
    expect(validateSettingsDoc(d).some((e) => e.includes("participant_approval_types"))).toBe(true);
  });

  it("roles のロールIDが Snowflake でないと検出する", () => {
    const d = base();
    d.settings.roles.hito = "not-an-id";
    expect(validateSettingsDoc(d).some((e) => e.includes("roles.hito"))).toBe(true);
  });

  it("job_retry.crafty_max_attempts が非正だと検出する", () => {
    const d = base();
    d.settings.job_retry.crafty_max_attempts = 0;
    expect(validateSettingsDoc(d).some((e) => e.includes("job_retry.crafty_max_attempts"))).toBe(true);
  });

  it("job_retry.crafty_audit_report_hour_utc の範囲外を検出する", () => {
    const d = base();
    d.settings.job_retry.crafty_audit_report_hour_utc = 24;
    expect(validateSettingsDoc(d).some((e) => e.includes("crafty_audit_report_hour_utc"))).toBe(true);
  });

  it("job_retry.stale_after_sec が非正だと検出する", () => {
    const d = base();
    d.settings.job_retry.stale_after_sec = 0;
    expect(validateSettingsDoc(d).some((e) => e.includes("job_retry.stale_after_sec"))).toBe(true);
  });

  it("deadlines.quick_vote_minutes が非正だと検出する（§5.3）", () => {
    const d = base();
    d.settings.deadlines.quick_vote_minutes = 0;
    expect(validateSettingsDoc(d).some((e) => e.includes("quick_vote_minutes"))).toBe(true);
  });

  it("approval_types が空だと検出する（§5.5）", () => {
    const d = base();
    d.settings.approval_types = {};
    expect(validateSettingsDoc(d).some((e) => e.includes("approval_types"))).toBe(true);
  });

  it("approval_types.method が A/B 以外だと検出する", () => {
    const d = base();
    d.settings.approval_types.punishment_decision.method = "C";
    expect(validateSettingsDoc(d).some((e) => e.includes("method"))).toBe(true);
  });

  it("method:A で quorum_type が不正だと検出する", () => {
    const d = base();
    d.settings.approval_types.punishment_decision.quorum_type = "bogus";
    expect(validateSettingsDoc(d).some((e) => e.includes("quorum_type"))).toBe(true);
  });

  it("method:A の特別多数系で threshold が範囲外だと検出する", () => {
    const d = base();
    d.settings.approval_types.rule_enactment.threshold = 1.5;
    expect(validateSettingsDoc(d).some((e) => e.includes("threshold"))).toBe(true);
  });

  it("method:B で required_count が非正だと検出する", () => {
    const d = base();
    d.settings.approval_types.land_reclamation.required_count = 0;
    expect(validateSettingsDoc(d).some((e) => e.includes("required_count"))).toBe(true);
  });

  it("正しい approval_types は合格する", () => {
    expect(validateSettingsDoc(base())).toEqual([]);
  });

  it("llm.developer_discord_id は空文字列（未確定）を許容する", () => {
    const d = base();
    d.settings.llm.developer_discord_id = "";
    expect(validateSettingsDoc(d)).toEqual([]);
  });

  it("llm.developer_discord_id が Snowflake でも空文字列でもないと検出する", () => {
    const d = base();
    d.settings.llm.developer_discord_id = "not-a-snowflake";
    expect(validateSettingsDoc(d).some((e) => e.includes("developer_discord_id"))).toBe(true);
  });

  it("llm.confidence_threshold が範囲外だと検出する（§7.3）", () => {
    const d = base();
    d.settings.llm.confidence_threshold = 1.5;
    expect(validateSettingsDoc(d).some((e) => e.includes("confidence_threshold"))).toBe(true);
  });

  it("llm.max_tokens が非正だと検出する（§7.3）", () => {
    const d = base();
    d.settings.llm.max_tokens = 0;
    expect(validateSettingsDoc(d).some((e) => e.includes("max_tokens"))).toBe(true);
  });

  it("llm.coarse_filter_patterns の不正な正規表現を検出する（§7.2）", () => {
    const d = base();
    d.settings.llm.coarse_filter_patterns = ["("];
    expect(validateSettingsDoc(d).some((e) => e.includes("coarse_filter_patterns"))).toBe(true);
  });

  it("llm.consecutive_failure_pause_threshold が非正だと検出する（§7.4）", () => {
    const d = base();
    d.settings.llm.consecutive_failure_pause_threshold = 0;
    expect(validateSettingsDoc(d).some((e) => e.includes("consecutive_failure_pause_threshold"))).toBe(true);
  });

  it("llm.paused が真偽値でないと検出する", () => {
    const d = base();
    d.settings.llm.paused = "false";
    expect(validateSettingsDoc(d).some((e) => e.includes("llm.paused"))).toBe(true);
  });

  it("llm.shadow_mode が真偽値でないと検出する", () => {
    const d = base();
    d.settings.llm.shadow_mode = "true";
    expect(validateSettingsDoc(d).some((e) => e.includes("llm.shadow_mode"))).toBe(true);
  });

  it("llm.shadow_mode: false（本稼働）は合格する", () => {
    const d = base();
    d.settings.llm.shadow_mode = false;
    expect(validateSettingsDoc(d)).toEqual([]);
  });
});

describe("toUpsertSql", () => {
  it("settings テーブルへの UPSERT を生成する", () => {
    const sql = toUpsertSql(base());
    expect(sql).toContain("INSERT INTO settings (key, value) VALUES");
    expect(sql).toContain("ON CONFLICT(key) DO UPDATE");
    expect(sql).toContain("'discord_guild_id'");
    expect(sql).toContain('\'"123456789012345678"\''); // JSON 文字列として格納
  });

  it("記入したキーのみを出力する", () => {
    const sql = toUpsertSql({ settings: { attachment_zone_count_default: 5 } });
    expect(sql).toContain("'attachment_zone_count_default'");
    expect(sql).not.toContain("'channels'");
    expect(sql).toContain("'5'"); // 数値はそのまま
  });

  it("値のシングルクォートをエスケープする", () => {
    const sql = toUpsertSql({ settings: { channels: { "it's": "111111111111111111" } } });
    expect(sql).toContain("it''s");
  });

  it("KNOWN_KEYS の順序で出力する", () => {
    const sql = toUpsertSql({ settings: { polling: { active_interval_sec: 4, idle_interval_sec: 45 }, discord_guild_id: "123456789012345678" } });
    expect(sql.indexOf("discord_guild_id")).toBeLessThan(sql.indexOf("polling"));
  });
});
