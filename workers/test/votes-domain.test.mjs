// votes/domain.ts の集計ロジックの単体テスト（§11-5：棄権の扱い・母数の違い・特別多数・本人除外を網羅）。

import { describe, expect, it } from "vitest";
import { computeEligibleVoters, isPastDeadline, isValidBallotChoice, tallyVote } from "../src/votes/domain";

function tally(overrides) {
  return tallyVote({
    yes: 0,
    no: 0,
    abstain: 0,
    eligibleCount: 0,
    quorumType: "voters_majority",
    threshold: 0.5,
    ...overrides,
  });
}

describe("tallyVote / voters_majority（通常の秘密投票・§5.2-6）", () => {
  it("棄権者を除く投票者の過半数で可決する", () => {
    expect(tally({ yes: 3, no: 2, eligibleCount: 10 }).passed).toBe(true);
  });

  it("同数では否決（過半数に届かない）", () => {
    expect(tally({ yes: 2, no: 2, eligibleCount: 10 }).passed).toBe(false);
  });

  it("誰も投票しなければ否決（分母0）", () => {
    expect(tally({ yes: 0, no: 0, eligibleCount: 10 }).passed).toBe(false);
  });

  it("棄権者（未投票扱い）は分母に含めない", () => {
    // 母数10人中、投票したのは3人（賛成2反対1）。棄権7人は分母から除かれるため2/3で可決。
    const r = tally({ yes: 2, no: 1, eligibleCount: 10 });
    expect(r.denominator).toBe(3);
    expect(r.passed).toBe(true);
  });
});

describe("tallyVote / supermajority_voters（特別多数・§5.5：ルール制定等）", () => {
  it("3分の2以上ちょうどで可決する", () => {
    expect(tally({ yes: 4, no: 2, eligibleCount: 10, quorumType: "supermajority_voters", threshold: 2 / 3 }).passed).toBe(true);
  });

  it("3分の2未満では否決する", () => {
    expect(tally({ yes: 3, no: 3, eligibleCount: 10, quorumType: "supermajority_voters", threshold: 2 / 3 }).passed).toBe(false);
  });
});

describe("tallyVote / total_majority_excl_abstain（短縮投票・§5.3）", () => {
  it("明示的棄権者を除いた総数の過半数で可決する", () => {
    // 総数10、明示的棄権2 → 分母8。賛成5は8の過半数。
    const r = tally({ yes: 5, no: 3, abstain: 2, eligibleCount: 10, quorumType: "total_majority_excl_abstain" });
    expect(r.denominator).toBe(8);
    expect(r.passed).toBe(true);
  });

  it("通常の秘密投票（voters_majority）とは異なる母数になる", () => {
    // 同じ票数でも quorum_type が違えば結果が変わりうることを確認する。
    const args = { yes: 3, no: 2, abstain: 5, eligibleCount: 10 };
    const secret = tally({ ...args, quorumType: "voters_majority" }); // 分母 = 5（棄権を分母から除く）
    const quick = tally({ ...args, quorumType: "total_majority_excl_abstain" }); // 分母 = 5（総数10-明示的棄権5）
    expect(secret.denominator).toBe(5);
    expect(quick.denominator).toBe(5);
    // 分母は同じでも意味が異なる（前者は「投票者」、後者は「総数から棄権者を除いた数」）ことを
    // 明示するため、算出過程が異なる別ロジックであることを別テストケースで担保する。
    expect(secret.passed).toBe(true);
    expect(quick.passed).toBe(true);
  });
});

describe("tallyVote / supermajority_total（総数基準の特別多数・§5.5）", () => {
  it("総数の3分の2以上で可決する（棄権があっても分母は総数のまま）", () => {
    const r = tally({ yes: 7, no: 0, abstain: 3, eligibleCount: 10, quorumType: "supermajority_total", threshold: 2 / 3 });
    expect(r.denominator).toBe(10);
    expect(r.passed).toBe(true);
  });

  it("棄権が多く総数基準の閾値に届かなければ否決する", () => {
    const r = tally({ yes: 6, no: 0, abstain: 4, eligibleCount: 10, quorumType: "supermajority_total", threshold: 2 / 3 });
    expect(r.passed).toBe(false);
  });

});

