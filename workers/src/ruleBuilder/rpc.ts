// rule-builder 専用の RPC エントリポイント（decisions.md #67・#68）。
// Service Binding（rule-builder の wrangler.jsonc で entrypoint: "RuleBuilderRpc"）からだけ呼べ、
// 公開の URL（fetch ハンドラ）からは呼べない。

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../env";
import { getMemberStatus } from "./memberStatus";
import {
  getProposalStatus,
  notifyResult,
  recordFinalNumber,
  recordParticipantDiscussion,
  startModVote,
  startParticipantVote,
  submitProposal,
  withdrawProposal,
} from "./proposals";
import type {
  MemberStatus,
  NotifyResultInput,
  RecordFinalNumberInput,
  RecordParticipantDiscussionInput,
  RuleBuilderRpcMethods,
  RuleProposalResult,
  RuleProposalStatus,
  StartModVoteInput,
  StartParticipantVoteInput,
  SubmitProposalInput,
  WithdrawProposalInput,
} from "./types";

export class RuleBuilderRpc extends WorkerEntrypoint<Env> implements RuleBuilderRpcMethods {
  async getMemberStatus(discordUserId: string): Promise<MemberStatus> {
    return getMemberStatus(this.env, discordUserId);
  }

  async submitProposal(input: SubmitProposalInput): Promise<RuleProposalResult> {
    return submitProposal(this.env, input);
  }

  async startModVote(input: StartModVoteInput): Promise<RuleProposalResult> {
    return startModVote(this.env, input);
  }

  async recordParticipantDiscussion(input: RecordParticipantDiscussionInput): Promise<RuleProposalResult> {
    return recordParticipantDiscussion(this.env, input);
  }

  async startParticipantVote(input: StartParticipantVoteInput): Promise<RuleProposalResult> {
    return startParticipantVote(this.env, input);
  }

  async withdrawProposal(input: WithdrawProposalInput): Promise<RuleProposalResult> {
    return withdrawProposal(this.env, input);
  }

  async getProposalStatus(proposalId: string): Promise<RuleProposalStatus | null> {
    return getProposalStatus(this.env, proposalId);
  }

  async recordFinalNumber(input: RecordFinalNumberInput): Promise<RuleProposalResult> {
    return recordFinalNumber(this.env, input);
  }

  async notifyResult(input: NotifyResultInput): Promise<RuleProposalResult> {
    return notifyResult(this.env, input);
  }
}
