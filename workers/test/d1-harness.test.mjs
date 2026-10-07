// test/helpers/d1.mjs（D1シム）自体の動作確認。

import { describe, expect, it } from "vitest";
import { createTestEnv, setSetting } from "./helpers/d1.mjs";
import { getRoles } from "../src/settings";

describe("D1シム", () => {
  it("全マイグレーションが適用され settings を読める", async () => {
    const env = createTestEnv();
    setSetting(env, "roles", { hito: "R_HITO", kari_sanka: "R_KARI", sub_aka: "R_SUB", unei: "R_UNEI", unei_sub: "R_UNEI_SUB" });
    expect((await getRoles(env)).unei).toBe("R_UNEI");
  });

  it("run() は meta.changes を返す", async () => {
    const env = createTestEnv();
    setSetting(env, "x", 1);
    const res = await env.DB.prepare("UPDATE settings SET value = ? WHERE key = ?").bind("2", "x").run();
    expect(res.meta.changes).toBe(1);
    const none = await env.DB.prepare("UPDATE settings SET value = ? WHERE key = ?").bind("2", "missing").run();
    expect(none.meta.changes).toBe(0);
  });
});
