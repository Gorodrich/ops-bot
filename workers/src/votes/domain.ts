// 秘密投票（§5.2）・短縮投票（§5.3）の集計ロジック（純粋関数・§11-5：ユニットテスト必須）。
// D1・Discordへの依存を持たない（kaihatsu/domain.ts と同じ方針）。

import type { QuorumType } from "../settings";

export interface TallyInput {
  yes: number;
  no: number;
  abstain: number; // 明示的棄権（短縮投票のみ意味を持つ・§5.3）
  eligibleCount: number; // 母数（休暇者除外済み・本人除外対象は事前に除いた数・§5.1）
  quorumType: QuorumType;
  threshold: number; // supermajority系の割合。voters_majority/unanimousでは無視される
}

export interface TallyResult {
  passed: boolean;
  yes: number;
  no: number;
  abstain: number;
  denominator: number;
  quorumType: QuorumType;
}

/**
 * §5.2-6：棄権者を除く運営投票者の過半数で可決（通常の秘密投票）。
 * §5.3：短縮投票は「明示的に棄権の意思を表示した者を除く運営者の総数の過半数」で、母数の
 *       計算が異なるため別ロジックとして実装する（決定事項）。
 * §5.5：特別多数（3分の2以上等）・全会一致（本人除外）は分類表の quorum_type/threshold で切り替える。
 */
export function tallyVote(input: TallyInput): TallyResult {
  const { yes, no, abstain, eligibleCount, quorumType, threshold } = input;

  if (quorumType === "voters_majority") {
    const denominator = yes + no; // 締切までに投票しなかった者は棄権とみなす（§5.2-4）
    return { passed: denominator > 0 && yes * 2 > denominator, yes, no, abstain, denominator, quorumType };
  }
  if (quorumType === "supermajority_voters") {
    const denominator = yes + no;
    return { passed: denominator > 0 && yes >= denominator * threshold, yes, no, abstain, denominator, quorumType };
  }
  if (quorumType === "total_majority_excl_abstain") {
    const denominator = eligibleCount - abstain; // §5.3：明示的棄権者を除く総数
    return { passed: denominator > 0 && yes * 2 > denominator, yes, no, abstain, denominator, quorumType };
  }
  if (quorumType === "supermajority_total") {
    const denominator = eligibleCount;
    return { passed: denominator > 0 && yes >= denominator * threshold, yes, no, abstain, denominator, quorumType };
  }
  if (quorumType === "total_majority_incl_abstain") {
    // 参加者投票「ワールドデータの外部利用（非参加者含む）」（§5.5）：棄権者も母数に含めた総数の
    // “過半数”＝厳密に半数を超える賛成を要求する（thresholdは使わない）。supermajority_total は
    // 「◯割以上」の特別多数用に yes >= denominator * threshold（以上）で判定するため、threshold=0.5を
    // 渡すとちょうど半数の賛成で可決してしまい「過半数」の要件を満たさない。そのため別ロジックとする。
    const denominator = eligibleCount;
    return { passed: denominator > 0 && yes * 2 > denominator, yes, no, abstain, denominator, quorumType };
  }
  // unanimous_excl_target：本人を除くすべての運営者の賛成（§5.5：処罰・解任／再任）
  const denominator = eligibleCount;
  return { passed: denominator > 0 && yes === denominator, yes, no, abstain, denominator, quorumType };
}

/**
 * 母数の算出（§5.1）：staff.yamlではなくDiscordの実際の「運営」ロール保有者から算出し、
 * 休暇中（on_leave.active）の者のみD1 staffテーブルを参照して除外する。exclude_self対象
 * （§5.5：処罰・解任・再任等の本人）も母数・投票権から除く。
 */
export function computeEligibleVoters(args: {
  uneiMemberIds: string[];
  onLeaveIds: ReadonlySet<string>;
  excludeTarget?: string | null;
}): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of args.uneiMemberIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (args.onLeaveIds.has(id)) continue;
    if (args.excludeTarget && id === args.excludeTarget) continue;
    result.push(id);
  }
  return result;
}

export function isPastDeadline(nowIso: string, deadlineIso: string | null): boolean {
  if (!deadlineIso) return false;
  return new Date(nowIso).getTime() >= new Date(deadlineIso).getTime();
}

export function addMinutesIso(fromIso: string, minutes: number): string {
  return new Date(new Date(fromIso).getTime() + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function addHoursIso(fromIso: string, hours: number): string {
  return addMinutesIso(fromIso, hours * 60);
}

export type BallotChoice = "yes" | "no" | "abstain";

export function isValidBallotChoice(v: string): v is BallotChoice {
  return v === "yes" || v === "no" || v === "abstain";
}
