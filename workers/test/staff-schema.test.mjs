import { describe, it, expect } from "vitest";
import { validateStaffDoc, toInsertSql, TAG_VOCAB } from "../scripts/staff-schema.mjs";

const base = () => ({
  staff: [
    {
      discord_id: "123456789012345678",
      display_name: "テスト運営",
      active: true,
      tags: ["technical"],
      weak_tags: ["moderation"],
      is_technician: true,
      discord_permission_tier: "admin",
      requires_cosign: false,
      max_concurrent: 3,
      active_hours: [{ days: ["mon", "sat"], from: "20:00", to: "24:00" }],
      response_pattern: "normal",
      nudge_style: "standard",
      on_leave: { active: false, until: null },
      notes: "x",
    },
  ],
});

describe("validateStaffDoc", () => {
  it("正しいドキュメントは合格する", () => {
    expect(validateStaffDoc(base())).toEqual([]);
  });

  it("トップレベルに staff 配列が無いと不合格", () => {
    expect(validateStaffDoc({})).toHaveLength(1);
  });

  it("不正な discord_id を検出する", () => {
    const d = base();
    d.staff[0].discord_id = "abc";
    expect(validateStaffDoc(d).some((e) => e.includes("discord_id"))).toBe(true);
  });

  it("discord_id の重複を検出する", () => {
    const d = base();
    d.staff.push({ ...d.staff[0] });
    expect(validateStaffDoc(d).some((e) => e.includes("重複"))).toBe(true);
  });

  it("語彙外タグを検出する", () => {
    const d = base();
    d.staff[0].tags = ["not_a_real_tag"];
    expect(validateStaffDoc(d).some((e) => e.includes("未知のタグ"))).toBe(true);
  });

  it("tags と weak_tags の重複を検出する", () => {
    const d = base();
    d.staff[0].tags = ["technical"];
    d.staff[0].weak_tags = ["technical"];
    expect(validateStaffDoc(d).some((e) => e.includes("重複"))).toBe(true);
  });

  it("on_leave.active=true で until 未指定を検出する", () => {
    const d = base();
    d.staff[0].on_leave = { active: true, until: null };
    expect(validateStaffDoc(d).some((e) => e.includes("until"))).toBe(true);
  });

  it("不正な時刻形式を検出する", () => {
    const d = base();
    d.staff[0].active_hours = [{ days: ["mon"], from: "9:00", to: "24:00" }];
    expect(validateStaffDoc(d).some((e) => e.includes("from"))).toBe(true);
  });

  it("to に24時超（翌日への継続）を許容する", () => {
    const d = base();
    d.staff[0].active_hours = [{ days: ["mon"], from: "20:00", to: "26:00" }];
    expect(validateStaffDoc(d)).toEqual([]);
  });

  it("to が28:59を超えると不合格", () => {
    const d = base();
    d.staff[0].active_hours = [{ days: ["mon"], from: "20:00", to: "29:00" }];
    expect(validateStaffDoc(d).some((e) => e.includes("to"))).toBe(true);
  });

  it("from に24時超は不合格（fromは当日開始のみ）", () => {
    const d = base();
    d.staff[0].active_hours = [{ days: ["mon"], from: "25:00", to: "26:00" }];
    expect(validateStaffDoc(d).some((e) => e.includes("from"))).toBe(true);
  });

  it("permission tier の値を制限する", () => {
    const d = base();
    d.staff[0].discord_permission_tier = "superadmin";
    expect(validateStaffDoc(d).some((e) => e.includes("discord_permission_tier"))).toBe(true);
  });

  it("タグ語彙は9種類", () => {
    expect(TAG_VOCAB).toHaveLength(9);
  });
});

describe("toInsertSql", () => {
  it("staff テーブルへの UPSERT を生成する", () => {
    const sql = toInsertSql(base());
    expect(sql).toContain("INSERT INTO staff");
    expect(sql).toContain("'123456789012345678'");
    expect(sql).toContain("ON CONFLICT(discord_id) DO UPDATE");
  });

  it("シングルクォートをエスケープする", () => {
    const d = base();
    d.staff[0].display_name = "O'Brien";
    expect(toInsertSql(d)).toContain("'O''Brien'");
  });
});
