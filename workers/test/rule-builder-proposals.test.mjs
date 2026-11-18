// rule-builder の発議・採決（decisions.md #68）。
// 発議 → 運営投票 → 参加者協議 → 参加者投票 → 可決 → 反映済み の流れと、断る場面（状態・24時間・運営者でない）・取り下げを確かめる。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, mockFetch, setSetting } from "./helpers/d1.mjs";
import {
  getProposalStatus,
  notifyResult,
  recordFinalNumber,
  recordParticipantDiscussion,
  startModVote,
  startParticipantVote,
  submitProposal,
  withdrawProposal,
} from "../src/ruleBuilder/proposals";
import { castBallot, getVote } from "../src/votes/repo";
import { closeAndTallyVote } from "../src/votes/voteShared";

const ROLES = { hito: "R_HITO", kari_sanka: "R_KARI", sub_aka: "R_SUB", unei: "R_UNEI", unei_sub: "R_UNEI_SUB" };
const GUILD = "G1";
const UNEI_A = "100000000000000001";
const UNEI_B = "100000000000000002";
const UNEI_C = "100000000000000003";
const HITO = "100000000000000010";
const OTHER = "100000000000000099";
const ID = "6f1c1e0a-2b3c-4d5e-8f90-0a1b2c3d4e5f";
const URL_PUBLIC = "https://builder.ds2.uk/#/p/abcdefghijklmnopqrstuv";
const HASH = `sha256:${"a".repeat(64)}`;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const submitInput = (over = {}) => ({
  proposalId: ID,
  title: "基本ルールの一部を改正するルール",
  provisionalNumber: "令和8年ルール第4号",
  proposedBy: UNEI_A,
  publicUrl: URL_PUBLIC,
  ...over,
});

