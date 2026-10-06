// job_queue の処理中リース回収の回帰テスト
// （監査指摘：CT102が完了報告しないまま processing に残ったジョブが永久に再試行されない）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestEnv, mockFetch, patchSetting } from "./helpers/d1.mjs";
import { claimJobs, completeJob, enqueueJob } from "../src/jobs/queue";
import { reclaimExpiredLeases } from "../src/cron/leaseReclaim";

function jobRow(env, id) {
  return env.DB.raw.prepare("SELECT * FROM job_queue WHERE id = ?").get(id);
}

describe("処理中リースの回収", () => {
  let env;
  let fetchMock;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    env = createTestEnv();
    patchSetting(env, "job_retry", { stale_after_sec: 300, processing_lease_sec: 1800 });
    fetchMock = mockFetch();
  });

  afterEach(() => {
    fetchMock.restore();
    vi.useRealTimers();
  });

  async function claimRemoveJob() {
    const id = await enqueueJob(env, "crafty_op", { op: "remove", mc_name: "DepartedUser", mc_uuid: "uuid-x" });
    const claimed = await claimJobs(env, { crafty: 3 }, "ct102");
    expect(claimed.map((j) => j.id)).toEqual([id]);
    return id;
  }

  it("リース期限内は回収しない", async () => {
    const id = await claimRemoveJob();
    vi.setSystemTime(new Date("2026-10-01T00:29:00Z"));
    await reclaimExpiredLeases(env);
    expect(jobRow(env, id).status).toBe("processing");
  });

  it("リース期限切れのジョブは失敗扱いで pending に戻り、バックオフ後に再取得できる", async () => {
    const id = await claimRemoveJob();
    vi.setSystemTime(new Date("2026-10-01T00:30:00Z"));
    await reclaimExpiredLeases(env);

    const row = jobRow(env, id);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.next_retry_at).toBe("2026-10-01T00:31:00Z");

    vi.setSystemTime(new Date("2026-10-01T00:31:00Z"));
    const again = await claimJobs(env, { crafty: 3 }, "ct102");
    expect(again.map((j) => j.id)).toEqual([id]);
  });

  it("再試行上限に達したら終端（failed）にし、手動対応タスクを起票する", async () => {
    const id = await claimRemoveJob();
    env.DB.raw.prepare("UPDATE job_queue SET attempts = 4 WHERE id = ?").run(id); // crafty_max_attempts=5
    vi.setSystemTime(new Date("2026-10-01T00:30:00Z"));
    await reclaimExpiredLeases(env);

    expect(jobRow(env, id).status).toBe("failed");
    const task = env.DB.raw.prepare("SELECT title FROM tasks ORDER BY id DESC LIMIT 1").get();
    expect(task.title).toContain("DepartedUser");
  });

  it("回収済みジョブへの遅延した完了報告は無視する", async () => {
    const id = await claimRemoveJob();
    vi.setSystemTime(new Date("2026-10-01T00:30:00Z"));
    await reclaimExpiredLeases(env);

    const late = await completeJob(env, id, { status: "done", result: { ok: true } });
    expect(late).toBeNull();
    expect(jobRow(env, id).status).toBe("pending");
  });

  it("完了済みジョブへの重複した完了報告は無視する", async () => {
    const id = await claimRemoveJob();
    expect((await completeJob(env, id, { status: "done" }))?.status).toBe("done");
    expect(await completeJob(env, id, { status: "failed", error: "dup" })).toBeNull();
    expect(jobRow(env, id).status).toBe("done");
    expect(jobRow(env, id).attempts).toBe(0);
  });
});
