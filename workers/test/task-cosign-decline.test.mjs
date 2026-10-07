// 共同確認（§4.5.1）タスクの完了操作の回帰テスト
// （監査指摘：主担当が辞退して共同確認者を外し、その後単独で完了させられる）。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, mockFetch, setSetting } from "./helpers/d1.mjs";
import { handleTaskDecline, handleTaskDone } from "../src/tasks/taskCommand";
import { assignTask } from "../src/tasks/repo";

const ROLES = { hito: "R_HITO", kari_sanka: "R_KARI", sub_aka: "R_SUB", unei: "R_UNEI", unei_sub: "R_UNEI_SUB" };

function staff(id) {
  return { token: "t", member: { user: { id }, roles: ["R_UNEI"] } };
}

function task(env, id) {
  return env.DB.raw.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
}

async function done(env, actor, id) {
  const res = await handleTaskDone(env, staff(actor), [
    { name: "task_id", type: 3, value: String(id) },
    { name: "evidence", type: 3, value: "対応済み" },
  ]);
  return res.ack.data.content;
}

async function decline(env, actor, id) {
  const res = await handleTaskDecline(env, staff(actor), [{ name: "task_id", type: 3, value: String(id) }]);
  await res.followUp();
  return res.ack.data?.content;
}

describe("共同確認タスクの辞退と完了", () => {
  let env;
  let fetchMock;
  let taskId;

  beforeEach(() => {
    env = createTestEnv();
    setSetting(env, "roles", ROLES);
    fetchMock = mockFetch();
    taskId = Number(
      env.DB.raw
        .prepare("INSERT INTO tasks (type, title, required_tags, is_controversial, assignee, co_signer, status) VALUES ('T-C', '論争的な議題', '[\"controversial_review\"]', 1, 'A', 'C', 'assigned')")
        .run().lastInsertRowid,
    );
  });

  afterEach(() => fetchMock.restore());

  it("辞退後に未割当へ戻ったタスクを、辞退した主担当が単独で完了させられない", async () => {
    await decline(env, "A", taskId);
    expect(task(env, taskId).status).toBe("unassigned");
    expect(task(env, taskId).co_signer).toBeNull();

    const msg = await done(env, "A", taskId);
    expect(msg).toContain("辞退した運営者");
    expect(task(env, taskId).status).toBe("unassigned");
  });

  it("辞退後に共同確認者なしで別の担当者へ再割当された場合も、辞退者は完了させられない", async () => {
    await decline(env, "A", taskId);
    await assignTask(env, taskId, { assignee: "C", coSigner: null }); // 次点候補がいなかった再割当

    expect(await done(env, "A", taskId)).toContain("辞退した運営者");
    // 共同確認者不在の共同確認タスクは、現担当者以外も完了させられない
    expect(await done(env, "X", taskId)).toContain("担当者（<@C>）のみ");
    expect(task(env, taskId).status).toBe("assigned");

    expect(await done(env, "C", taskId)).toContain("完了にしました");
    expect(task(env, taskId).status).toBe("done");
  });

  it("主担当が完了操作済み（co_sign_pending）のタスクは辞退できない", async () => {
    expect(await done(env, "A", taskId)).toContain("もう一方の完了操作を待って");
    expect(task(env, taskId).status).toBe("co_sign_pending");

    const msg = await decline(env, "A", taskId);
    expect(msg).toContain("辞退できる状態ではありません");
    expect(task(env, taskId).co_signer).toBe("C");
  });

  it("共同確認が不要なタスクは、辞退した人でも完了操作できる", async () => {
    const plainId = Number(
      env.DB.raw
        .prepare("INSERT INTO tasks (type, title, required_tags, is_controversial, assignee, status) VALUES ('T-C', '通常の作業', '[]', 0, 'A', 'assigned')")
        .run().lastInsertRowid,
    );
    await decline(env, "A", plainId);
    expect(task(env, plainId).status).toBe("unassigned");

    expect(await done(env, "A", plainId)).toContain("完了にしました");
    expect(task(env, plainId).status).toBe("done");
  });

  it("通常の共同確認フローは従来どおり担当者・共同確認者の双方で完了する", async () => {
    await done(env, "A", taskId);
    expect(await done(env, "C", taskId)).toContain("完了にしました");
    expect(task(env, taskId).status).toBe("done");
  });
});
