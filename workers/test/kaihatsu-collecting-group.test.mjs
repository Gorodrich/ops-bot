// 受付中（collecting）の同時処理グループの回帰テスト
// （監査指摘：他者が受付中グループに追加した届出が、対象者の /kaihatsu set を無期限に塞ぐ）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestEnv, mockFetch } from "./helpers/d1.mjs";
import { handleKaihatsuSet } from "../src/kaihatsu/setCommand";
import { handleKaihatsuConfirmComponent } from "../src/kaihatsu/confirmCommand";
import { processPhase3Deadlines } from "../src/cron/phase3Deadlines";
import { getGroup, hasOpenApplication } from "../src/kaihatsu/repo";

function link(env, uuid, name, discordId) {
  env.DB.raw
    .prepare("INSERT INTO account_links (minecraft_uuid, minecraft_name, discord_id, status, linked_by) VALUES (?, ?, ?, 'active', 'self')")
    .run(uuid, name, discordId);
}

function setInteraction(actorId, filename, group) {
  const options = [{ name: "image1", type: 11, value: "att1" }];
  if (group) options.push({ name: "group", type: 3, value: group });
  return {
    interaction: {
      token: "tok",
      member: { user: { id: actorId }, roles: [] },
      data: { resolved: { attachments: { att1: { id: "att1", filename, url: `https://cdn.example/${filename}` } } } },
    },
    options,
  };
}

function appRow(env, id) {
  return env.DB.raw.prepare("SELECT * FROM applications WHERE id = ?").get(id);
}

describe("受付中グループへの第三者追加", () => {
  let env;
  let fetchMock;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    env = createTestEnv();
    link(env, "uuid-attacker", "Attacker", "d-attacker");
    link(env, "uuid-victim", "VictimMC", "d-victim");
    fetchMock = mockFetch();
  });

  afterEach(() => {
    fetchMock.restore();
    vi.useRealTimers();
  });

  async function attackerAddsVictim() {
    const { interaction, options } = setInteraction("d-attacker", "01_VictimMC.png", "grief-1");
    const res = await handleKaihatsuSet(env, interaction, options);
    await res.followUp();
    return env.DB.raw.prepare("SELECT id FROM applications WHERE requester = 'd-victim'").get().id;
  }

  it("追加された本人に取り下げボタン付きのDMが送られる", async () => {
    const appId = await attackerAddsVictim();
    const dmPosts = fetchMock.calls.filter((c) => c.method === "POST" && /\/channels\/\d+\/messages$/.test(c.url));
    expect(dmPosts).toHaveLength(1);
    expect(dmPosts[0].body).toContain(`kaihatsu:withdraw:${appId}`);
    expect(dmPosts[0].body).not.toContain("kaihatsu:confirm:");
  });

  it("本人は受付中の届出を取り下げられ、グループは却下されロックが解ける", async () => {
    const appId = await attackerAddsVictim();
    expect(await hasOpenApplication(env, "uuid-victim")).toBe(true);

    const res = await handleKaihatsuConfirmComponent(env, { user: { id: "d-victim" }, data: { custom_id: `kaihatsu:withdraw:${appId}` } });
    expect(res.ack.data.content).toBe("取り下げました。");
    await res.followUp();

    expect(appRow(env, appId).status).toBe("withdrawn");
    expect((await getGroup(env, "grief-1")).status).toBe("rejected");
    expect(await hasOpenApplication(env, "uuid-victim")).toBe(false);
  });

  it("本人以外は受付中の届出を取り下げられない", async () => {
    const appId = await attackerAddsVictim();
    const res = await handleKaihatsuConfirmComponent(env, { user: { id: "d-other" }, data: { custom_id: `kaihatsu:withdraw:${appId}` } });
    expect(res.ack.data.content).toBe("この本人確認はご自身宛てのものではありません。");
    expect(appRow(env, appId).status).toBe("collecting");
  });

  it("受付中のまま締め切られないグループは期限経過で失効し、ロックが解ける", async () => {
    const appId = await attackerAddsVictim();

    vi.setSystemTime(new Date("2026-10-03T23:59:00Z")); // 72時間未満
    await processPhase3Deadlines(env);
    expect(appRow(env, appId).status).toBe("collecting");

    vi.setSystemTime(new Date("2026-10-04T00:00:00Z")); // 作成から72時間
    await processPhase3Deadlines(env);
    expect(appRow(env, appId).status).toBe("expired");
    expect((await getGroup(env, "grief-1")).status).toBe("rejected");
    expect(await hasOpenApplication(env, "uuid-victim")).toBe(false);
  });

  it("同じグループの他の受付中メンバーもグループ却下に巻き込まれる", async () => {
    const victimApp = await attackerAddsVictim();
    const { interaction, options } = setInteraction("d-attacker", "01_Attacker.png", "grief-1");
    await (await handleKaihatsuSet(env, interaction, options)).followUp();
    const ownApp = env.DB.raw.prepare("SELECT id FROM applications WHERE requester = 'd-attacker'").get().id;

    const res = await handleKaihatsuConfirmComponent(env, { user: { id: "d-victim" }, data: { custom_id: `kaihatsu:withdraw:${victimApp}` } });
    await res.followUp();

    expect(appRow(env, ownApp).status).toBe("rejected");
    expect(await hasOpenApplication(env, "uuid-attacker")).toBe(false);
  });
});