describe("rule-builder の発議・採決", () => {
  let env;
  let fetchMock;
  let members;
  let failPosts;

  beforeEach(() => {
    env = createTestEnv();
    setSetting(env, "roles", ROLES);
    setSetting(env, "discord_guild_id", GUILD);
    setSetting(env, "channels", { vote_hall: "C_VOTE", participant_vote_hall: "C_PVOTE", unei_only: "C_UNEI", rule_notice: "C_NOTICE" });
    setSetting(env, "deadlines", { vote_hours: 24, quick_vote_minutes: 15, provisional_confirm_hours: 72, revoke_window_hours: 24, conflict_hold_hours: 72, subaccount_confirm_hours: 24 });
    setSetting(env, "approval_types", {
      rule_enactment: { label: "ルールの制定・改正", method: "A", quorum_type: "supermajority_voters", threshold: 0.6667, exclude_self: false, participant_vote_required: true },
    });
    setSetting(env, "participant_approval_types", { rule_enactment: { label: "ルール改正", method: "A", quorum_type: "voters_majority", exclude_self: false } });
    members = {
      [UNEI_A]: { user: { id: UNEI_A, username: "a" }, roles: ["R_UNEI"] },
      [UNEI_B]: { user: { id: UNEI_B, username: "b" }, roles: ["R_UNEI"] },
      [UNEI_C]: { user: { id: UNEI_C, username: "c" }, roles: ["R_UNEI"] },
      [HITO]: { user: { id: HITO, username: "h" }, roles: ["R_HITO"] },
      [OTHER]: { user: { id: OTHER, username: "o" }, roles: [] },
    };
    failPosts = false;
    fetchMock = mockFetch((url, init) => {
      const one = url.match(/\/guilds\/G1\/members\/(\d+)$/);
      if (one) return members[one[1]] ? json(members[one[1]]) : new Response("not found", { status: 404 });
      if (/\/guilds\/G1\/members\?/.test(url)) return json(Object.values(members));
      if (failPosts && /\/channels\/[^/]+\/messages$/.test(url) && init.method === "POST") return new Response("boom", { status: 500 });
      return undefined;
    });
  });

  afterEach(() => fetchMock.restore());

  const posts = (channel) => fetchMock.calls.filter((c) => c.method === "POST" && c.url.endsWith(`/channels/${channel}/messages`));

  async function toParticipantDiscussion() {
    await submitProposal(env, submitInput());
    const r = await startModVote(env, { proposalId: ID, method: "secret", startedBy: UNEI_A, publicUrl: URL_PUBLIC, contentHash: HASH });
    const voteId = r.status.modVote.voteId;
    await castBallot(env, voteId, UNEI_A, "yes");
    await castBallot(env, voteId, UNEI_B, "yes");
    await castBallot(env, voteId, UNEI_C, "yes");
    await closeAndTallyVote(env, await getVote(env, voteId));
    return voteId;
  }

  /** 参加者協議の開始を、運営投票の締切・現在時刻より hours 時間前にする */
  async function discussionStartedHoursAgo(hours, modVoteId) {
    const past = new Date(Date.now() - hours * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    env.DB.raw.prepare("UPDATE votes SET tallied_at = ? WHERE id = ?").run(past, modVoteId);
    return recordParticipantDiscussion(env, { proposalId: ID, startedBy: UNEI_B, startedAt: past });
  }

  it("発議すると運営内協議になり、Discord には投稿しない", async () => {
    const r = await submitProposal(env, submitInput());
    expect(r.ok).toBe(true);
    expect(r.status).toMatchObject({ state: "unei_discussion", proposedBy: UNEI_A, publicUrl: URL_PUBLIC, modVote: null });
    expect(fetchMock.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("運営者でない人の発議は断る", async () => {
    const r = await submitProposal(env, submitInput({ proposedBy: OTHER }));
    expect(r).toMatchObject({ ok: false, code: "not_unei" });
    expect(await getProposalStatus(env, ID)).toBeNull();
  });

  it("入力が正しくなければ断る", async () => {
    expect(await submitProposal(env, submitInput({ proposalId: "x" }))).toMatchObject({ ok: false, code: "bad_request" });
    expect(await submitProposal(env, submitInput({ provisionalNumber: "第4号" }))).toMatchObject({ ok: false, code: "bad_request" });
    expect(await submitProposal(env, submitInput({ publicUrl: "http://example.com" }))).toMatchObject({ ok: false, code: "bad_request" });
  });

  it("運営投票を開始すると、投票場に公開リンクとハッシュ付きで投稿し、内容のハッシュを記録する", async () => {
    await submitProposal(env, submitInput());
    const r = await startModVote(env, { proposalId: ID, method: "secret", startedBy: UNEI_B, publicUrl: URL_PUBLIC, contentHash: HASH });
    expect(r.ok).toBe(true);
    expect(r.status).toMatchObject({ state: "mod_vote", contentHash: HASH });
    expect(r.status.modVote).toMatchObject({ method: "secret", status: "open" });
    const body = JSON.parse(posts("C_VOTE")[0].body);
    const fields = body.embeds[0].fields.map((f) => f.value).join("\n");
    expect(fields).toContain(URL_PUBLIC);
    expect(fields).toContain(HASH);
    const vote = await getVote(env, r.status.modVote.voteId);
    expect(vote).toMatchObject({ approval_key: "rule_enactment", quorum_type: "supermajority_voters", rule_proposal_id: ID });
  });

  it("短縮投票は短縮投票の定足数で始める", async () => {
    await submitProposal(env, submitInput());
    const r = await startModVote(env, { proposalId: ID, method: "quick", startedBy: UNEI_A, publicUrl: URL_PUBLIC, contentHash: HASH });
    const vote = await getVote(env, r.status.modVote.voteId);
    expect(vote).toMatchObject({ method: "quick", quorum_type: "total_majority_excl_abstain" });
  });

  it("運営投票を二重に始めない", async () => {
    await submitProposal(env, submitInput());
    await startModVote(env, { proposalId: ID, method: "secret", startedBy: UNEI_A, publicUrl: URL_PUBLIC, contentHash: HASH });
    const r = await startModVote(env, { proposalId: ID, method: "secret", startedBy: UNEI_A, publicUrl: URL_PUBLIC, contentHash: HASH });
    expect(r).toMatchObject({ ok: false, code: "bad_state" });
    expect(posts("C_VOTE")).toHaveLength(1);
  });

  it("投票場に投稿できなければ運営内協議に戻し、投票は打ち切る", async () => {
    await submitProposal(env, submitInput());
    failPosts = true;
    const r = await startModVote(env, { proposalId: ID, method: "secret", startedBy: UNEI_A, publicUrl: URL_PUBLIC, contentHash: HASH });
    expect(r).toMatchObject({ ok: false, code: "vote_failed" });
    expect(r.status).toMatchObject({ state: "unei_discussion", contentHash: null, modVote: null });
    const open = env.DB.raw.prepare("SELECT COUNT(*) AS n FROM votes WHERE status = 'open'").get();
    expect(open.n).toBe(0);
  });

  it("運営投票が否決なら否決で終え、参加者には回さない", async () => {
    await submitProposal(env, submitInput());
    const r = await startModVote(env, { proposalId: ID, method: "secret", startedBy: UNEI_A, publicUrl: URL_PUBLIC, contentHash: HASH });
    const voteId = r.status.modVote.voteId;
    await castBallot(env, voteId, UNEI_A, "yes");
    await castBallot(env, voteId, UNEI_B, "no");
    await closeAndTallyVote(env, await getVote(env, voteId));
    const s = await getProposalStatus(env, ID);
    expect(s.state).toBe("rejected");
    expect(s.modVote.result).toMatchObject({ passed: false, yes: 1, no: 1 });
    expect(await recordParticipantDiscussion(env, { proposalId: ID, startedBy: UNEI_A, startedAt: new Date().toISOString() })).toMatchObject({ ok: false, code: "bad_state" });
  });

  it("運営投票が可決すると参加者協議（開始の記録前）になる", async () => {
    await toParticipantDiscussion();
    const s = await getProposalStatus(env, ID);
    expect(s).toMatchObject({ state: "participant_discussion", participantDiscussion: null, participantVoteAvailableAt: null });
  });

  it("集計のあとで状態を進められなかったときも、問い合わせで合わせ直す", async () => {
    await submitProposal(env, submitInput());
    const r = await startModVote(env, { proposalId: ID, method: "secret", startedBy: UNEI_A, publicUrl: URL_PUBLIC, contentHash: HASH });
    // 集計だけ済んで状態が mod_vote のまま残った場面
    env.DB.raw
      .prepare("UPDATE votes SET status = 'closed', result = ?, tallied_at = ? WHERE id = ?")
      .run(JSON.stringify({ passed: true, yes: 3, no: 0, abstain: 0 }), new Date().toISOString(), r.status.modVote.voteId);
    expect((await getProposalStatus(env, ID)).state).toBe("participant_discussion");
  });

  it("参加者協議の開始の記録：未来は不可、運営投票の締切より前も不可、記録し直せる", async () => {
    const modVoteId = await toParticipantDiscussion();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect(await recordParticipantDiscussion(env, { proposalId: ID, startedBy: UNEI_A, startedAt: future })).toMatchObject({ ok: false, code: "bad_request" });
    const before = new Date(Date.now() - 3_600_000).toISOString();
    expect(await recordParticipantDiscussion(env, { proposalId: ID, startedBy: UNEI_A, startedAt: before })).toMatchObject({ ok: false, code: "bad_request" });

    const first = await recordParticipantDiscussion(env, { proposalId: ID, startedBy: UNEI_A, startedAt: new Date().toISOString() });
    expect(first.ok).toBe(true);
    expect(first.status.participantDiscussion.startedBy).toBe(UNEI_A);
    const fixed = await discussionStartedHoursAgo(2, modVoteId);
    expect(fixed.ok).toBe(true);
    expect(fixed.status.participantDiscussion.startedBy).toBe(UNEI_B);
    const audit = env.DB.raw.prepare("SELECT action FROM audit_log WHERE target = ? ORDER BY id").all(ID).map((r) => r.action);
    expect(audit).toContain("rule_proposal_participant_discussion_corrected");
  });

  it("参加者協議の開始から24時間たつまで参加者投票を始めない", async () => {
    const modVoteId = await toParticipantDiscussion();
    expect(await startParticipantVote(env, { proposalId: ID, startedBy: UNEI_A })).toMatchObject({ ok: false, code: "bad_state" });
    await discussionStartedHoursAgo(23, modVoteId);
    const r = await startParticipantVote(env, { proposalId: ID, startedBy: UNEI_A });
    expect(r).toMatchObject({ ok: false, code: "too_early" });
    expect(posts("C_PVOTE")).toHaveLength(0);
  });

  it("24時間たったら参加者投票を始め、可決で passed になる", async () => {
    const modVoteId = await toParticipantDiscussion();
    const rec = await discussionStartedHoursAgo(25, modVoteId);
    expect(new Date(rec.status.participantVoteAvailableAt).getTime()).toBeLessThan(Date.now());
    const r = await startParticipantVote(env, { proposalId: ID, startedBy: UNEI_C });
    expect(r.ok).toBe(true);
    expect(r.status.state).toBe("participant_vote");
    expect(posts("C_PVOTE")).toHaveLength(1);
    const vote = await getVote(env, r.status.participantVote.voteId);
    expect(vote).toMatchObject({ voter_scope: "participant", rule_proposal_id: ID });

    await castBallot(env, vote.id, HITO, "yes");
    await closeAndTallyVote(env, vote);
    const s = await getProposalStatus(env, ID);
    expect(s.state).toBe("passed");
    expect(s.decidedAt).not.toBeNull();
  });

  it("可決後に確定した番号を記録し、反映を告知すると反映済みになる（告知は1回だけ）", async () => {
    const modVoteId = await toParticipantDiscussion();
    await discussionStartedHoursAgo(25, modVoteId);
    const r = await startParticipantVote(env, { proposalId: ID, startedBy: UNEI_C });
    const vote = await getVote(env, r.status.participantVote.voteId);
    await castBallot(env, vote.id, HITO, "yes");
    await closeAndTallyVote(env, vote);

    expect((await recordFinalNumber(env, { proposalId: ID, finalNumber: "令和8年ルール第5号" })).status.finalNumber).toBe("令和8年ルール第5号");
    const input = { proposalId: ID, kind: "enacted", portalUrl: "https://rules.ds2.uk/rule/R0801005.html", finalNumber: "令和8年ルール第5号", enforcementDate: "令和8年12月1日" };
    const done = await notifyResult(env, input);
    expect(done.status).toMatchObject({ state: "enacted", finalNumber: "令和8年ルール第5号" });
    await notifyResult(env, input);
    const notices = posts("C_NOTICE");
    expect(notices).toHaveLength(1);
    expect(JSON.parse(notices[0].body).content).toContain("令和8年ルール第5号");
  });

  it("反映の失敗は運営専用チャンネルに知らせる", async () => {
    await submitProposal(env, submitInput());
    const r = await notifyResult(env, { proposalId: ID, kind: "failed", message: "改正対象のファイルが変わっています", detailUrl: null });
    expect(r.ok).toBe(true);
    expect(JSON.parse(posts("C_UNEI")[0].body).content).toContain("改正対象のファイルが変わっています");
  });

  it("取り下げると進行中の投票を打ち切り、発議し直すと手続を初めからにする", async () => {
    await submitProposal(env, submitInput());
    const r = await startModVote(env, { proposalId: ID, method: "secret", startedBy: UNEI_A, publicUrl: URL_PUBLIC, contentHash: HASH });
    const voteId = r.status.modVote.voteId;
    await castBallot(env, voteId, UNEI_A, "yes");

    const w = await withdrawProposal(env, { proposalId: ID, withdrawnBy: UNEI_B });
    expect(w.status.state).toBe("withdrawn");
    const vote = await getVote(env, voteId);
    expect(vote.status).toBe("closed");
    expect(JSON.parse(vote.result)).toMatchObject({ cancelled: true });
    const ballots = env.DB.raw.prepare("SELECT COUNT(*) AS n FROM vote_ballots WHERE vote_id = ?").get(voteId);
    expect(ballots.n).toBe(0);
    // 打ち切った投票を締切処理が集計し直さない
    expect(await closeAndTallyVote(env, vote)).toBeNull();
    expect((await getProposalStatus(env, ID)).state).toBe("withdrawn");

    const again = await submitProposal(env, submitInput({ title: "直した題名" }));
    expect(again.status).toMatchObject({ state: "unei_discussion", title: "直した題名", modVote: null, contentHash: null });
  });

  it("可決した後は取り下げられない", async () => {
    const modVoteId = await toParticipantDiscussion();
    await discussionStartedHoursAgo(25, modVoteId);
    const r = await startParticipantVote(env, { proposalId: ID, startedBy: UNEI_C });
    await closeAndTallyVote(env, await getVote(env, r.status.participantVote.voteId));
    // 投票者0人は否決（voters_majority）
    expect((await getProposalStatus(env, ID)).state).toBe("rejected");
    expect(await withdrawProposal(env, { proposalId: ID, withdrawnBy: UNEI_A })).toMatchObject({ ok: false, code: "bad_state" });
  });

  it("運営者でない人は投票を始められない（OpsBot でも判定し直す）", async () => {
    await submitProposal(env, submitInput());
    const r = await startModVote(env, { proposalId: ID, method: "secret", startedBy: OTHER, publicUrl: URL_PUBLIC, contentHash: HASH });
    expect(r).toMatchObject({ ok: false, code: "not_unei" });
    expect((await getProposalStatus(env, ID)).state).toBe("unei_discussion");
  });
});
