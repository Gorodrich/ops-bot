// llm/prefilter.ts の単体テスト（§7.2：前処理フィルタ）。

import { describe, expect, it } from "vitest";
import { passesPrefilter, filterMessages } from "../src/llm/prefilter";

const msg = (overrides = {}) => ({
  id: "1",
  content: "テストメッセージです",
  authorId: "111",
  authorIsBot: false,
  ...overrides,
});

describe("passesPrefilter", () => {
  it("Botの発言を除外する", () => {
    expect(passesPrefilter(msg({ authorIsBot: true }), { minChars: 1, coarseFilterPatterns: [] })).toBe(false);
  });

  it("空の本文（添付・リアクションのみ）を除外する", () => {
    expect(passesPrefilter(msg({ content: "   " }), { minChars: 1, coarseFilterPatterns: [] })).toBe(false);
  });

  it("絵文字のみのスタンプ相当を除外する", () => {
    expect(passesPrefilter(msg({ content: "👍👍" }), { minChars: 1, coarseFilterPatterns: [] })).toBe(false);
  });

  it("一定文字数未満を除外する", () => {
    expect(passesPrefilter(msg({ content: "了解" }), { minChars: 8, coarseFilterPatterns: [] })).toBe(false);
  });

  it("既にタスク化済みメッセージへの返信スレッドを除外する", () => {
    expect(
      passesPrefilter(msg({ id: "42" }), {
        minChars: 1,
        coarseFilterPatterns: [],
        alreadyDetectedMessageIds: new Set(["42"]),
      }),
    ).toBe(false);
  });

  it("キーワード要件が空なら文字数のみで通過させる（ticketチャンネル想定）", () => {
    expect(passesPrefilter(msg({ content: "とても長い問い合わせ本文です" }), { minChars: 1, coarseFilterPatterns: [] })).toBe(true);
  });

  it("キーワードに一致すれば通過する", () => {
    expect(
      passesPrefilter(msg({ content: "この件について困っています、助けてください" }), {
        minChars: 1,
        coarseFilterPatterns: ["困って|助けて"],
      }),
    ).toBe(true);
  });

  it("キーワードに一致しなければ除外する", () => {
    expect(
      passesPrefilter(msg({ content: "今日は天気がいいですね" }), {
        minChars: 1,
        coarseFilterPatterns: ["困って|助けて"],
      }),
    ).toBe(false);
  });
});

describe("filterMessages", () => {
  it("複数メッセージのうち通過分のみ返す", () => {
    const messages = [msg({ id: "1", content: "困っています助けて" }), msg({ id: "2", authorIsBot: true })];
    const result = filterMessages(messages, { minChars: 1, coarseFilterPatterns: [] });
    expect(result.map((m) => m.id)).toEqual(["1"]);
  });
});
