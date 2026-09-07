// 監査ログ（audit_log・§8／§9-観測性）。全アクション（割当・督促・状態変更・投票・記名許可・Bot審査と撤回）を記録する。

import type { Env } from "./env";

export async function writeAuditLog(
  env: Env,
  args: { actor: string; action: string; target?: string; detail?: unknown },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_log (actor, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      args.actor,
      args.action,
      args.target ?? null,
      args.detail !== undefined ? JSON.stringify(args.detail) : null,
      new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    )
    .run();
}
