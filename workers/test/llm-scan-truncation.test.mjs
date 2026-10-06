// LLMメッセージスキャンの回帰テスト
// （監査指摘：1ジョブの上限で切り捨てる前に全チャンネルのカーソルを進めるため、
//   先に開設された1つのチケットへの大量投稿で、他チャンネルのメッセージが検出対象から永久に漏れる）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestEnv, mockFetch, patchSetting, setSetting } from "./helpers/d1.mjs";
import { runLlmMessageScan } from "../src/llm/messageScan";

let nextId = 5000n;
function post(store, channelId, authorId, content) {
  const id = String(nextId++);
  store[channelId].push({ id, content, author: { id: authorId }, channel_id: channelId });
  return id;
}

function jobBatches(env) {
  return env.DB.raw
    .prepare("SELECT payload FROM job_queue WHERE kind = 'claude_code' ORDER BY id")
    .all()
    .map((r) => JSON.parse(r.payload).messages.map((m) => m.source_message_url.split("/").pop()));
}

describe("LLMメッセージスキャンの上限超過時の繰り越し", () => {
  let env;
  let fetchMock;
  let store;
  let clock;

  async function scan() {
    clock += 31 * 60 * 1000; // scan_interval_sec(1800) を超えて進める
    vi.setSystemTime(new Date(clock));
    await runLlmMessageScan(env);
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clock = Date.parse("2026-10-01T00:00:00Z");
    vi.setSystemTime(new Date(clock));
    env = createTestEnv();
    setSetting(env, "discord_guild_id", "G1");
    setSetting(env, "channels", { unei_only: "C_OPS" });
    patchSetting(env, "llm", { paused: false, min_message_chars: 8, coarse_filter_patterns: [], scan_interval_sec: 1800 });

    // 先に開設された攻撃者のチケット → 後から開設された被害者のチケット
    env.DB.raw.prepare("INSERT INTO monitored_channels (channel_id, kind, status) VALUES ('T_ATTACKER', 'ticket', 'open')").run();
    env.DB.raw.prepare("INSERT INTO monitored_channels (channel_id, kind, status) VALUES ('T_VICTIM', 'ticket', 'open')").run();
    env.DB.raw.prepare("INSERT INTO cursors (channel_id, last_message_id, purpose, updated_at) VALUES ('C_OPS', '1', 'message_diff', '2026-01-01T00:00:00Z')").run();

    store = { C_OPS: [], T_ATTACKER: [], T_VICTIM: [] };
    fetchMock = mockFetch((url) => {
      const m = url.match(/\/channels\/(\w+)\/messages\?(.*)$/);
      if (!m) return undefined;
      const after = new URLSearchParams(m[2]).get("after");
      const page = store[m[1]]
        .filter((msg) => !after || BigInt(msg.id) > BigInt(after))
        .slice(0, 100)
        .reverse(); // Discordは新しい順で返す
      return new Response(JSON.stringify(page), { status: 200 });
    });
  });

  afterEach(() => {
    fetchMock.restore();
    vi.useRealTimers();
  });

  it("1チケットの大量投稿があっても他チケットのメッセージは同じスキャンでジョブに含まれる", async () => {
    for (let i = 0; i < 60; i++) post(store, "T_ATTACKER", "u_attacker", `filler message number ${i}`);
    const victimMsg = post(store, "T_VICTIM", "u_victim", "助けてください、整地をお願いしたいです");

    await scan();

    const [first] = jobBatches(env);
    expect(first).toHaveLength(50);
    expect(first).toContain(victimMsg);
  });

  it("上限を超えた分は捨てずに次回スキャンへ繰り越され、重複なく全件が一度ずつ送られる", async () => {
    const attackerIds = [];
    for (let i = 0; i < 60; i++) attackerIds.push(post(store, "T_ATTACKER", "u_attacker", `filler message number ${i}`));
    const victimMsg = post(store, "T_VICTIM", "u_victim", "助けてください、整地をお願いしたいです");

    await scan();
    await scan();
    await scan();

    const sent = jobBatches(env).flat();
    expect(new Set(sent).size).toBe(sent.length);
    expect(new Set(sent)).toEqual(new Set([...attackerIds, victimMsg]));
  });

  it("上限内なら従来どおり1ジョブで全件を送り、カーソルは最新まで進む", async () => {
    post(store, "T_ATTACKER", "u_attacker", "filler message number 0");
    const victimMsg = post(store, "T_VICTIM", "u_victim", "助けてください、整地をお願いしたいです");

    await scan();
    await scan();

    const batches = jobBatches(env);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toContain(victimMsg);
  });
});
