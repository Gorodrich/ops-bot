// tasks/assignment.ts の割当アルゴリズムの単体テスト（§11-5：ハード条件・スコア・
// 同点/閾値未満のフォールバック・連続割当バランサ・active_hoursのJST判定を網羅）。

import { describe, expect, it } from "vitest";
import {
  computeScore,
  isHardEligible,
  isWithinActiveHours,
  isWithinDailyWindow,
  selectAssignment,
  tagMatchRatio,
  tierMeets,
} from "../src/tasks/assignment";

function candidate(overrides) {
  return {
    staffId: "a",
    active: true,
    onLeave: false,
    tags: [],
    weakTags: [],
    isTechnician: false,
    permissionTier: "standard",
    maxConcurrent: 3,
    currentLoad: 0,
    completionRate: 1,
    isActiveHoursNow: false,
    requiresCosign: false,
    ...overrides,
  };
}

function task(overrides) {
  return { requiredTags: [], requiresTechnician: false, requiredPermissionTier: null, ...overrides };
}

const WEIGHTS = { w1: 1, w1_prime: 1, w2: 1, w3: 1, w4: 1, w5: 1, tag_match_threshold: 0, consecutive_assign_limit: 3 };

describe("tierMeets（実行権限レベル・§4.5.1）", () => {
  it("要件なしは常に満たす", () => expect(tierMeets("standard", null)).toBe(true));
  it("adminはbroad要件を満たす", () => expect(tierMeets("admin", "broad")).toBe(true));
  it("standardはbroad要件を満たさない", () => expect(tierMeets("standard", "broad")).toBe(false));
});

describe("isHardEligible（§4.5：ハード条件）", () => {
  it("active:falseは除外", () => expect(isHardEligible(candidate({ active: false }), task({}))).toBe(false));
  it("休暇中は除外", () => expect(isHardEligible(candidate({ onLeave: true }), task({}))).toBe(false));
  it("技術者要件を満たさない者は除外", () => expect(isHardEligible(candidate({ isTechnician: false }), task({ requiresTechnician: true }))).toBe(false));
  it("実行権限レベル不足は除外", () => expect(isHardEligible(candidate({ permissionTier: "standard" }), task({ requiredPermissionTier: "admin" }))).toBe(false));
  it("max_concurrent到達は除外", () => expect(isHardEligible(candidate({ currentLoad: 3, maxConcurrent: 3 }), task({}))).toBe(false));
  it("すべて満たせば候補になる", () => expect(isHardEligible(candidate({}), task({}))).toBe(true));
});

describe("tagMatchRatio", () => {
  it("required_tagsが空なら中立の1", () => expect(tagMatchRatio([], ["technical"])).toBe(1));
  it("一致率を算出する", () => expect(tagMatchRatio(["technical", "survey"], ["technical"])).toBe(0.5));
});

describe("computeScore", () => {
  it("タグ一致度が高いほどスコアが上がる", () => {
    const t = task({ requiredTags: ["technical"] });
    const withTag = computeScore(candidate({ tags: ["technical"] }), t, WEIGHTS, false);
    const withoutTag = computeScore(candidate({ tags: [] }), t, WEIGHTS, false);
    expect(withTag).toBeGreaterThan(withoutTag);
  });
  it("weak_tagsに一致すると減点される", () => {
    const t = task({ requiredTags: ["technical"] });
    const withWeak = computeScore(candidate({ weakTags: ["technical"] }), t, WEIGHTS, false);
    const neutral = computeScore(candidate({}), t, WEIGHTS, false);
    expect(withWeak).toBeLessThan(neutral);
  });
  it("連続割当ブロック時はペナルティが乗る", () => {
    const t = task({});
    const blocked = computeScore(candidate({}), t, WEIGHTS, true);
    const notBlocked = computeScore(candidate({}), t, WEIGHTS, false);
    expect(blocked).toBeLessThan(notBlocked);
  });
});

