// 割当アルゴリズム（§4.5・§4.5.1）。LLM不使用（C-1）。純粋関数として実装し単体テストで担保する（§11-5）。
//
// Phase 5 の方針（phase-5.md）：スコア上位者が同点、または全員のタグ一致度が閾値未満の場合の
// LLMフォールバックはPhase 6以降で有効化する。Phase 5ではその経路は「未割当・要手動対応」として扱う。

import type { AssignmentWeightsSetting } from "../settings";

export type PermissionTier = "admin" | "broad" | "standard";

const TIER_RANK: Record<PermissionTier, number> = { standard: 0, broad: 1, admin: 2 };

export function tierMeets(actual: PermissionTier, required: PermissionTier | null | undefined): boolean {
  if (!required) return true;
  return TIER_RANK[actual] >= TIER_RANK[required];
}

export interface AssignmentCandidate {
  staffId: string;
  active: boolean;
  onLeave: boolean;
  tags: string[];
  weakTags: string[];
  isTechnician: boolean;
  permissionTier: PermissionTier;
  maxConcurrent: number;
  currentLoad: number;
  completionRate: number; // 0..1
  isActiveHoursNow: boolean;
  requiresCosign: boolean;
}

export interface AssignmentTaskInput {
  requiredTags: string[];
  requiresTechnician: boolean;
  requiredPermissionTier: PermissionTier | null;
}

/** ハード条件（§4.5：スコア以前に候補から除外）。 */
export function isHardEligible(c: AssignmentCandidate, task: AssignmentTaskInput): boolean {
  if (!c.active) return false;
  if (c.onLeave) return false;
  if (task.requiresTechnician && !c.isTechnician) return false;
  if (!tierMeets(c.permissionTier, task.requiredPermissionTier)) return false;
  if (c.currentLoad >= c.maxConcurrent) return false;
  return true;
}

/** required_tags に対する一致率。required_tags が空の場合はタグ要件なしとして中立の1を返す。 */
export function tagMatchRatio(required: string[], tags: string[]): number {
  if (required.length === 0) return 1;
  const hit = required.filter((t) => tags.includes(t)).length;
  return hit / required.length;
}

export function computeScore(
  c: AssignmentCandidate,
  task: AssignmentTaskInput,
  weights: AssignmentWeightsSetting,
  isConsecutiveBlocked: boolean,
): number {
  const tagMatch = tagMatchRatio(task.requiredTags, c.tags);
  const weakPenalty = tagMatchRatio(task.requiredTags, c.weakTags);
  const loadTerm = c.maxConcurrent > 0 ? 1 - c.currentLoad / c.maxConcurrent : 0;
  const activeTerm = c.isActiveHoursNow ? 1 : 0;
  const consecutiveTerm = isConsecutiveBlocked ? -1 : 0;
  return (
    weights.w1 * tagMatch -
    weights.w1_prime * weakPenalty +
    weights.w2 * loadTerm +
    weights.w3 * c.completionRate +
    weights.w4 * activeTerm +
    weights.w5 * consecutiveTerm
  );
}

export type AssignmentReason = "ok" | "no_eligible" | "tie_or_below_threshold";

export interface AssignmentResult {
  primary: string | null;
  // 次点候補（§4.5.1：is_controversialタスクの共同確認者として使うかは呼び出し側が判断する）
  runnerUp: string | null;
  reason: AssignmentReason;
  // reason === "tie_or_below_threshold" の場合のみ、LLMフォールバック（§4.5・§7.3）に渡す
  // 候補者ID（スコア上位から最大5件）。それ以外の理由では空配列。
  llmFallbackCandidateIds: string[];
}

/**
 * ハード条件を通過した候補（eligible）からスコアリングで主担当・次点を選ぶ。
 * recentAssigneesDesc は直近の割当履歴（新しい順、担当者ID）。consecutive_assign_limit回連続で
 * 同一人物が選ばれ続けている場合、次点者へ強制的に回す（§4.5：バランサ）。
 */
