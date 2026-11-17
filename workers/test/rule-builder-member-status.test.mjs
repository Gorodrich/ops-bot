// rule-builder のログイン判定（getMemberStatus・decisions.md #67）。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, mockFetch, setSetting } from "./helpers/d1.mjs";
import { avatarUrlOf, displayNameOf, getMemberStatus } from "../src/ruleBuilder/memberStatus";
import { confirmLink, upsertPendingLink } from "../src/staff/subaccountRepo";

const ROLES = { hito: "R_HITO", kari_sanka: "R_KARI", sub_aka: "R_SUB", unei: "R_UNEI", unei_sub: "R_UNEI_SUB" };
const GUILD = "G1";
const MAIN = "100000000000000001";
const SUB = "100000000000000002";
const OTHER = "100000000000000003";

function json(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("getMemberStatus", () => {
  let env;
  let fetchMock;
  let members;

  beforeEach(() => {
    env = createTestEnv();
    setSetting(env, "roles", ROLES);
    setSetting(env, "discord_guild_id", GUILD);
    members = {
      [MAIN]: { user: { id: MAIN, username: "main", global_name: "メイン", avatar: "abc" }, roles: ["R_UNEI"], nick: null, avatar: null },
      [SUB]: { user: { id: SUB, username: "sub", global_name: null, avatar: null }, roles: ["R_UNEI_SUB"], nick: "サブ" },
      [OTHER]: { user: { id: OTHER, username: "other" }, roles: ["R_HITO"] },
    };
    fetchMock = mockFetch((url) => {
      const m = url.match(/\/guilds\/G1\/members\/(\d+)$/);
      if (!m) return undefined;
      const member = members[m[1]];
      return member ? json(member) : new Response("not found", { status: 404 });
    });
  });

  afterEach(() => fetchMock.restore());

  it("運営ロールを持つ人は運営者として返す", async () => {
    const res = await getMemberStatus(env, MAIN);
    expect(res).toEqual({
      isUnei: true,
      onLeave: false,
      userId: MAIN,
      viaSubaccount: false,
      displayName: "メイン",
      avatarUrl: `https://cdn.discordapp.com/avatars/${MAIN}/abc.png?size=64`,
    });
  });

  it("運営ロールがなければ運営者として扱わない", async () => {
    const res = await getMemberStatus(env, OTHER);
    expect(res.isUnei).toBe(false);
    expect(res.userId).toBe(OTHER);
    expect(res.displayName).toBe("other");
  });

  it("ギルドにいなければ運営者として扱わない", async () => {
    const res = await getMemberStatus(env, "100000000000000009");
    expect(res).toMatchObject({ isUnei: false, displayName: "", avatarUrl: null });
  });

  it("休暇中なら onLeave を返す", async () => {
    env.DB.raw
      .prepare("INSERT INTO staff (discord_id, display_name, on_leave_active, on_leave_until) VALUES (?, ?, 1, ?)")
      .run(MAIN, "main", "2999-01-01T00:00:00Z");
    const res = await getMemberStatus(env, MAIN);
    expect(res).toMatchObject({ isUnei: true, onLeave: true });
  });

  describe("サブ垢", () => {
    it("連携済みのサブ垢はメイン垢として返す（表示名・アイコンもメイン垢）", async () => {
      await upsertPendingLink(env, { subDiscordId: SUB, mainDiscordId: MAIN, expiresAt: "2999-01-01T00:00:00Z", createdBy: MAIN });
      await confirmLink(env, SUB);
      const res = await getMemberStatus(env, SUB);
      expect(res).toMatchObject({ isUnei: true, userId: MAIN, viaSubaccount: true, displayName: "メイン" });
    });

    it("休暇の判定もメイン垢で行う", async () => {
      await upsertPendingLink(env, { subDiscordId: SUB, mainDiscordId: MAIN, expiresAt: "2999-01-01T00:00:00Z", createdBy: MAIN });
      await confirmLink(env, SUB);
      env.DB.raw
        .prepare("INSERT INTO staff (discord_id, display_name, on_leave_active) VALUES (?, ?, 1)")
        .run(MAIN, "main");
      expect((await getMemberStatus(env, SUB)).onLeave).toBe(true);
    });

    it("未連携のサブ垢は運営者として扱わない", async () => {
      const res = await getMemberStatus(env, SUB);
      expect(res).toMatchObject({ isUnei: false, userId: SUB, viaSubaccount: false });
    });

    it("メイン垢が運営ロールを失っていれば運営者として扱わない", async () => {
      await upsertPendingLink(env, { subDiscordId: SUB, mainDiscordId: MAIN, expiresAt: "2999-01-01T00:00:00Z", createdBy: MAIN });
      await confirmLink(env, SUB);
      members[MAIN].roles = ["R_HITO"];
      expect((await getMemberStatus(env, SUB)).isUnei).toBe(false);
    });
  });

  it("Discord API が失敗したら例外を投げる（rule-builder 側でログインを断る）", async () => {
    fetchMock.restore();
    fetchMock = mockFetch(() => new Response("error", { status: 500 }));
    await expect(getMemberStatus(env, MAIN)).rejects.toThrow();
  });

  it("ID の形式でなければ Discord API を呼ばずに例外を投げる", async () => {
    await expect(getMemberStatus(env, "../users/@me")).rejects.toThrow();
    expect(fetchMock.calls).toHaveLength(0);
  });
});

describe("表示名・アイコン", () => {
  it("ニックネーム → 表示名 → ユーザー名の順に使う", () => {
    expect(displayNameOf({ user: { id: MAIN, username: "u", global_name: "g" }, roles: [], nick: "n" })).toBe("n");
    expect(displayNameOf({ user: { id: MAIN, username: "u", global_name: "g" }, roles: [] })).toBe("g");
    expect(displayNameOf({ user: { id: MAIN, username: "u" }, roles: [] })).toBe("u");
  });

  it("サーバー別のアイコン → 本人のアイコン → 既定のアイコンの順に使う", () => {
    const user = { id: MAIN, username: "u", avatar: "ua" };
    expect(avatarUrlOf({ user, roles: [], avatar: "ga" }, GUILD)).toBe(
      `https://cdn.discordapp.com/guilds/${GUILD}/users/${MAIN}/avatars/ga.png?size=64`,
    );
    expect(avatarUrlOf({ user, roles: [] }, GUILD)).toBe(`https://cdn.discordapp.com/avatars/${MAIN}/ua.png?size=64`);
    expect(avatarUrlOf({ user: { id: MAIN, username: "u" }, roles: [] }, GUILD)).toMatch(
      /^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/[0-5]\.png$/,
    );
  });
});
