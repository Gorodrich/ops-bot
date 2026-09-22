// llm/mentions.ts の単体テスト（依頼者除外・優先候補ヒントの入力となるメンション抽出・decisions.md #65是正）。

import { describe, expect, it } from "vitest";
import { extractMentionedDiscordIds } from "../src/llm/mentions";

describe("extractMentionedDiscordIds", () => {
  it("通常のメンション <@ID> を抽出する", () => {
    expect(extractMentionedDiscordIds("<@123456789012345678> お願いします")).toEqual(["123456789012345678"]);
  });

  it("ニックネーム付きメンション <@!ID> も抽出する", () => {
    expect(extractMentionedDiscordIds("<@!987654321098765432> よろしく")).toEqual(["987654321098765432"]);
  });

  it("複数メンションを重複除去して抽出する", () => {
    expect(extractMentionedDiscordIds("<@111> と <@222> にお願い、再掲：<@111>")).toEqual(["111", "222"]);
  });

  it("メンションが無い本文では空配列を返す", () => {
    expect(extractMentionedDiscordIds("これはメンションを含まないメッセージです")).toEqual([]);
  });
});
