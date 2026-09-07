// 保留タスクの自動復帰（§4.2：再開予定日到来で自動的に割当済へ戻す。§9：絶対時刻ベース判定）。

import type { Env } from "../env";
import { listHeldTasksPastResume, resumeHeldTask } from "../tasks/repo";
import { buildHoldResumeNotice } from "../tasks/templates";
import { syncTaskMessage } from "../tasks/notify";
import { sendDirectMessage } from "../discord/rest";
import { writeAuditLog } from "../auditLog";

export async function processTaskHoldResume(env: Env): Promise<void> {
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const due = await listHeldTasksPastResume(env, nowIso);
  for (const task of due) {
    try {
      await resumeHeldTask(env, task.id);
      await writeAuditLog(env, { actor: "system", action: "task_hold_resumed", target: String(task.id) });
      await syncTaskMessage(env, task.id).catch((e) => console.error(`タスク #${task.id} のタスクメッセージ更新に失敗`, e));
      if (task.assignee) {
        await sendDirectMessage(env.DISCORD_BOT_TOKEN, task.assignee, buildHoldResumeNotice({ taskId: task.id, title: task.title, assigneeMention: `<@${task.assignee}>` })).catch((e) =>
          console.error(`タスク #${task.id} の保留復帰DM送信に失敗`, e),
        );
      }
    } catch (e) {
      console.error(`タスク #${task.id} の保留自動復帰に失敗`, e);
    }
  }
}
