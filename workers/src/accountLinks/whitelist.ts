// ホワイトリスト操作ジョブの積み込み（Crafty API経由・CT102が実行・§6.4.4）。

import type { Env } from "../env";
import { enqueueJob } from "../jobs/queue";

export async function enqueueWhitelistAdd(env: Env, mcName: string, mcUuid: string): Promise<void> {
  await enqueueJob(env, "crafty_op", { op: "add", mc_name: mcName, mc_uuid: mcUuid });
}

export async function enqueueWhitelistRemove(env: Env, mcName: string, mcUuid: string): Promise<void> {
  await enqueueJob(env, "crafty_op", { op: "remove", mc_name: mcName, mc_uuid: mcUuid });
}
