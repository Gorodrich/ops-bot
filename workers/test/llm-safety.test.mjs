// llm/safety.ts の単体テスト（開発者からの追加指示：staff.yaml notesの内容・評価の推察可能な
// 文言・マイナス評価を、運営・参加者向けの通知に一切含めない安全フィルタ）。

import { describe, expect, it } from "vitest";
import { sanitizePositiveNote } from "../src/llm/safety";

describe("sanitizePositiveNote", () => {
  it("null/undefinedはnullを返す", () => {
    expect(sanitizePositiveNote(null)).toBeNull();
    expect(sanitizePositiveNote(undefined)).toBeNull();
  });

  it("空文字列・空白のみはnullを返す", () => {
    expect(sanitizePositiveNote("")).toBeNull();
    expect(sanitizePositiveNote("   ")).toBeNull();
  });

  it("前向きな短い適性コメントはそのまま通す", () => {
    expect(sanitizePositiveNote("参加者対応の経験が豊富です")).toBe("参加者対応の経験が豊富です");
  });

  it("評価の出所を匂わせる語を含む場合は破棄する", () => {
    expect(sanitizePositiveNote("staff.yamlのnotesにこう書かれています")).toBeNull();
    expect(sanitizePositiveNote("プロファイルの評価によると得意")).toBeNull();
    expect(sanitizePositiveNote("メモにそう記載されている")).toBeNull();
  });

  it("マイナス評価・懸念を示す語を含む場合は破棄する（厳禁事項）", () => {
    expect(sanitizePositiveNote("この分野はやや苦手です")).toBeNull();
    expect(sanitizePositiveNote("対応に不安があります")).toBeNull();
    expect(sanitizePositiveNote("懸念点があります")).toBeNull();
    expect(sanitizePositiveNote("向いていない可能性があります")).toBeNull();
  });

  it("長すぎる自由記述は安全側に倒して破棄する", () => {
    expect(sanitizePositiveNote("あ".repeat(100))).toBeNull();
  });
});
