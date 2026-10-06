// 同時処理グループのメンバーを原因とする保留の解放の回帰テスト
// （監査指摘：グループ却下時に application 単位の保留が解放されず、第三者が held のまま永久に締め出される）。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, mockFetch } from "./helpers/d1.mjs";
import { handleKaihatsuConfirmComponent } from "../src/kaihatsu/confirmCommand";
import { processPhase3Deadlines } from "../src/cron/phase3Deadlines";
import { markHeldAndNotify } from "../src/kaihatsu/phase3";
import { hasOpenApplication, insertApplication, markApplicationProvisional } from "../src/kaihatsu/repo";

const ALICE_CT = {
  outcome: "approved",
  reasons: [],
  area_blocks: 100,
  bbox: { x1: 0, z1: 0, x2: 10, z2: 10 },
  mask_saved_path: "/masks/alice.png",
};

function app(env, id) {
  return env.DB.raw.prepare("SELECT * FROM applications WHERE id = ?").get(id);
}

function imageJobs(env) {
  return env.DB.raw
    .prepare("SELECT payload FROM job_queue WHERE kind = 'image_process'")
    .all()
    .map((r) => JSON.parse(r.payload));
}

describe("グループメンバーを原因とする保留の解放", () => {
  let env;
  let fetchMock;
  let aliceId;
  let carolId;

  beforeEach(async () => {
    env = createTestEnv();
    fetchMock = mockFetch();

    // Alice：単独メンバーのグループ "solo" を締め切り、CT評価の結果 provisional
    env.DB.raw
      .prepare("INSERT INTO application_groups (group_key, representative_discord_id, status, created_at, finalized_at, deadline_at) VALUES ('solo', 'u_alice', 'finalized', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', '2999-01-01T00:00:00Z')")
      .run();
    aliceId = await insertApplication(env, {
      kind: "kaihatsu_set", requester: "u_alice", status: "collecting", groupKey: "solo", payload: {},
      ownerMcUuid: "uuid-alice", ownerMcName: "Alice", op: "set",
    });
    await markApplicationProvisional(env, aliceId, { provisionalUntil: "2999-01-01T00:00:00Z", payload: { ctResult: ALICE_CT, previousClaimId: null } });

    // Carol：Aliceと重複する単独申請 → CTが held（原因：Aliceの application）を返した
    carolId = await insertApplication(env, {
      kind: "kaihatsu_set", requester: "u_carol", status: "processing",
      payload: { attachments: [{ filename: "01_Carol.png", url: "https://cdn.example/01_Carol.png" }], mc_name: "Carol", mc_uuid: "uuid-carol" },
      ownerMcUuid: "uuid-carol", ownerMcName: "Carol", op: "set",
    });
    await markHeldAndNotify(env, app(env, carolId), {
      outcome: "held", reasons: ["保留"], held_blocking_ref_type: "application", held_blocking_ref_id: aliceId,
      overlap_pending: [{ owner_name: "Alice", pixels: 10, ref_type: "application", ref_id: aliceId }],
    });
  });

  afterEach(() => fetchMock.restore());

  it("グループメンバーの取り下げでグループが却下されると、そのメンバーを原因とする保留が解放され再審査される", async () => {
    expect(app(env, carolId).status).toBe("held");

    const res = await handleKaihatsuConfirmComponent(env, { user: { id: "u_alice" }, data: { custom_id: `kaihatsu:withdraw:${aliceId}` } });
    await res.followUp();

    expect(app(env, aliceId).status).toBe("withdrawn");
    const carol = app(env, carolId);
    expect(carol.status).toBe("processing");
    expect(carol.held_blocking_application_id).toBeNull();

    // 再審査ジョブには元の添付が引き継がれている（保留時に payload を上書きしない）
    const jobs = imageJobs(env);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].application_id).toBe(carolId);
    expect(jobs[0].attachments).toEqual([{ filename: "01_Carol.png", url: "https://cdn.example/01_Carol.png" }]);
  });

  it("解放漏れの保留（原因が既に取り下げ済み）は締切Cronのバックストップで解放される", async () => {
    // 旧実装で取り残された状態を再現：グループは却下済み・Aliceは取り下げ済みだが Carol は held のまま
    env.DB.raw.prepare("UPDATE applications SET status = 'withdrawn' WHERE id = ?").run(aliceId);
    env.DB.raw.prepare("UPDATE application_groups SET status = 'rejected' WHERE group_key = 'solo'").run();
    expect(await hasOpenApplication(env, "uuid-carol")).toBe(true);

    await processPhase3Deadlines(env);

    expect(app(env, carolId).status).toBe("processing");
    expect(imageJobs(env)).toHaveLength(1);
  });

  it("原因の届出が正式承認済みなら、バックストップは保留中の届出を重複確定として却下する", async () => {
    env.DB.raw.prepare("UPDATE applications SET status = 'approved' WHERE id = ?").run(aliceId);

    await processPhase3Deadlines(env);

    expect(app(env, carolId).status).toBe("rejected");
    expect(imageJobs(env)).toHaveLength(0);
    expect(await hasOpenApplication(env, "uuid-carol")).toBe(false);
  });

  it("原因の届出がまだ仮承認中なら保留を維持する", async () => {
    await processPhase3Deadlines(env);
    expect(app(env, carolId).status).toBe("held");
  });
});
