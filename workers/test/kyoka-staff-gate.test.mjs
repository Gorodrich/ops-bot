// /kyoka の実行資格の回帰テスト（監査指摘：運営ロールを持たないメンバーでも記名許可要請を作成できる）。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, mockFetch, setSetting } from "./helpers/d1.mjs";
import { handleKyoka } from "../src/permissions/kyokaCommand";
import { handleUmetate } from "../src/permissions/umetateCommand";

const ROLES = { hito: "R_HITO", kari_sanka: "R_KARI", sub_aka: "R_SUB", unei: "R_UNEI", unei_sub: "R_UNEI_SUB" };
const OPTIONS = [
  { name: "kind", type: 3, value: "technician_beneficial_command" },
  { name: "subject", type: 3, value: "dummy" },
];

function count(env, table) {
  return env.DB.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

describe("/kyoka の実行資格", () => {
  let env;
  let fetchMock;

  beforeEach(() => {
    env = createTestEnv();
    setSetting(env, "roles", ROLES);
    setSetting(env, "channels", { unei_only: "CH_UNEI" });
    setSetting(env, "approval_types", {
      technician_beneficial_command: { label: "技術者コマンド", method: "B", required_count: 3, exclude_self: false },
      land_reclamation: { label: "海の埋立て", method: "B", required_count: 2, exclude_self: false },
    });
    fetchMock = mockFetch();
  });

  afterEach(() => fetchMock.restore());

  it("運営ロールを持たないメンバーは即座に拒否され、何も書き込まれない", async () => {
    const interaction = { token: "t", member: { user: { id: "PLAIN" }, roles: [] } };
    const res = await handleKyoka(env, interaction, OPTIONS);
    expect(res.ack.type).toBe(4);
    expect(res.ack.data.content).toBe("このコマンドは運営者のみ実行できます。");
    await res.followUp();
    expect(count(env, "permission_requests")).toBe(0);
    expect(count(env, "tasks")).toBe(0);
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("運営者は要請を作成できる", async () => {
    const interaction = { token: "t", member: { user: { id: "STAFF" }, roles: ["R_UNEI"] } };
    const res = await handleKyoka(env, interaction, OPTIONS);
    expect(res.ack.type).toBe(5);
    await res.followUp();
    expect(count(env, "permission_requests")).toBe(1);
  });

  it("/umetate は従来どおり誰でも要請を作成できる", async () => {
    const interaction = {
      token: "t",
      member: { user: { id: "PLAIN" }, roles: [] },
    };
    const res = await handleUmetate(env, interaction, [{ name: "description", type: 3, value: "ここを埋め立てたい" }]);
    expect(res.ack.type).toBe(5);
  });
});
