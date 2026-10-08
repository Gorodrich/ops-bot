// Discord 送信の allowed_mentions の回帰テスト
// （監査指摘：参加者のチケット本文に由来するLLMのタスク名が運営チャンネルの本文に入り、
//   allowed_mentions 未指定のため @everyone・ロールメンションとして解釈されうる）。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ALLOWED_MENTIONS,
  editChannelMessage,
  neutralizeMentions,
  sendAnnouncementMessage,
  sendChannelMessage,
  sendChannelMessageWithComponents,
  sendChannelMessageWithFile,
  sendChannelMessageWithFileAndComponents,
  sendDirectMessage,
  sendDirectMessageWithComponents,
  sendDirectMessageWithComponentsAndFile,
  sendFollowupMessage,
} from "../src/discord/rest";
import { mockFetch } from "./helpers/d1.mjs";

const HOSTILE = "@everyone <@&111111111111111111> <@222222222222222222> 至急";
const FILE = { filename: "a.png", bytes: new Uint8Array([1, 2, 3]) };

async function bodyOf(call) {
  if (typeof call.body === "string") return JSON.parse(call.body);
  if (call.body instanceof FormData) return JSON.parse(await call.body.get("payload_json"));
  return null;
}

describe("allowed_mentions", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = mockFetch();
  });

  afterEach(() => fetchMock.restore());

  it("すべての送信・編集・フォローアップでユーザー以外のメンション解釈を無効化する", async () => {
    await sendChannelMessage("tok", "C", `【要対応】タスク「${HOSTILE}」`);
    await sendChannelMessageWithComponents("tok", "C", HOSTILE, []);
    await sendChannelMessageWithFile("tok", "C", HOSTILE, FILE);
    await sendChannelMessageWithFileAndComponents("tok", "C", HOSTILE, [], FILE);
    await editChannelMessage("tok", "C", "M", { content: HOSTILE });
    await sendDirectMessage("tok", "U", HOSTILE);
    await sendDirectMessageWithComponents("tok", "U", HOSTILE, []);
    await sendDirectMessageWithComponentsAndFile("tok", "U", HOSTILE, [], FILE);
    await sendFollowupMessage("app", "itok", { content: HOSTILE });

    const messageCalls = fetchMock.calls.filter((c) => !c.url.endsWith("/users/@me/channels"));
    expect(messageCalls).toHaveLength(9);
    for (const call of messageCalls) {
      const body = await bodyOf(call);
      expect(body.allowed_mentions, call.url).toEqual({ parse: ["users"] });
    }
    expect(DEFAULT_ALLOWED_MENTIONS.parse).not.toContain("everyone");
    expect(DEFAULT_ALLOWED_MENTIONS.parse).not.toContain("roles");
  });
});

describe("sendAnnouncementMessage（障害の全般用お知らせ・唯一の例外）", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = mockFetch();
  });

  afterEach(() => fetchMock.restore());

  it("@everyone は指定時のみ解釈させ、ロール・ユーザーのメンションはどちらでも解釈させない", async () => {
    await sendAnnouncementMessage("tok", "C", HOSTILE, true);
    await sendAnnouncementMessage("tok", "C", HOSTILE, false);
    const [on, off] = await Promise.all(fetchMock.calls.map(bodyOf));
    expect(on.allowed_mentions).toEqual({ parse: ["everyone"] });
    expect(off.allowed_mentions).toEqual({ parse: [] });
  });
});

describe("neutralizeMentions", () => {
  it("@everyone・@here・ユーザー／ロールメンションをメンションとして解釈されない形にする", () => {
    const out = neutralizeMentions(HOSTILE);
    expect(out).not.toMatch(/@everyone|@here/);
    expect(out).not.toContain("<@");
    expect(out.replace(/​/g, "")).toBe(HOSTILE);
  });

  it("メンション記法を含まない文字列はそのまま", () => {
    expect(neutralizeMentions("整地の依頼 user@example")).toBe("整地の依頼 user@example");
  });
});
