// tasks/deadlines.ts の期限計算の単体テスト（§11-5：期限判定は必ず単体テストを書く）。

import { describe, expect, it } from "vitest";
import { computeBotDefaultDueAt, parseManualDueAtJst } from "../src/tasks/deadlines";

describe("computeBotDefaultDueAt", () => {
  it("type別の目標日数をUTCのISO8601（絶対時刻）で返す", () => {
    const now = new Date("2026-09-06T00:00:00Z");
    const setting = { default_days: 7, by_type: { "T-C": 3 } };
    expect(computeBotDefaultDueAt(setting, "T-C", now)).toBe("2026-09-09T00:00:00Z");
  });

  it("by_typeに無いtypeはdefault_daysを使う", () => {
    const now = new Date("2026-09-06T00:00:00Z");
    const setting = { default_days: 7, by_type: {} };
    expect(computeBotDefaultDueAt(setting, "T-B", now)).toBe("2026-09-13T00:00:00Z");
  });
});

describe("parseManualDueAtJst", () => {
  it("JSTの日時をUTCへ変換する（日付跨ぎなし）", () => {
    expect(parseManualDueAtJst("2026-09-10-18-30")).toBe("2026-09-10T09:30:00Z");
  });

  it("JSTの深夜（UTC+9で前日に繰り下がるケース）を正しく変換する", () => {
    expect(parseManualDueAtJst("2026-09-10-05-00")).toBe("2026-09-09T20:00:00Z");
  });

  it("年またぎも正しく変換する", () => {
    expect(parseManualDueAtJst("2026-01-01-08-00")).toBe("2025-12-31T23:00:00Z");
  });

  it("形式が不正な場合はnull", () => {
    expect(parseManualDueAtJst("2026/09/10 18:30")).toBeNull();
    expect(parseManualDueAtJst("2026-09-10-18")).toBeNull();
    expect(parseManualDueAtJst("")).toBeNull();
  });

  it("存在しない日付・時刻はnull", () => {
    expect(parseManualDueAtJst("2026-02-30-12-00")).toBeNull();
    expect(parseManualDueAtJst("2026-09-10-24-00")).toBeNull();
    expect(parseManualDueAtJst("2026-13-01-12-00")).toBeNull();
    expect(parseManualDueAtJst("2026-09-10-12-60")).toBeNull();
  });
});