export function selectAssignment(args: {
  eligible: AssignmentCandidate[];
  task: AssignmentTaskInput;
  weights: AssignmentWeightsSetting;
  recentAssigneesDesc: string[];
}): AssignmentResult {
  const { eligible, task, weights, recentAssigneesDesc } = args;
  if (eligible.length === 0) return { primary: null, runnerUp: null, reason: "no_eligible", llmFallbackCandidateIds: [] };

  let ranked = eligible
    .map((c) => ({ staffId: c.staffId, score: computeScore(c, task, weights, false) }))
    .sort((a, b) => b.score - a.score);

  const limit = weights.consecutive_assign_limit;
  const rankedTop = ranked[0];
  const rankedSecond = ranked[1];
  if (limit > 0 && recentAssigneesDesc.length >= limit && rankedTop && rankedSecond) {
    const lastN = recentAssigneesDesc.slice(0, limit);
    const allSameAsTop = lastN.every((id) => id === lastN[0]) && rankedTop.staffId === lastN[0];
    if (allSameAsTop) {
      ranked = [rankedSecond, rankedTop, ...ranked.slice(2)];
    }
  }

  const top = ranked[0];
  if (!top) return { primary: null, runnerUp: null, reason: "no_eligible", llmFallbackCandidateIds: [] };
  const second = ranked[1] ?? null;
  const tie = second !== null && Math.abs(second.score - top.score) < 1e-9;
  const belowThreshold =
    weights.tag_match_threshold > 0 &&
    eligible.every((c) => tagMatchRatio(task.requiredTags, c.tags) < weights.tag_match_threshold);

  if (tie || belowThreshold) {
    return {
      primary: null,
      runnerUp: null,
      reason: "tie_or_below_threshold",
      llmFallbackCandidateIds: ranked.slice(0, 5).map((r) => r.staffId),
    };
  }

  return { primary: top.staffId, runnerUp: second ? second.staffId : null, reason: "ok", llmFallbackCandidateIds: [] };
}

export interface ActiveHoursWindow {
  days: string[]; // mon..sun
  from: string; // HH:MM
  to: string; // HH:MM（24時超は翌日への継続。staff-schema.mjsと同じ解釈）
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function toMinutes(hhmm: string): number {
  const parts = hhmm.split(":");
  return Number(parts[0]) * 60 + Number(parts[1]);
}

/**
 * active_hours（staff.yaml・JST基準。message_time_stats.md集計に基づく値のため）が現在時刻を含むか。
 * to が24:00を超える表記（例：28:00）は翌日早朝への継続を表すため、前日分の窓も合わせて判定する。
 */
export function isWithinActiveHours(windows: ActiveHoursWindow[], nowUtc: Date): boolean {
  const jst = new Date(nowUtc.getTime() + JST_OFFSET_MS);
  const dayIdx = jst.getUTCDay();
  const minutesNow = jst.getUTCHours() * 60 + jst.getUTCMinutes();
  const todayName = DAY_NAMES[dayIdx] as string;
  const yesterdayName = DAY_NAMES[(dayIdx + 6) % 7] as string;

  for (const w of windows) {
    const fromMin = toMinutes(w.from);
    const toMin = toMinutes(w.to);
    if (w.days.includes(todayName) && minutesNow >= fromMin && minutesNow < Math.min(toMin, 24 * 60)) {
      return true;
    }
    if (w.days.includes(yesterdayName) && toMin > 24 * 60) {
      const rolloverEnd = toMin - 24 * 60;
      if (minutesNow < rolloverEnd) return true;
    }
  }
  return false;
}

/**
 * 静穏時間（§4.7）等、曜日を問わない毎日のHH:MM区間判定。JST基準（isWithinActiveHoursと同じ前提）。
 * from > to の場合は日をまたぐ区間として扱う（例：23:00〜08:00）。
 */
export function isWithinDailyWindow(fromHHMM: string, toHHMM: string, nowUtc: Date): boolean {
  const jst = new Date(nowUtc.getTime() + JST_OFFSET_MS);
  const nowMin = jst.getUTCHours() * 60 + jst.getUTCMinutes();
  const fromMin = toMinutes(fromHHMM);
  const toMin = toMinutes(toHHMM);
  if (fromMin <= toMin) return nowMin >= fromMin && nowMin < toMin;
  return nowMin >= fromMin || nowMin < toMin;
}