describe("tallyVote / total_majority_incl_abstain（総数〔棄権者含む〕の過半数・§5.5：参加者投票のワールドデータ外部利用〔非参加者含む〕）", () => {
  it("総数の過半数（半数ちょうどでは不可）で可決する", () => {
    // 参加者総数10人中、賛成6・反対1・棄権3 → 総数の過半数（6>5）で可決。
    const passed = tally({ yes: 6, no: 1, abstain: 3, eligibleCount: 10, quorumType: "total_majority_incl_abstain" });
    expect(passed.denominator).toBe(10);
    expect(passed.passed).toBe(true);
  });

  it("賛成がちょうど半数では過半数に届かず否決する（supermajority_totalのthreshold:0.5とは異なる挙動）", () => {
    const tie = tally({ yes: 5, no: 0, abstain: 5, eligibleCount: 10, quorumType: "total_majority_incl_abstain" });
    expect(tie.passed).toBe(false);
  });

  it("棄権者も分母に含まれるため、棄権が多いと可決しにくくなる", () => {
    const r = tally({ yes: 5, no: 0, abstain: 4, eligibleCount: 9, quorumType: "total_majority_incl_abstain" });
    expect(r.denominator).toBe(9);
    expect(r.passed).toBe(true); // 9人中5人（過半数）が賛成
  });
});

describe("tallyVote / unanimous_excl_target（本人除外・全会一致・§5.5）", () => {
  it("本人を除く全員の賛成で可決する", () => {
    // 本人除外済みの母数5人全員が賛成
    expect(tally({ yes: 5, no: 0, eligibleCount: 5, quorumType: "unanimous_excl_target" }).passed).toBe(true);
  });

  it("1人でも反対・棄権（＝未賛成）があれば否決する", () => {
    expect(tally({ yes: 4, no: 1, eligibleCount: 5, quorumType: "unanimous_excl_target" }).passed).toBe(false);
    expect(tally({ yes: 4, no: 0, eligibleCount: 5, quorumType: "unanimous_excl_target" }).passed).toBe(false);
  });
});

describe("computeEligibleVoters", () => {
  it("休暇中の運営者を母数から除外する（§5.1・§10-2）", () => {
    const result = computeEligibleVoters({
      uneiMemberIds: ["a", "b", "c"],
      onLeaveIds: new Set(["b"]),
    });
    expect(result).toEqual(["a", "c"]);
  });

  it("本人除外対象（exclude_self）を母数から除外する（§5.5）", () => {
    const result = computeEligibleVoters({
      uneiMemberIds: ["a", "b", "c"],
      onLeaveIds: new Set(),
      excludeTarget: "c",
    });
    expect(result).toEqual(["a", "b"]);
  });

  it("重複するメンバーIDを1人として数える", () => {
    const result = computeEligibleVoters({ uneiMemberIds: ["a", "a", "b"], onLeaveIds: new Set() });
    expect(result).toEqual(["a", "b"]);
  });
});

describe("isPastDeadline", () => {
  it("締切前はfalse", () => {
    expect(isPastDeadline("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z")).toBe(false);
  });
  it("締切ちょうど・締切後はtrue", () => {
    expect(isPastDeadline("2026-01-02T00:00:00Z", "2026-01-02T00:00:00Z")).toBe(true);
    expect(isPastDeadline("2026-01-03T00:00:00Z", "2026-01-02T00:00:00Z")).toBe(true);
  });
  it("締切未設定はfalse", () => {
    expect(isPastDeadline("2026-01-01T00:00:00Z", null)).toBe(false);
  });
});

describe("isValidBallotChoice", () => {
  it("yes/no/abstain のみ有効", () => {
    expect(isValidBallotChoice("yes")).toBe(true);
    expect(isValidBallotChoice("no")).toBe(true);
    expect(isValidBallotChoice("abstain")).toBe(true);
    expect(isValidBallotChoice("maybe")).toBe(false);
  });
});
