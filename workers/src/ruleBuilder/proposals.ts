// rule-builder の発議・採決（decisions.md #68）。手続の記録（rule_proposals）はこの表を正とする。
// 判断（投票の開始・協議の延長）は人が rule-builder のボタンで行い、OpsBot は受付・投票の実施・集計だけを行う（C-3）。
// 協議のスレッドやボタン、会議場への自動投稿は作らない（協議は運営者が Discord で進める）。
//
// 状態の遷移：
//   （なし／withdrawn）─submit→ unei_discussion ─startModVote→ mod_vote ─集計→ participant_discussion ／ rejected
//   participant_discussion ─record→（開始の記録）─24時間後に startParticipantVote→ participant_vote ─集計→ passed ／ rejected
//   passed ─notifyResult(enacted)→ enacted
//   ルール施行令・国内法の改正案（改正ルール番号の種類で決める・decisions.md #69）は参加者協議・参加者投票を経ず、
//   mod_vote ─集計→ passed ／ rejected（運営投票は投票者の過半数）
//   可決より前（unei_discussion・mod_vote・participant_discussion・participant_vote）なら withdraw → withdrawn
//
// 操作した人が運営者であることは、rule-builder のセッションとは別に OpsBot でも判定し直す。

import type { Env } from "../env";
import { writeAuditLog } from "../auditLog";
import { sendChannelMessage } from "../discord/rest";
import { getChannels, getDeadlines } from "../settings";
import { abortVote, openParticipantVote, openUneiVote } from "../votes/open";
import { getVote, type VoteRow } from "../votes/repo";
import type { TallyResult } from "../votes/domain";
import { getMemberStatus, isSnowflake } from "./memberStatus";
import type {
  NotifyResultInput,
  RuleProposalKind,
  RecordFinalNumberInput,
  RecordParticipantDiscussionInput,
  RuleProposalErrorCode,
  RuleProposalResult,
  RuleProposalState,
  RuleProposalStatus,
  RuleVoteSummary,
  StartModVoteInput,
  StartParticipantVoteInput,
  SubmitProposalInput,
  WithdrawProposalInput,
} from "./types";

/** 承認事項の分類表のキー（運営投票は settings.approval_types、参加者投票は settings.participant_approval_types） */
export const RULE_APPROVAL_KEY = "rule_enactment";
/** 運営投票の承認事項（改正ルール番号の種類ごと・decisions.md #69）。参加者投票はルールだけで RULE_APPROVAL_KEY */
export const MOD_VOTE_APPROVAL_KEYS: Record<RuleProposalKind, string> = {
  ルール: RULE_APPROVAL_KEY,
  ルール施行令: "decree_enactment",
  国内法: "domestic_law_enactment",
};
/** 参加者協議の長さ（settings.deadlines.participant_discussion_hours がなければこの値） */
export const DEFAULT_PARTICIPANT_DISCUSSION_HOURS = 24;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RULE_NUMBER = /^令和(元|\d+)年(ルール|ルール施行令|国内法)第\d+号$/;

/** 改正ルール番号の種類（「令和8年ルール施行令第1号」→ ルール施行令）。読めなければルールとして扱う */
export function proposalKind(number: string | null | undefined): RuleProposalKind {
  const m = /^令和(?:元|\d+)年(ルール施行令|ルール|国内法)第\d+号$/.exec(number ?? "");
  return (m?.[1] as RuleProposalKind | undefined) ?? "ルール";
}

/** 参加者協議・参加者投票を経る（ルールの改正案だけ） */
export const needsParticipantVote = (kind: RuleProposalKind) => kind === "ルール";

/** 投票の件名に使う「ルールの改正案」「ルール施行令の改正案」「国内法の改正案」 */
const subjectOf = (row: { title: string; provisional_number: string }) =>
  `${proposalKind(row.provisional_number)}の改正案「${row.title}」（${row.provisional_number}・仮番号）`;
const HASH = /^sha256:[0-9a-f]{64}$/;

/** 取り下げられる状態（可決より前） */
const WITHDRAWABLE: ReadonlySet<RuleProposalState> = new Set([
  "unei_discussion",
  "mod_vote",
  "participant_discussion",
  "participant_vote",
]);

