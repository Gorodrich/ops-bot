// システム自身が検知した障害・審査要件からのタスク自動起票（T-A）専用の窓口。
// /task add の自動割当フロー（tasks/taskCommand.ts）と同じ考え方で、起票と同時に
// autoAssign（§4.5）を経由させ、担当者確定・タスクカード投稿・通知まで一貫して行う。
// 呼び出し側（jobs/completion.ts・cron/staleJobs.ts・kaihatsu/revokeCommand.ts）は
// 生の INSERT INTO tasks を直書きせず、必ずこの関数を経由すること。

import type { Env } from "../env";
import { sendDirectMessage } from "../discord/rest";
import { autoAssign, maybeEnqueueTaskTiebreakPreview } from "./autoAssign";
import { getTask, insertManualTask } from "./repo";
import { syncTaskMessage, postTaskAttentionPush } from "./notify";
import { buildAssignedNoticeEmbed, manualReviewReasonText } from "./templates";

export interface IssueSystemTaskArgs {
  title: string;
  summary: string;
  relatedRule: string;
  priority: "high" | "medium" | "low";
  requiredTags: string[];
  requiresDeveloper: boolean;
  // 起票のトリガーとなった人間の操作主体（あれば）。この人物を自動割当候補から除外する
  // （decisions.md #65是正：依頼者本人への割当偏りを防ぐ）。cron・ジョブ失敗系などシステム
  // 主導の起票では該当する単一の人間IDが無いため undefined のままにする。
  triggeredBy?: string | null;
}

export interface IssueSystemTaskOutcome {
  taskId: number;
  assignee: string | null;
}

export async function issueSystemTask(env: Env, args: IssueSystemTaskArgs): Promise<IssueSystemTaskOutcome> {
  const outcome = await autoAssign(
    env,
    {
      requiredTags: args.requiredTags,
      requiresTechnician: false,
      requiredPermissionTier: null,
      isControversial: false,
      requiresDeveloper: args.requiresDeveloper,
    },
    args.triggeredBy ? [args.triggeredBy] : [],
  );
  const assigned = outcome.reason === "ok" && outcome.primary;

  const taskId = await insertManualTask(env, {
    type: "T-A",
    relatedRule: args.relatedRule,
    title: args.title,
    summary: args.summary,
    assignee: assigned ? outcome.primary : null,
    coSigner: assigned ? outcome.coSigner : null,
    priority: args.priority,
    createdBy: null,
    requiredTags: args.requiredTags,
    requiresTechnician: false,
    requiresDeveloper: args.requiresDeveloper,
    requiredPermissionTier: null,
    isControversial: false,
    estimatedLoad: null,
    dueAt: null,
    deadlineSource: null,
  });

  const reason: "no_eligible" | "tie_or_below_threshold" = outcome.reason === "no_eligible" ? "no_eligible" : "tie_or_below_threshold";
  const llmPreviewRequested =
    !assigned && reason === "tie_or_below_threshold"
      ? await maybeEnqueueTaskTiebreakPreview(env, { taskId, title: args.title, requiredTags: args.requiredTags, llmFallbackCandidateIds: outcome.llmFallbackCandidateIds })
      : false;
  await syncTaskMessage(env, taskId, { manualReviewNote: assigned ? null : manualReviewReasonText(reason, llmPreviewRequested) }).catch((e) =>
    console.error("システム起票タスクのタスクカード投稿に失敗", e),
  );

  if (!assigned) {
    const freshTask = await getTask(env, taskId);
    if (freshTask) {
      await postTaskAttentionPush(env, freshTask, `自動割当できませんでした（${manualReviewReasonText(reason, llmPreviewRequested)}）。`);
    }
    return { taskId, assignee: null };
  }

  const primaryId = outcome.primary as string;
  await sendDirectMessage(env.DISCORD_BOT_TOKEN, primaryId, "", [
    buildAssignedNoticeEmbed({ taskId, title: args.title, assigneeMention: `<@${primaryId}>`, coSignerMention: outcome.coSigner ? `<@${outcome.coSigner}>` : null }),
  ]).catch((e) => console.error("担当者DM送信に失敗", e));
  if (outcome.coSigner) {
    await sendDirectMessage(env.DISCORD_BOT_TOKEN, outcome.coSigner, `タスク #${taskId}「${args.title}」の共同確認者に選定されました（§4.5.1）。`).catch((e) =>
      console.error("共同確認者DM送信に失敗", e),
    );
  }

  return { taskId, assignee: primaryId };
}