describe("selectAssignment", () => {
  it("候補が0人ならno_eligible", () => {
    const r = selectAssignment({ eligible: [], task: task({}), weights: WEIGHTS, recentAssigneesDesc: [] });
    expect(r.reason).toBe("no_eligible");
    expect(r.primary).toBeNull();
  });

  it("スコアが最も高い者を主担当、次点をrunnerUpとする", () => {
    const eligible = [
      candidate({ staffId: "low", tags: [] }),
      candidate({ staffId: "high", tags: ["technical"] }),
    ];
    const r = selectAssignment({ eligible, task: task({ requiredTags: ["technical"] }), weights: WEIGHTS, recentAssigneesDesc: [] });
    expect(r.primary).toBe("high");
    expect(r.runnerUp).toBe("low");
    expect(r.reason).toBe("ok");
  });

  it("同点の場合はtie_or_below_thresholdとして手動対応に回す", () => {
    const eligible = [candidate({ staffId: "a" }), candidate({ staffId: "b" })];
    const r = selectAssignment({ eligible, task: task({}), weights: WEIGHTS, recentAssigneesDesc: [] });
    expect(r.reason).toBe("tie_or_below_threshold");
    expect(r.primary).toBeNull();
  });

  it("同点時はLLMフォールバック用の候補ID（スコア上位・最大5件）を返す（§4.5・§7.3）", () => {
    const eligible = [candidate({ staffId: "a" }), candidate({ staffId: "b" })];
    const r = selectAssignment({ eligible, task: task({}), weights: WEIGHTS, recentAssigneesDesc: [] });
    expect(r.llmFallbackCandidateIds.sort()).toEqual(["a", "b"]);
  });

  it("okの場合はLLMフォールバック候補は空", () => {
    const eligible = [candidate({ staffId: "low", tags: [] }), candidate({ staffId: "high", tags: ["technical"] })];
    const r = selectAssignment({ eligible, task: task({ requiredTags: ["technical"] }), weights: WEIGHTS, recentAssigneesDesc: [] });
    expect(r.llmFallbackCandidateIds).toEqual([]);
  });

  it("全員がtag_match_threshold未満なら手動対応に回す", () => {
    const eligible = [candidate({ staffId: "a", tags: [] }), candidate({ staffId: "b", tags: [], currentLoad: 1 })];
    const weights = { ...WEIGHTS, tag_match_threshold: 0.5 };
    const r = selectAssignment({ eligible, task: task({ requiredTags: ["technical"] }), weights, recentAssigneesDesc: [] });
    expect(r.reason).toBe("tie_or_below_threshold");
  });

  it("直近consecutive_assign_limit回連続で同一人物なら次点者へ強制的に回す", () => {
    const eligible = [
      candidate({ staffId: "top", tags: ["technical"] }), // 一致度が高くスコア最上位
      candidate({ staffId: "second", tags: [] }),
    ];
    const t = task({ requiredTags: ["technical"] });
    const withoutHistory = selectAssignment({ eligible, task: t, weights: WEIGHTS, recentAssigneesDesc: [] });
    expect(withoutHistory.primary).toBe("top");

    const withHistory = selectAssignment({ eligible, task: t, weights: WEIGHTS, recentAssigneesDesc: ["top", "top", "top"] });
    expect(withHistory.primary).toBe("second");
  });
});

describe("isWithinActiveHours（JST基準・§4.5）", () => {
  it("当日の時間帯に含まれればtrue（UTC 09:00 = JST 18:00）", () => {
    const windows = [{ days: ["mon"], from: "13:00", to: "23:00" }];
    // 2026-01-05 は月曜日
    const now = new Date("2026-01-05T09:00:00Z");
    expect(isWithinActiveHours(windows, now)).toBe(true);
  });

  it("曜日が異なれば含まれない", () => {
    const windows = [{ days: ["tue"], from: "13:00", to: "23:00" }];
    const now = new Date("2026-01-05T09:00:00Z"); // 月曜
    expect(isWithinActiveHours(windows, now)).toBe(false);
  });

  it("24時超のto（翌日への継続）を扱える（例：19:00〜26:00＝翌02:00まで）", () => {
    const windows = [{ days: ["mon"], from: "19:00", to: "26:00" }];
    // JST火曜01:00 = UTC月曜16:00
    const now = new Date("2026-01-05T16:00:00Z");
    expect(isWithinActiveHours(windows, now)).toBe(true);
  });
});

describe("isWithinDailyWindow（督促の静穏時間・§4.7）", () => {
  it("日をまたぐ区間（23:00〜08:00）を判定できる", () => {
    // JST 00:30 = UTC前日15:30
    const now = new Date("2026-01-04T15:30:00Z");
    expect(isWithinDailyWindow("23:00", "08:00", now)).toBe(true);
  });
  it("区間外はfalse", () => {
    // JST 12:00 = UTC 03:00
    const now = new Date("2026-01-05T03:00:00Z");
    expect(isWithinDailyWindow("23:00", "08:00", now)).toBe(false);
  });
});
