// rule-builder 専用の RPC エントリポイント（decisions.md #67）。
// Service Binding（rule-builder の wrangler.jsonc で entrypoint: "RuleBuilderRpc"）からだけ呼べ、
// 公開の URL（fetch ハンドラ）からは呼べない。

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../env";
import { getMemberStatus } from "./memberStatus";
import type { MemberStatus, RuleBuilderRpcMethods } from "./types";

export class RuleBuilderRpc extends WorkerEntrypoint<Env> implements RuleBuilderRpcMethods {
  async getMemberStatus(discordUserId: string): Promise<MemberStatus> {
    return getMemberStatus(this.env, discordUserId);
  }
}
