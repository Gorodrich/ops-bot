// resolveUneiActor の回帰テスト（監査指摘：降格したメイン垢の権限がサブ垢経由で残る）。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, mockFetch, setSetting } from "./helpers/d1.mjs";
import { resolveUneiActor } from "../src/staff/subaccountEligibility";
import { confirmLink, upsertPendingLink } from "../src/staff/subaccountRepo";

const ROLES = { hito: "R_HITO", kari_sanka: "R_KARI", sub_aka: "R_SUB", unei: "R_UNEI", unei_sub: "R_UNEI_SUB" };

function memberResponse(roles) {
  return new Response(JSON.stringify({ user: { id: "MAIN_1", username: "main" }, roles }), { status: 200 });
}

describe("resolveUneiActor（サブ垢経由）", () => {
  let env;
  let fetchMock;
  let mainRoles;

  beforeEach(async () => {
    env = createTestEnv();
    setSetting(env, "roles", ROLES);
    setSetting(env, "discord_guild_id", "G1");
    await upsertPendingLink(env, { subDiscordId: "SUB_1", mainDiscordId: "MAIN_1", expiresAt: "2999-01-01T00:00:00Z", createdBy: "MAIN_1" });
    await confirmLink(env, "SUB_1");
    mainRoles = ["R_UNEI"];
    fetchMock = mockFetch((url) => {
      if (url.endsWith("/guilds/G1/members/MAIN_1")) {
        return mainRoles === null ? new Response("not found", { status: 404 }) : memberResponse(mainRoles);
      }
    });
  });

  afterEach(() => fetchMock.restore());

  const sub = { user: { id: "SUB_1" }, roles: ["R_UNEI_SUB"] };

  it("メイン垢が運営ロールを保持していればメイン垢として実行できる", async () => {
    const res = await resolveUneiActor(env, sub);
    expect(res).toEqual({ ok: true, actorId: "MAIN_1", viaSubaccount: true, rawActorId: "SUB_1" });
  });

  it("メイン垢が降格（運営ロール喪失）していれば拒否する", async () => {
    mainRoles = ["R_HITO"];
    const res = await resolveUneiActor(env, sub);
    expect(res.ok).toBe(false);
  });

  it("メイン垢がギルドを脱退していれば拒否する", async () => {
    mainRoles = null;
    const res = await resolveUneiActor(env, sub);
    expect(res.ok).toBe(false);
  });

  it("メイン垢の確認でDiscord APIが失敗した場合も拒否する（fail closed）", async () => {
    fetchMock.restore();
    fetchMock = mockFetch(() => new Response("error", { status: 500 }));
    const res = await resolveUneiActor(env, sub);
    expect(res.ok).toBe(false);
  });

  it("運営ロールを直接持つ場合はDiscord APIを呼ばない", async () => {
    const res = await resolveUneiActor(env, { user: { id: "MAIN_1" }, roles: ["R_UNEI"] });
    expect(res).toEqual({ ok: true, actorId: "MAIN_1", viaSubaccount: false, rawActorId: "MAIN_1" });
    expect(fetchMock.calls).toHaveLength(0);
  });
});
