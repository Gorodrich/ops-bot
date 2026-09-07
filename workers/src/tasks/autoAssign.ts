// 割当アルゴリズムのオーケストレーション（§4.5・§4.5.1）。D1読み出し＋スコアリングを組み合わせる。
// スコアリング自体（純粋関数）は assignment.ts に分離し、単体テストで担保する（§11-5）。

import type { Env } from "../env";
import { getAssignmentWeights } from "../settings";
import { getCurrentLoad, getRecentAssignees, getRecentCompletionRate, listStaff } from "../staff/repo";
import {
  type AssignmentCandidate,
  type AssignmentTaskInput,
  type PermissionTier,
  isHardEligible,
  isWithinActiveHours,
  selectAssignment,
} from "./assignment";

export interface AutoAssignTaskInput {
  requiredTags: string[];
  requiresTechnician: boolean;
  requiredPermissionTier: PermissionTier | null;
  isControversial: boolean;
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
      permissionTier: s.discord_permission_tier,
      maxConcurrent: s.max_concurrent,
      currentLoad,
      completionRate,
      isActiveHoursNow: isWithinActiveHours(activeHours, now),
      requiresCosign: s.requires_cosign === 1,
    });
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