export interface RuleProposalRow {
  id: string;
  title: string;
  provisional_number: string;
  final_number: string | null;
  state: RuleProposalState;
  proposed_by: string;
  proposed_at: string;
  public_url: string;
  content_hash: string | null;
  mod_vote_id: number | null;
  mod_vote_started_by: string | null;
  participant_discussion_started_at: string | null;
  participant_discussion_started_by: string | null;
  participant_vote_id: number | null;
  participant_vote_started_by: string | null;
  decided_at: string | null;
  enacted_at: string | null;
  portal_url: string | null;
  withdrawn_at: string | null;
  withdrawn_by: string | null;
  updated_at: string;
}

function nowIso(now = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function addHours(iso: string, hours: number): string {
  return nowIso(new Date(new Date(iso).getTime() + hours * 3_600_000));
}

async function getRow(env: Env, id: string): Promise<RuleProposalRow | null> {
  return env.DB.prepare("SELECT * FROM rule_proposals WHERE id = ?").bind(id).first<RuleProposalRow>();
}

/**
 * 状態を条件付きで書き換える（競合したら false）。rule-builder の二重押しや、集計との競合で状態が飛ばないようにする。
 * set の値は SQL にそのまま埋めず bind する。
 */
async function transition(
  env: Env,
  id: string,
  from: readonly RuleProposalState[],
  set: Record<string, string | number | null>,
): Promise<boolean> {
  const cols = Object.keys(set);
  const sql =
    `UPDATE rule_proposals SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? ` +
    `WHERE id = ? AND state IN (${from.map(() => "?").join(", ")})`;
  const res = await env.DB.prepare(sql)
    .bind(...cols.map((c) => set[c] ?? null), nowIso(), id, ...from)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

function voteSummary(vote: VoteRow | null): RuleVoteSummary | null {
  if (!vote) return null;
  let result: RuleVoteSummary["result"] = null;
  if (vote.result) {
    try {
      const r = JSON.parse(vote.result) as Partial<TallyResult> & { cancelled?: boolean };
      result = {
        passed: r.passed === true,
        yes: Number(r.yes ?? 0),
        no: Number(r.no ?? 0),
        abstain: Number(r.abstain ?? 0),
        ...(r.cancelled ? { cancelled: true } : {}),
      };
    } catch {
      result = null;
    }
  }
  return {
    voteId: vote.id,
    method: vote.method,
    startedAt: vote.started_at,
    closesAt: vote.closes_at,
    status: vote.status,
    result,
  };
}

async function discussionHours(env: Env): Promise<number> {
  const d = (await getDeadlines(env)) as { participant_discussion_hours?: number };
  const h = Number(d.participant_discussion_hours);
  return Number.isFinite(h) && h > 0 ? h : DEFAULT_PARTICIPANT_DISCUSSION_HOURS;
}

async function toStatus(env: Env, row: RuleProposalRow): Promise<RuleProposalStatus> {
  const [modVote, participantVote] = await Promise.all([
    row.mod_vote_id ? getVote(env, row.mod_vote_id) : null,
    row.participant_vote_id ? getVote(env, row.participant_vote_id) : null,
  ]);
  const discussion =
    row.participant_discussion_started_at && row.participant_discussion_started_by
      ? { startedAt: row.participant_discussion_started_at, startedBy: row.participant_discussion_started_by }
      : null;
  return {
    proposalId: row.id,
    state: row.state,
    kind: proposalKind(row.final_number ?? row.provisional_number),
    title: row.title,
    provisionalNumber: row.provisional_number,
    finalNumber: row.final_number,
    publicUrl: row.public_url,
    contentHash: row.content_hash,
    proposedBy: row.proposed_by,
    proposedAt: row.proposed_at,
    modVote: voteSummary(modVote),
    participantDiscussion: discussion,
    participantVoteAvailableAt: discussion ? addHours(discussion.startedAt, await discussionHours(env)) : null,
    participantVote: voteSummary(participantVote),
    decidedAt: row.decided_at,
    enactedAt: row.enacted_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 投票が閉じているのに状態が進んでいなければ進める（集計のあとの書き込みが失敗した場合の取りこぼしを拾う）。
 * 打ち切った投票（取り下げ）は対象にしない。
 */
async function reconcile(env: Env, row: RuleProposalRow): Promise<RuleProposalRow> {
  const voteId = row.state === "mod_vote" ? row.mod_vote_id : row.state === "participant_vote" ? row.participant_vote_id : null;
  if (!voteId) return row;
  const vote = await getVote(env, voteId);
  if (!vote || vote.status !== "closed" || !vote.result) return row;
  let result: { passed?: boolean; cancelled?: boolean };
  try {
    result = JSON.parse(vote.result) as { passed?: boolean; cancelled?: boolean };
  } catch {
    return row;
  }
  if (result.cancelled) return row;
  await onRuleProposalVoteTallied(env, vote, { passed: result.passed === true });
  return (await getRow(env, row.id)) ?? row;
}

export async function getProposalStatus(env: Env, proposalId: string): Promise<RuleProposalStatus | null> {
  if (typeof proposalId !== "string" || !UUID.test(proposalId)) return null;
  const row = await getRow(env, proposalId);
  return row ? toStatus(env, await reconcile(env, row)) : null;
}

async function ok(env: Env, id: string): Promise<RuleProposalResult> {
  const row = await getRow(env, id);
  if (!row) return fail(env, "not_found", "発議の記録が見つかりません", null);
  return { ok: true, status: await toStatus(env, row) };
}

async function fail(
  env: Env,
  code: RuleProposalErrorCode,
  message: string,
  row: RuleProposalRow | null,
): Promise<RuleProposalResult> {
  return { ok: false, code, message, status: row ? await toStatus(env, row) : null };
}

const STATE_LABEL: Record<RuleProposalState, string> = {
  unei_discussion: "運営内協議中",
  mod_vote: "運営投票中",
  participant_discussion: "参加者協議中",
  participant_vote: "参加者投票中",
  passed: "可決（施行前）",
  enacted: "反映済み",
  rejected: "否決",
  withdrawn: "取り下げ",
};

const badState = (env: Env, row: RuleProposalRow, what: string) =>
  fail(env, "bad_state", `この改正案は${STATE_LABEL[row.state]}のため、${what}できません`, row);

/** 操作した人が今も運営者か（Discord API の失敗は例外のまま返し、rule-builder で断る） */
async function isUnei(env: Env, userId: string): Promise<boolean> {
  if (!isSnowflake(userId)) return false;
  const s = await getMemberStatus(env, userId);
  return s.isUnei && s.userId === userId;
}

const notUnei = (env: Env, row: RuleProposalRow | null) =>
  fail(env, "not_unei", "運営者のロールが確認できなかったため、受け付けられません", row);

function validPublicUrl(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 500) return false;
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
}

/** 投票の本文に載せる欄 */
function voteFields(row: { public_url: string; content_hash: string | null }, next: string) {
  const fields = [{ name: "改正案（公開リンク）", value: row.public_url }];
  if (row.content_hash) fields.push({ name: "内容のハッシュ", value: `\`${row.content_hash}\`` });
  fields.push({ name: "この後の手続", value: next });
  return fields;
}

// ---------- 発議 ----------

export async function submitProposal(env: Env, input: SubmitProposalInput): Promise<RuleProposalResult> {
  const { proposalId, title, provisionalNumber, proposedBy, publicUrl } = input ?? ({} as SubmitProposalInput);
  if (typeof proposalId !== "string" || !UUID.test(proposalId)) return fail(env, "bad_request", "改正案の ID が正しくありません", null);
  if (typeof title !== "string" || !title.trim() || title.length > 200) return fail(env, "bad_request", "題名が正しくありません", null);
  if (typeof provisionalNumber !== "string" || !RULE_NUMBER.test(provisionalNumber)) {
    return fail(env, "bad_request", "改正ルール番号が正しくありません", null);
  }
  if (!validPublicUrl(publicUrl)) return fail(env, "bad_request", "公開リンクが正しくありません", null);

  const existing = await getRow(env, proposalId);
  if (existing && existing.state !== "withdrawn" && existing.state !== "unei_discussion") return badState(env, existing, "発議");
  if (!(await isUnei(env, proposedBy))) return notUnei(env, existing);

  const at = nowIso();
  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO rule_proposals (id, title, provisional_number, state, proposed_by, proposed_at, public_url, updated_at)
       VALUES (?, ?, ?, 'unei_discussion', ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
      .bind(proposalId, title.trim(), provisionalNumber, proposedBy, at, publicUrl, at)
      .run();
  } else if (existing.state === "unei_discussion") {
    // 二重押し・やり直し：題名・番号・公開リンクだけ合わせる
    await transition(env, proposalId, ["unei_discussion"], { title: title.trim(), provisional_number: provisionalNumber, public_url: publicUrl });
    return ok(env, proposalId);
  } else {
    // 取り下げ後の発議し直し：手続の記録を初めからにする（前回の経過は監査記録に残っている）
    const changed = await transition(env, proposalId, ["withdrawn"], {
      title: title.trim(),
      provisional_number: provisionalNumber,
      final_number: null,
      state: "unei_discussion",
      proposed_by: proposedBy,
      proposed_at: at,
      public_url: publicUrl,
      content_hash: null,
      mod_vote_id: null,
      mod_vote_started_by: null,
      participant_discussion_started_at: null,
      participant_discussion_started_by: null,
      participant_vote_id: null,
      participant_vote_started_by: null,
      decided_at: null,
      enacted_at: null,
      portal_url: null,
      withdrawn_at: null,
      withdrawn_by: null,
    });
    if (!changed) return badState(env, (await getRow(env, proposalId))!, "発議");
  }
  await writeAuditLog(env, {
    actor: proposedBy,
    action: "rule_proposal_submitted",
    target: proposalId,
    detail: { title: title.trim(), provisionalNumber, publicUrl, resubmitted: !!existing },
  });
  return ok(env, proposalId);
}

// ---------- 運営投票 ----------

export async function startModVote(env: Env, input: StartModVoteInput): Promise<RuleProposalResult> {
  const { proposalId, method, startedBy, publicUrl, contentHash, provisionalNumber, title } = input ?? ({} as StartModVoteInput);
  const row = typeof proposalId === "string" ? await getRow(env, proposalId) : null;
  if (!row) return fail(env, "not_found", "発議の記録が見つかりません", null);
  if (method !== "secret" && method !== "quick") return fail(env, "bad_request", "投票の方式が正しくありません", row);
  if (typeof contentHash !== "string" || !HASH.test(contentHash)) return fail(env, "bad_request", "内容のハッシュが正しくありません", row);
  if (!validPublicUrl(publicUrl)) return fail(env, "bad_request", "公開リンクが正しくありません", row);
  // 番号・題名は省略できる（省略したら発議のときのまま）。種類で承認事項と手続が決まるので、固定した内容に合わせる
  if (provisionalNumber !== undefined && (typeof provisionalNumber !== "string" || !RULE_NUMBER.test(provisionalNumber))) {
    return fail(env, "bad_request", "改正ルール番号が正しくありません", row);
  }
  if (title !== undefined && (typeof title !== "string" || !title.trim() || title.length > 200)) {
    return fail(env, "bad_request", "題名が正しくありません", row);
  }
  if (row.state !== "unei_discussion") return badState(env, row, "運営投票を開始");
  if (!(await isUnei(env, startedBy))) return notUnei(env, row);

  // 先に状態を進めて二重開始を防ぐ。投票を始められなかったら戻す
  const fixed = {
    title: title?.trim() ?? row.title,
    provisional_number: provisionalNumber ?? row.provisional_number,
  };
  const claimed = await transition(env, proposalId, ["unei_discussion"], {
    state: "mod_vote",
    content_hash: contentHash,
    public_url: publicUrl,
    mod_vote_started_by: startedBy,
    ...fixed,
  });
  if (!claimed) return badState(env, (await getRow(env, proposalId))!, "運営投票を開始");

  const kind = proposalKind(fixed.provisional_number);
  const opened = await openUneiVote(env, {
    approvalKey: MOD_VOTE_APPROVAL_KEYS[kind],
    subject: subjectOf(fixed),
    method,
    operatorId: startedBy,
    ruleProposalId: proposalId,
    extraFields: voteFields(
      { public_url: publicUrl, content_hash: contentHash },
      needsParticipantVote(kind)
        ? "可決したら参加者協議を経て参加者投票を行います。否決なら参加者には回しません。"
        : `${kind}の改正は運営投票で決まります。可決したら施行日に ds-craft/rules へ反映します（施行日が未来なら、それまでポータルに施行前として載せます）。`,
    ),
  });
  if (!opened.ok) {
    // 番号・題名も発議のときに戻す
    await transition(env, proposalId, ["mod_vote"], {
      state: "unei_discussion",
      content_hash: null,
      mod_vote_started_by: null,
      title: row.title,
      provisional_number: row.provisional_number,
    });
    return fail(env, "vote_failed", opened.message, await getRow(env, proposalId));
  }
  await transition(env, proposalId, ["mod_vote"], { mod_vote_id: opened.voteId });
  await writeAuditLog(env, {
    actor: startedBy,
    action: "rule_proposal_mod_vote_started",
    target: proposalId,
    detail: { voteId: opened.voteId, method, contentHash, approvalKey: MOD_VOTE_APPROVAL_KEYS[kind], provisionalNumber: fixed.provisional_number },
  });
  return ok(env, proposalId);
}

// ---------- 参加者協議・参加者投票 ----------

export async function recordParticipantDiscussion(env: Env, input: RecordParticipantDiscussionInput): Promise<RuleProposalResult> {
  const { proposalId, startedBy, startedAt } = input ?? ({} as RecordParticipantDiscussionInput);
  const row = typeof proposalId === "string" ? await getRow(env, proposalId) : null;
  if (!row) return fail(env, "not_found", "発議の記録が見つかりません", null);
  if (row.state !== "participant_discussion") return badState(env, row, "参加者協議の開始を記録");

  const t = typeof startedAt === "string" ? new Date(startedAt) : new Date(NaN);
  if (Number.isNaN(t.getTime())) return fail(env, "bad_request", "開始時刻が正しくありません", row);
  if (t.getTime() > Date.now() + 60_000) return fail(env, "bad_request", "開始時刻を未来にはできません", row);
  const modVote = row.mod_vote_id ? await getVote(env, row.mod_vote_id) : null;
  if (modVote?.tallied_at && t.getTime() < new Date(modVote.tallied_at).getTime()) {
    return fail(env, "bad_request", "開始時刻を運営投票の締切より前にはできません", row);
  }
  if (!(await isUnei(env, startedBy))) return notUnei(env, row);

  const corrected = row.participant_discussion_started_at !== null;
  const changed = await transition(env, proposalId, ["participant_discussion"], {
    participant_discussion_started_at: nowIso(t),
    participant_discussion_started_by: startedBy,
  });
  if (!changed) return badState(env, (await getRow(env, proposalId))!, "参加者協議の開始を記録");
  await writeAuditLog(env, {
    actor: startedBy,
    action: corrected ? "rule_proposal_participant_discussion_corrected" : "rule_proposal_participant_discussion_started",
    target: proposalId,
    detail: { startedAt: nowIso(t), previous: row.participant_discussion_started_at },
  });
  return ok(env, proposalId);
}

export async function startParticipantVote(env: Env, input: StartParticipantVoteInput): Promise<RuleProposalResult> {
  const { proposalId, startedBy } = input ?? ({} as StartParticipantVoteInput);
  const row = typeof proposalId === "string" ? await getRow(env, proposalId) : null;
  if (!row) return fail(env, "not_found", "発議の記録が見つかりません", null);
  if (row.state !== "participant_discussion") return badState(env, row, "参加者投票を開始");
  if (!row.participant_discussion_started_at) {
    return fail(env, "bad_state", "参加者協議の開始が記録されていないため、参加者投票を開始できません", row);
  }
  // 協議の開始から規定の時間がたったかは OpsBot の記録で確かめる（rule-builder の画面の表示には頼らない）
  const hours = await discussionHours(env);
  const availableAt = addHours(row.participant_discussion_started_at, hours);
  if (Date.now() < new Date(availableAt).getTime()) {
    return fail(env, "too_early", `参加者協議の開始から${hours}時間がたっていないため、参加者投票を開始できません`, row);
  }
  if (!(await isUnei(env, startedBy))) return notUnei(env, row);

  const claimed = await transition(env, proposalId, ["participant_discussion"], {
    state: "participant_vote",
    participant_vote_started_by: startedBy,
  });
  if (!claimed) return badState(env, (await getRow(env, proposalId))!, "参加者投票を開始");

  const opened = await openParticipantVote(env, {
    approvalKey: RULE_APPROVAL_KEY,
    subject: subjectOf(row),
    operatorId: startedBy,
    ruleProposalId: proposalId,
    extraFields: voteFields(row, "可決したら施行日に ds-craft/rules へ反映します（施行日が未来なら、それまでポータルに施行前として載せます）。"),
  });
  if (!opened.ok) {
    await transition(env, proposalId, ["participant_vote"], { state: "participant_discussion", participant_vote_started_by: null });
    return fail(env, "vote_failed", opened.message, await getRow(env, proposalId));
  }
  await transition(env, proposalId, ["participant_vote"], { participant_vote_id: opened.voteId });
  await writeAuditLog(env, {
    actor: startedBy,
    action: "rule_proposal_participant_vote_started",
    target: proposalId,
    detail: { voteId: opened.voteId },
  });
  return ok(env, proposalId);
}

// ---------- 取り下げ ----------

export async function withdrawProposal(env: Env, input: WithdrawProposalInput): Promise<RuleProposalResult> {
  const { proposalId, withdrawnBy } = input ?? ({} as WithdrawProposalInput);
  const row = typeof proposalId === "string" ? await getRow(env, proposalId) : null;
  if (!row) return fail(env, "not_found", "発議の記録が見つかりません", null);
  if (row.state === "withdrawn") return ok(env, proposalId);
  if (!WITHDRAWABLE.has(row.state)) return badState(env, row, "取り下げ");
  if (!(await isUnei(env, withdrawnBy))) return notUnei(env, row);

  const at = nowIso();
  const changed = await transition(env, proposalId, [...WITHDRAWABLE], { state: "withdrawn", withdrawn_at: at, withdrawn_by: withdrawnBy });
  if (!changed) return badState(env, (await getRow(env, proposalId))!, "取り下げ");

  // 進行中の投票は集計せずに打ち切る（締切処理と競合して既に閉じていれば何もしない）
  const aborted: number[] = [];
  for (const voteId of [row.mod_vote_id, row.participant_vote_id]) {
    if (voteId && (await abortVote(env, voteId, withdrawnBy, "改正案の取り下げ"))) aborted.push(voteId);
  }
  await writeAuditLog(env, {
    actor: withdrawnBy,
    action: "rule_proposal_withdrawn",
    target: proposalId,
    detail: { previousState: row.state, abortedVotes: aborted },
  });
  return ok(env, proposalId);
}

// ---------- 投票の集計（closeAndTallyVote から呼ぶ） ----------

/**
 * 改正案に紐づく投票が集計されたら、手続の状態を進める。
 * 運営投票：可決 → participant_discussion（開始の記録前）、否決 → rejected。
 *   ルール施行令・国内法の改正案は、可決 → passed（参加者協議・参加者投票を経ない・decisions.md #69）。
 * 参加者投票：可決 → passed、否決 → rejected。
 * 取り下げ済みなど、状態が合わないときは何もしない（集計結果は投票側に残る）。
 */
export async function onRuleProposalVoteTallied(env: Env, vote: VoteRow, result: { passed: boolean }): Promise<void> {
  if (!vote.rule_proposal_id) return;
  const row = await getRow(env, vote.rule_proposal_id);
  if (!row) return;
  const at = nowIso();
  let next: RuleProposalState | null = null;
  if (row.mod_vote_id === vote.id && row.state === "mod_vote") {
    // 手続は運営投票の集計で分かれる（#69 より前に参加者協議へ進んだ施行令の改正案は、そのまま参加者投票まで進める）
    const decidesHere = !needsParticipantVote(proposalKind(row.provisional_number));
    next = !result.passed ? "rejected" : decidesHere ? "passed" : "participant_discussion";
    await transition(env, row.id, ["mod_vote"], { state: next, decided_at: next === "participant_discussion" ? null : at });
  } else if (row.participant_vote_id === vote.id && row.state === "participant_vote") {
    next = result.passed ? "passed" : "rejected";
    await transition(env, row.id, ["participant_vote"], { state: next, decided_at: at });
  }
  if (next) {
    await writeAuditLog(env, {
      actor: "system",
      action: "rule_proposal_vote_tallied",
      target: row.id,
      detail: { voteId: vote.id, passed: result.passed, state: next },
    });
  }
}

// ---------- 可決後 ----------

export async function recordFinalNumber(env: Env, input: RecordFinalNumberInput): Promise<RuleProposalResult> {
  const { proposalId, finalNumber } = input ?? ({} as RecordFinalNumberInput);
  const row = typeof proposalId === "string" ? await getRow(env, proposalId) : null;
  if (!row) return fail(env, "not_found", "発議の記録が見つかりません", null);
  if (typeof finalNumber !== "string" || !RULE_NUMBER.test(finalNumber)) return fail(env, "bad_request", "改正ルール番号が正しくありません", row);
  if (row.state !== "passed") return badState(env, row, "改正ルール番号を確定");
  if (row.final_number === finalNumber) return ok(env, proposalId);
  await transition(env, proposalId, ["passed"], { final_number: finalNumber });
  await writeAuditLog(env, {
    actor: "rule-builder",
    action: "rule_proposal_number_fixed",
    target: proposalId,
    detail: { provisionalNumber: row.provisional_number, finalNumber },
  });
  return ok(env, proposalId);
}

export async function notifyResult(env: Env, input: NotifyResultInput): Promise<RuleProposalResult> {
  const row = input && typeof input.proposalId === "string" ? await getRow(env, input.proposalId) : null;
  if (!row) return fail(env, "not_found", "発議の記録が見つかりません", null);
  const channels = await getChannels(env);

  if (input.kind === "enacted") {
    if (!validPublicUrl(input.portalUrl)) return fail(env, "bad_request", "ポータルのリンクが正しくありません", row);
    if (row.state === "enacted") return ok(env, row.id); // 再試行：告知は1回だけ
    if (row.state !== "passed") return badState(env, row, "反映済みに");
    const changed = await transition(env, row.id, ["passed"], {
      state: "enacted",
      enacted_at: nowIso(),
      portal_url: input.portalUrl,
      final_number: input.finalNumber || row.final_number,
    });
    if (!changed) return ok(env, row.id);
    const channelId = channels.rule_notice || channels.participant_vote_hall;
    const number = input.finalNumber || row.final_number || row.provisional_number;
    if (channelId) {
      await sendChannelMessage(
        env.DISCORD_BOT_TOKEN,
        channelId,
        `【ルールの施行】${number}「${row.title}」を施行しました（施行日：${input.enforcementDate}）。\n${input.portalUrl}`,
      ).catch((e) => console.error("rule enactment notice failed", e));
    }
    await writeAuditLog(env, { actor: "rule-builder", action: "rule_proposal_enacted", target: row.id, detail: { portalUrl: input.portalUrl, finalNumber: number } });
    return ok(env, row.id);
  }

  if (input.kind === "failed") {
    const message = typeof input.message === "string" ? input.message.slice(0, 1500) : "";
    if (!message) return fail(env, "bad_request", "知らせる内容がありません", row);
    const channelId = channels.unei_only || channels.notify_default;
    if (channelId) {
      const link = input.detailUrl && validPublicUrl(input.detailUrl) ? `\n${input.detailUrl}` : "";
      await sendChannelMessage(
        env.DISCORD_BOT_TOKEN,
        channelId,
        `【rule-builder】改正案「${row.title}」の反映を止めました。\n${message}${link}`,
      );
    }
    await writeAuditLog(env, { actor: "rule-builder", action: "rule_proposal_reflect_failed", target: row.id, detail: { message } });
    return ok(env, row.id);
  }

  return fail(env, "bad_request", "知らせる種類が正しくありません", row);
}
