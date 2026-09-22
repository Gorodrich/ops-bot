// 割当アルゴリズムのオーケストレーション（§4.5・§4.5.1）。D1読み出し＋スコアリングを組み合わせる。
// スコアリング自体（純粋関数）は assignment.ts に分離し、単体テストで担保する（§11-5）。

import type { Env } from "../env";
import { getAssignmentWeights, getLlmSetting } from "../settings";
import { enqueueJob } from "../jobs/queue";
import { getCurrentLoad, getRecentAssignees, getRecentCompletionRate, getStaffById, listStaff } from "../staff/repo";
import {
  type AssignmentCandidate,
  type AssignmentTaskInput,
  type PermissionTier,
  isHardEligible,
  isWithinActiveHours,
  selectAssignment,
  tagMatchRatio,
} from "./assignment";

export interface AutoAssignTaskInput {
  requiredTags: string[];
  requiresTechnician: boolean;
  requiredPermissionTier: PermissionTier | null;
  isControversial: boolean;
  // 管理者/開発者専用タスク（§4.5.2）。true の場合、is_developer 保持者に max_concurrent の
  // 上限判定を無視して強制割当し、共同確認（cosign）もスキップする。
  requiresDeveloper: boolean;
}

export interface AutoAssignOutcome {
  primary: string | null;
  coSigner: string | null;
  // is_controversial等により共同確認者が必要だが、次点候補がいなかった場合（§4.5.1）
  coSignRequiredButUnavailable: boolean;
  reason: "ok" | "no_eligible" | "tie_or_below_threshold";
  // reason === "tie_or_below_threshold" のときのみ、LLMフォールバック（§4.5・§7.3）に渡す候補ID
  llmFallbackCandidateIds: string[];
}

export async function autoAssign(
  env: Env,
  task: AutoAssignTaskInput,
  excludeStaffIds: string[] = [],
): Promise<AutoAssignOutcome> {
  const weights = await getAssignmentWeights(env);
  const staffRows = await listStaff(env);
  const now = new Date();

  const candidates: AssignmentCandidate[] = [];
  for (const s of staffRows) {
    if (excludeStaffIds.includes(s.discord_id)) continue;
    const tags = JSON.parse(s.tags) as string[];
    const weakTags = JSON.parse(s.weak_tags) as string[];
    const activeHours = JSON.parse(s.active_hours) as Array<{ days: string[]; from: string; to: string }>;
    const currentLoad = await getCurrentLoad(env, s.discord_id);
    const completionRate = await getRecentCompletionRate(env, s.discord_id);
    candidates.push({
      staffId: s.discord_id,
      active: s.active === 1,
      onLeave: s.on_leave_active === 1,
      tags,
      weakTags,
      isTechnician: s.is_technician === 1,
      isDeveloper: s.is_developer === 1,
      permissionTier: s.discord_permission_tier,
      maxConcurrent: s.max_concurrent,
      currentLoad,
      completionRate,
      isActiveHoursNow: isWithinActiveHours(activeHours, now),
      requiresCosign: s.requires_cosign === 1,
    });
  }

  // 管理者/開発者専用タスク（§4.5.2）：is_developer 保持者に max_concurrent の上限判定を
  // 無視して強制割当する。on_leave も無視する（開発者確認済み）。共同確認は常にスキップする。
  if (task.requiresDeveloper) {
    const developerCandidates = candidates.filter((c) => c.isDeveloper && c.active);
    if (developerCandidates.length === 0) {
      return { primary: null, coSigner: null, coSignRequiredButUnavailable: false, reason: "no_eligible", llmFallbackCandidateIds: [] };
    }
    const chosen = developerCandidates.reduce((a, b) => (b.currentLoad < a.currentLoad ? b : a));
    return { primary: chosen.staffId, coSigner: null, coSignRequiredButUnavailable: false, reason: "ok", llmFallbackCandidateIds: [] };
  }

  const taskInput: AssignmentTaskInput = {
    requiredTags: task.requiredTags,
    requiresTechnician: task.requiresTechnician,
    requiredPermissionTier: task.requiredPermissionTier,
  };
  const eligible = candidates.filter((c) => isHardEligible(c, taskInput));
  const recentAssigneesDesc = await getRecentAssignees(env, Math.max(weights.consecutive_assign_limit, 1));

  const result = selectAssignment({ eligible, task: taskInput, weights, recentAssigneesDesc });
  if (result.reason !== "ok" || !result.primary) {
    return {
      primary: null,
      coSigner: null,
      coSignRequiredButUnavailable: false,
      reason: result.reason,
      llmFallbackCandidateIds: result.llmFallbackCandidateIds,
    };
  }

  const primaryCandidate = candidates.find((c) => c.staffId === result.primary);
  const needsCosign =
    task.isControversial ||
    task.requiredTags.includes("controversial_review") ||
    primaryCandidate?.requiresCosign === true;

  if (!needsCosign) {
    return { primary: result.primary, coSigner: null, coSignRequiredButUnavailable: false, reason: "ok", llmFallbackCandidateIds: [] };
  }

  return {
    primary: result.primary,
    coSigner: result.runnerUp,
    coSignRequiredButUnavailable: result.runnerUp === null,
    reason: "ok",
    llmFallbackCandidateIds: [],
  };
}

/**
 * autoAssign() が reason === "tie_or_below_threshold" を返した通常タスク（/task add・自動起票T-A・
 * 辞退後の再割当）向けに、LLM層（§4.5・§7.3のタイブレーク）へ「参考プレビュー」だけを問い合わせる。
 * 実際のタスクの担当者欄は一切書き換えない（開発者DMへのプレビュー通知のみ・§9と同じシャドー方針）。
 * LLM検出パイプライン（detectionCompletion.ts）の assignment_tiebreak と同じCT側ジョブを、
 * source_message_url の代わりに task_id で紐付けて再利用する。
 * 戻り値はプレビューを実際に依頼できたか（false の場合はLLM層停止中／候補データなし等）。
 */
export async function maybeEnqueueTaskTiebreakPreview(
  env: Env,
  args: { taskId: number; title: string; requiredTags: string[]; llmFallbackCandidateIds: string[] },
): Promise<boolean> {
  if (args.llmFallbackCandidateIds.length === 0) return false;
  const llmSetting = await getLlmSetting(env);
  if (llmSetting.paused) return false; // §7.4：縮退運転中はLLM呼び出しを一切行わない（C-2）

  const candidates: Array<{
    staff_id: string;
    tags: string[];
    notes: string | null;
    tag_match: number;
    weak_match: number;
    is_mentioned: boolean;
  }> = [];
  for (const staffId of args.llmFallbackCandidateIds) {
    const staff = await getStaffById(env, staffId);
    if (!staff) continue;
    const tags = JSON.parse(staff.tags) as string[];
    const weakTags = JSON.parse(staff.weak_tags) as string[];
    candidates.push({
      staff_id: staffId,
      tags,
      notes: staff.notes,
      tag_match: tagMatchRatio(args.requiredTags, tags),
      weak_match: tagMatchRatio(args.requiredTags, weakTags),
      // /task add・T-A・辞退後再割当には検出元メッセージが無いため、メンション優先は常にfalse。
      is_mentioned: false,
    });
  }
  if (candidates.length === 0) return false;

  // notesはこのペイロード以外のどこにも保存しない（detectionCompletion.tsの同種コメント参照）。
  await enqueueJob(env, "claude_code", {
    subkind: "assignment_tiebreak",
    max_tokens: llmSetting.max_tokens,
    task_id: args.taskId,
    task_title: args.title,
    required_tags: args.requiredTags,
    candidates,
  });
  return true;
}
