// 本人確認ボタンの同時操作の回帰テスト
// （監査指摘：同時に2回確認すると claim が二重登録され、運営の撤回後も片方が active のまま残る）。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, mockFetch } from "./helpers/d1.mjs";
import { handleKaihatsuConfirmComponent } from "../src/kaihatsu/confirmCommand";
import { finalizeApprovedSet } from "../src/kaihatsu/phase3";
import { insertApplication, markApplicationProvisional } from "../src/kaihatsu/repo";

const CT_RESULT = {
  outcome: "approved",
  reasons: [],
  area_blocks: 100,
  bbox: { x1: 0, z1: 0, x2: 10, z2: 10 },
  loc1: { x: 0, y: 64, z: 0 },
  loc2: { x: 9, y: 64, z: 9 },
  mask_saved_path: "/masks/alice.png",
  added_pixels: 100,
  removed_pixels: 0,
};

function activeClaims(env, uuid) {
  return env.DB.raw.prepare("SELECT id FROM claims WHERE owner_uuid = ? AND status = 'active'").all(uuid);
}

function appStatus(env, id) {
  return env.DB.raw.prepare("SELECT status FROM applications WHERE id = ?").get(id).status;
}

async function provisionalApplication(env) {
  const id = await insertApplication(env, {
    kind: "kaihatsu_set",
    requester: "u_alice",
    submittedBy: "u_rep",
    status: "processing",
    payload: {},
    ownerMcUuid: "uuid-alice",
    ownerMcName: "Alice",
    op: "set",
  });
  await markApplicationProvisional(env, id, {
    provisionalUntil: "2999-01-01T00:00:00Z",
    payload: { ctResult: CT_RESULT, previousClaimId: null },
  });
  return id;
}

function click(env, kind, id) {
  return handleKaihatsuConfirmComponent(env, { user: { id: "u_alice" }, data: { custom_id: `kaihatsu:${kind}:${id}` } });
}

describe("本人確認の同時操作", () => {
  let env;
  let fetchMock;

  beforeEach(() => {
    env = createTestEnv();
    fetchMock = mockFetch();
  });

  afterEach(() => fetchMock.restore());

  it("確認ボタンが同時に2回届いても claim は1件だけ登録される", async () => {
    const id = await provisionalApplication(env);
    const a = await click(env, "confirm", id);
    const b = await click(env, "confirm", id);
    expect(a.ack.data.content).toContain("確認を受け付けました");
    expect(b.ack.data.content).toContain("確認を受け付けました");

    await Promise.all([a.followUp(), b.followUp()]);

    expect(activeClaims(env, "uuid-alice")).toHaveLength(1);
    expect(appStatus(env, id)).toBe("approved");
    const dynmapJobs = env.DB.raw.prepare("SELECT COUNT(*) AS n FROM job_queue WHERE kind = 'dynmap_sync'").get().n;
    expect(dynmapJobs).toBe(1);
  });

  it("確認と取り下げが同時に届き確認が先に処理された場合、取り下げは無効になる", async () => {
    const id = await provisionalApplication(env);
    const confirm = await click(env, "confirm", id);
    const withdraw = await click(env, "withdraw", id);

    await confirm.followUp();
    await withdraw.followUp();

    expect(appStatus(env, id)).toBe("approved");
    expect(activeClaims(env, "uuid-alice")).toHaveLength(1);
  });

  it("取り下げが先に処理された場合、後続の確認は claim を登録しない", async () => {
    const id = await provisionalApplication(env);
    const confirm = await click(env, "confirm", id);
    const withdraw = await click(env, "withdraw", id);

    await withdraw.followUp();
    await confirm.followUp();

    expect(appStatus(env, id)).toBe("withdrawn");
    expect(activeClaims(env, "uuid-alice")).toHaveLength(0);
  });

  it("同じ届出に対する確定処理が重複しても claim は1件だけ（CT完了報告の重複など）", async () => {
    const id = await insertApplication(env, {
      kind: "kaihatsu_set",
      requester: "u_alice",
      status: "processing",
      payload: {},
      ownerMcUuid: "uuid-alice",
      ownerMcName: "Alice",
      op: "set",
    });
    const row = env.DB.raw.prepare("SELECT * FROM applications WHERE id = ?").get(id);
    await Promise.all([finalizeApprovedSet(env, { ...row }, CT_RESULT, null), finalizeApprovedSet(env, { ...row }, CT_RESULT, null)]);
    expect(activeClaims(env, "uuid-alice")).toHaveLength(1);
  });

  it("DBの一意制約でも1所有者に2件目のアクティブ claim を登録できない", () => {
    const insert = env.DB.raw.prepare(
      "INSERT INTO claims (owner_uuid, owner_mc_name, status, created_at, updated_at) VALUES ('uuid-x', 'X', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    );
    insert.run("active");
    insert.run("superseded");
    expect(() => insert.run("active")).toThrow(/UNIQUE/);
  });
});
