// kaihatsu/domain.ts の純粋関数の単体テスト（§11-5：面積・重複判定に関わるロジックのテスト）。

import { describe, expect, it } from "vitest";
import {
  addHoursIso,
  bboxMayOverlap,
  decomposeApplication,
  isPastDeadline,
  orderGroupMembersForEvaluation,
  playerNameFromFilename,
  resolveGroup,
  unionZoneBBoxFromFilenames,
} from "../src/kaihatsu/domain";

describe("decomposeApplication", () => {
  it("初めての届出は「設定」のみ", () => {
    expect(decomposeApplication({ hadPreviousClaim: false, addedPixels: 100, removedPixels: 0 })).toEqual(["setting"]);
  });

  it("拡大のみ（削除なし）は「変更」のみ", () => {
    expect(decomposeApplication({ hadPreviousClaim: true, addedPixels: 50, removedPixels: 0 })).toEqual(["change"]);
  });

  it("縮小のみ（追加なし）は「一部削除」のみ", () => {
    expect(decomposeApplication({ hadPreviousClaim: true, addedPixels: 0, removedPixels: 50 })).toEqual(["partial_delete"]);
  });

  it("拡大と縮小が同時に発生する場合は両方を明記する", () => {
    expect(decomposeApplication({ hadPreviousClaim: true, addedPixels: 50, removedPixels: 30 })).toEqual([
      "change",
      "partial_delete",
    ]);
  });

  it("従前と全く同じ範囲を再宣言した場合も「変更」として記録する", () => {
    expect(decomposeApplication({ hadPreviousClaim: true, addedPixels: 0, removedPixels: 0 })).toEqual(["change"]);
  });
});

describe("bboxMayOverlap", () => {
  it("交差する矩形はtrue", () => {
    expect(bboxMayOverlap({ x1: 0, z1: 0, x2: 10, z2: 10 }, { x1: 5, z1: 5, x2: 15, z2: 15 })).toBe(true);
  });

  it("交差しない矩形はfalse", () => {
    expect(bboxMayOverlap({ x1: 0, z1: 0, x2: 10, z2: 10 }, { x1: 10, z1: 10, x2: 20, z2: 20 })).toBe(false);
  });

  it("接するだけ（境界共有）はfalse（x2/z2はexclusive）", () => {
    expect(bboxMayOverlap({ x1: 0, z1: 0, x2: 10, z2: 10 }, { x1: 10, z1: 0, x2: 20, z2: 10 })).toBe(false);
  });
});

describe("unionZoneBBoxFromFilenames", () => {
  it("単一ゾーンのbboxを返す", () => {
    const bbox = unionZoneBBoxFromFilenames(["01_alice.png"]);
    expect(bbox).toEqual({ x1: -10000, z1: -10000, x2: -5000, z2: -5000 });
  });

  it("複数ゾーンの和集合bboxを返す（01と16は対角）", () => {
    const bbox = unionZoneBBoxFromFilenames(["01_alice.png", "16_alice.png"]);
    expect(bbox).toEqual({ x1: -10000, z1: -10000, x2: 10000, z2: 10000 });
  });

  it("解析できないファイル名は無視する", () => {
    expect(unionZoneBBoxFromFilenames(["not-a-valid-name.png"])).toBeNull();
  });
});

// ── Phase 3：期限計算・グループ原子性（§5.7.2〜§5.7.5・§9締切精度） ────────

describe("addHoursIso / isPastDeadline", () => {
  it("72時間後の絶対時刻を計算する（本人確認期限・§5.7.3）", () => {
    expect(addHoursIso("2026-01-01T00:00:00Z", 72)).toBe("2026-01-04T00:00:00Z");
  });

  it("24時間後の絶対時刻を計算する（撤回猶予・§5.7.2）", () => {
    expect(addHoursIso("2026-01-01T00:00:00Z", 24)).toBe("2026-01-02T00:00:00Z");
  });

  it("締切ちょうどは経過済みとして扱う（発火間隔への依存を避ける・§9）", () => {
    expect(isPastDeadline("2026-01-02T00:00:00Z", "2026-01-02T00:00:00Z")).toBe(true);
  });

  it("締切前はfalse", () => {
    expect(isPastDeadline("2026-01-01T23:59:59Z", "2026-01-02T00:00:00Z")).toBe(false);
  });

  it("期限なし（null）は常にfalse", () => {
    expect(isPastDeadline("2026-01-02T00:00:00Z", null)).toBe(false);
  });
});

describe("playerNameFromFilename", () => {
  it("最初のアンダースコアのみで分割する（プレイヤー名にアンダースコアを含む場合）", () => {
    expect(playerNameFromFilename("06_Test_Player1.png")).toBe("Test_Player1");
  });

  it("大文字拡張子も受け付ける", () => {
    expect(playerNameFromFilename("01_alice.PNG")).toBe("alice");
  });

  it("ゾーン番号が2桁数字でなければnull", () => {
    expect(playerNameFromFilename("alice.png")).toBeNull();
    expect(playerNameFromFilename("1_alice.png")).toBeNull();
  });

  it("拡張子がpngでなければnull", () => {
    expect(playerNameFromFilename("06_alice.jpg")).toBeNull();
  });
});

describe("resolveGroup", () => {
  it("全員confirmedならapproved", () => {
    expect(resolveGroup([{ status: "confirmed" }, { status: "confirmed" }])).toBe("approved");
  });

  it("1人でもrejectedならグループ全体がrejected（部分成立させない・§5.7.4）", () => {
    expect(resolveGroup([{ status: "confirmed" }, { status: "rejected" }])).toBe("rejected");
  });

  it("1人でもwithdrawnならrejected", () => {
    expect(resolveGroup([{ status: "confirmed" }, { status: "withdrawn" }])).toBe("rejected");
  });

  it("1人でもexpiredならrejected", () => {
    expect(resolveGroup([{ status: "confirmed" }, { status: "expired" }])).toBe("rejected");
  });

  it("まだ全員揃っていなければwaiting", () => {
    expect(resolveGroup([{ status: "confirmed" }, { status: "provisional" }])).toBe("waiting");
  });

  it("メンバーが空ならwaiting", () => {
    expect(resolveGroup([])).toBe("waiting");
  });
});

describe("orderGroupMembersForEvaluation", () => {
  it("deleteをsetより先に並べる（§5.7.4：譲渡人の削除→譲受人の設定の順で評価）", () => {
    const members = [
      { op: "set", id: "receiver" },
      { op: "delete", id: "giver" },
    ];
    expect(orderGroupMembersForEvaluation(members).map((m) => m.id)).toEqual(["giver", "receiver"]);
  });

  it("同じopの相対順序は維持する（安定ソート）", () => {
    const members = [
      { op: "delete", id: "a" },
      { op: "delete", id: "b" },
      { op: "set", id: "c" },
      { op: "set", id: "d" },
    ];
    expect(orderGroupMembersForEvaluation(members).map((m) => m.id)).toEqual(["a", "b", "c", "d"]);
  });
});
