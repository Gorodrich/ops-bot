// rule-builder（ds-craft/rule-builder の apps/server）向け RPC の型。
// rule-builder 側の apps/server/src/opsbot/types.ts に同じ内容の写しを置く。変更するときは両方を直すこと。

/** getMemberStatus の戻り値。rule-builder は isUnei が true の人だけをログインさせる */
export interface MemberStatus {
  /** 「運営」ロールを持つ（サブ垢の場合は、連携先のメイン垢が現在も持つ） */
  isUnei: boolean;
  /** 休暇中（D1 staff.on_leave_active）。isUnei が false のときは常に false */
  onLeave: boolean;
  /** 判定に使った本人の Discord ユーザー ID。サブ垢でログインした場合はメイン垢の ID */
  userId: string;
  /** サブ垢からメイン垢に解決したか */
  viaSubaccount: boolean;
  /** サーバーでの表示名（ニックネーム → 表示名 → ユーザー名の順）。ギルドにいなければ空 */
  displayName: string;
  /** アイコンの URL（サーバー別のアイコンがあればそれ）。ギルドにいなければ null */
  avatarUrl: string | null;
}

// ---------- 発議・採決（decisions.md #68） ----------

/**
 * 手続の状態（OpsBot の rule_proposals.state）。
 * participant_discussion は、開始の記録前（participantDiscussion が null）と記録後の2段階がある。
 */
export type RuleProposalState =
  | "unei_discussion"
  | "mod_vote"
  | "participant_discussion"
  | "participant_vote"
  | "passed"
  | "enacted"
  | "rejected"
  | "withdrawn";

/** 投票の結果（取り下げで打ち切った投票は cancelled） */
export interface RuleVoteResult {
  passed: boolean;
  yes: number;
  no: number;
  abstain: number;
  cancelled?: boolean;
}

export interface RuleVoteSummary {
  voteId: number;
  method: "secret" | "quick";
  startedAt: string;
  closesAt: string;
  status: "open" | "closed";
  result: RuleVoteResult | null;
}

/** getProposalStatus の戻り値。時刻はすべて ISO 8601（UTC） */
export interface RuleProposalStatus {
  proposalId: string;
  state: RuleProposalState;
  title: string;
  provisionalNumber: string;
  finalNumber: string | null;
  publicUrl: string;
  contentHash: string | null;
  proposedBy: string;
  proposedAt: string;
  modVote: RuleVoteSummary | null;
  participantDiscussion: { startedAt: string; startedBy: string } | null;
  /** 参加者投票を始められるようになる時刻（参加者協議の開始の記録後だけ） */
  participantVoteAvailableAt: string | null;
  participantVote: RuleVoteSummary | null;
  decidedAt: string | null;
  enactedAt: string | null;
  updatedAt: string;
}

/** 断った理由。画面は message をそのまま出す */
export type RuleProposalErrorCode =
  | "not_found" // 発議の記録がない
  | "bad_state" // 今の状態ではできない
  | "not_unei" // 操作した人が運営者ではない（OpsBot でも判定し直す）
  | "too_early" // 参加者協議の開始から規定の時間がたっていない
  | "bad_request" // 入力が正しくない
  | "vote_failed"; // 投票を始められなかった（チャンネル未設定・母数0人・投稿の失敗）

export type RuleProposalResult =
  | { ok: true; status: RuleProposalStatus }
  | { ok: false; code: RuleProposalErrorCode; message: string; status: RuleProposalStatus | null };

export interface SubmitProposalInput {
  proposalId: string;
  title: string;
  provisionalNumber: string;
  proposedBy: string;
  publicUrl: string;
}

export interface StartModVoteInput {
  proposalId: string;
  method: "secret" | "quick";
  startedBy: string;
  publicUrl: string;
  /** 固定した内容のハッシュ（sha256:…）。投票の本文に載せる */
  contentHash: string;
}

export interface RecordParticipantDiscussionInput {
  proposalId: string;
  startedBy: string;
  /** 会議場に投稿した時刻。押し忘れに備えて過去にできる（未来は不可） */
  startedAt: string;
}

export interface StartParticipantVoteInput {
  proposalId: string;
  startedBy: string;
}

export interface WithdrawProposalInput {
  proposalId: string;
  withdrawnBy: string;
}

export interface RecordFinalNumberInput {
  proposalId: string;
  finalNumber: string;
}

/**
 * 結果の告知（F-57・F-58）。
 *   enacted：反映の完了。参加者向けに、ポータルのページへのリンク付きで告知し、状態を enacted にする
 *   failed：反映を止めた・失敗が続いた。運営者向けに知らせる（状態は変えない）
 */
export type NotifyResultInput =
  | { proposalId: string; kind: "enacted"; portalUrl: string; finalNumber: string; enforcementDate: string }
  | { proposalId: string; kind: "failed"; message: string; detailUrl: string | null };

/** Service Binding（entrypoint: "RuleBuilderRpc"）で rule-builder から呼べるメソッド */
export interface RuleBuilderRpcMethods {
  getMemberStatus(discordUserId: string): Promise<MemberStatus>;
  submitProposal(input: SubmitProposalInput): Promise<RuleProposalResult>;
  startModVote(input: StartModVoteInput): Promise<RuleProposalResult>;
  recordParticipantDiscussion(input: RecordParticipantDiscussionInput): Promise<RuleProposalResult>;
  startParticipantVote(input: StartParticipantVoteInput): Promise<RuleProposalResult>;
  withdrawProposal(input: WithdrawProposalInput): Promise<RuleProposalResult>;
  getProposalStatus(proposalId: string): Promise<RuleProposalStatus | null>;
  recordFinalNumber(input: RecordFinalNumberInput): Promise<RuleProposalResult>;
  notifyResult(input: NotifyResultInput): Promise<RuleProposalResult>;
}
