// 遅延した画像処理の完了報告の回帰テスト
// （監査指摘：グループ却下後に届いた kaihatsu_group の完了報告が、メンバーを仮承認として復活させる）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestEnv, mockFetch } from "./helpers/d1.mjs";
import { handleKaihatsuGroupFinalize } from "../src/kaihatsu/groupFinalizeCommand";
import { handleKaihatsuConfirmComponent } from "../src/kaihatsu/confirmCommand";
import { claimJobs } from "../src/jobs/queue";
import { handleJobComplete } from "../src/jobs/completion";
import { processPhase3Deadlines } from "../src/cron/phase3Deadlines";
import { insertApplication } from "../src/kaihatsu/repo";

function app(env, id) {
  return env.DB.raw.prepare("SELECT * FROM applications WHERE id = ?").get(id);
}

describe("グループ却下後に届いた評価結果", () => {
  let env;
  let fetchMock;
  let aliceId;
  let bobId;
  let jobId;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    env = createTestEnv();
    fetchMock = mockFetch();

    const claimId = Number(
      env.DB.raw
        .prepare(
          `INSERT INTO claims (owner_uuid, owner_mc_name, status, mask_ref, area_blocks, bbox_loc1, bbox_loc2, created_at, updated_at)
           VALUES ('uuid-bob', 'Bob', 'active', '/masks/bob.png', 10, '{"x":0,"y":64,"z":0}', '{"x":9,"y":64,"z":9}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
        )
        .run().lastInsertRowid,
    );
    env.DB.raw.prepare("INSERT INTO application_groups (group_key, representative_discord_id, status, created_at) VALUES ('g1', 'u_alice', 'collecting', '2026-10-01T00:00:00Z')").run();
    aliceId = await insertApplication(env, {
      kind: "kaihatsu_set", requester: "u_alice", status: "collecting", groupKey: "g1",
      payload: { attachments: [{ filename: "01_Alice.png", url: "https://cdn.example/a.png" }], mc_name: "Alice", mc_uuid: "uuid-alice", previous_own_claim_id: null },
      ownerMcUuid: "uuid-alice", ownerMcName: "Alice", op: "set",
    });
    bobId = await insertApplication(env, {
      kind: "kaihatsu_delete", requester: "u_bob", submittedBy: "u_alice", status: "collecting", groupKey: "g1",
      payload: { mc_name: "Bob", mc_uuid: "uuid-bob", claim_id: claimId }, ownerMcUuid: "uuid-bob", ownerMcName: "Bob", targetClaimId: claimId, op: "delete",
    });

    const fin = await handleKaihatsuGroupFinalize(env, { token: "t", member: { user: { id: "u_alice" }, roles: [] } }, [{ name: "group", type: 3, value: "g1" }]);
    await fin.followUp();
    const claimed = await claimJobs(env, { image: 1 }, "ct102");
    expect(claimed).toHaveLength(1);
    jobId = claimed[0].id;
  });

  afterEach(() => {
    fetchMock.restore();
    vi.useRealTimers();
  });

  const approvedResult = () => ({
    players: {
      Alice: { outcome: "approved", reasons: [], application_id: aliceId, area_blocks: 50, bbox: { x1: 0, z1: 0, x2: 5, z2: 5 }, mask_saved_path: "/masks/alice.png" },
    },
    unresolved_players: [],
    skipped_files: [],
  });

  it("評価中にグループが却下されていれば、遅れて届いた承認結果でメンバーを仮承認にしない", async () => {
    const withdraw = await handleKaihatsuConfirmComponent(env, { user: { id: "u_bob" }, data: { custom_id: `kaihatsu:withdraw:${bobId}` } });
    await withdraw.followUp();
    expect(env.DB.raw.prepare("SELECT status FROM application_groups WHERE group_key = 'g1'").get().status).toBe("rejected");

    await handleJobComplete(env, jobId, { status: "done", result: approvedResult() });

    expect(app(env, aliceId).status).not.toBe("provisional");
    expect(app(env, aliceId).provisional_until).toBeNull();
  });

  it("グループ確定済みのまま provisional で期限を過ぎたメンバーは締切Cronで期限切れになる（防御的措置）", async () => {
    env.DB.raw.prepare("UPDATE application_groups SET status = 'rejected' WHERE group_key = 'g1'").run();
    env.DB.raw.prepare("UPDATE applications SET status = 'provisional', provisional_until = '2026-10-02T00:00:00Z' WHERE id = ?").run(aliceId);

    vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
    await processPhase3Deadlines(env);

    expect(app(env, aliceId).status).toBe("expired");
  });

  it("対照：グループが締切済みのままなら承認結果で仮承認になる", async () => {
    await handleJobComplete(env, jobId, { status: "done", result: approvedResult() });
    expect(app(env, aliceId).status).toBe("provisional");
  });
});
