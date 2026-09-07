// 運営コマンドの実行資格解決（本人 or 連携済み運営サブ垢）。
// 「運営」ロールを直接持つ場合はそのまま本人として扱い、「運営サブ垢」ロールのみを持つ場合は
// staff_subaccounts で confirmed 連携されたメイン垢のdiscord_idを実行者とみなす（決定事項・2026-09-07）。
// 参加者向け投票（voter_scope='participant'）の一票行使など、運営ロール以外を判定基準にする箇所には使わない。

import type { Env } from "../env";
import type { Interaction } from "../discord/types";
import { getRoles } from "../settings";
import { hasRole } from "../accountLinks/eligibility";
import { getSubaccountLink } from "./subaccountRepo";

export type UneiActorResult =
  | { ok: true; actorId: string; viaSubaccount: boolean; rawActorId: string }
  | { ok: false; message: string };

const NOT_LINKED_MESSAGE = "このサブ垢は運営コマンドに未連携です。先にメイン垢で /subaccount link を実行してください。";
const PENDING_MESSAGE = "サブ垢連携が本人確認待ちです。サブ垢宛てのDMのボタンから確認を完了してください。";
const NOT_UNEI_MESSAGE = "このコマンドは運営者のみ実行できます。";

export async function resolveUneiActor(env: Env, member: Interaction["member"] | undefined): Promise<UneiActorResult> {
  if (!member) return { ok: false, message: "このコマンドはサーバー内でのみ実行できます。" };

  const roles = await getRoles(env);
  const rawActorId = member.user.id;

  if (hasRole(member.roles, roles.unei)) {
    return { ok: true, actorId: rawActorId, viaSubaccount: false, rawActorId };
  }

  if (hasRole(member.roles, roles.unei_sub)) {
    const link = await getSubaccountLink(env, rawActorId);
    if (link?.status === "confirmed") {
      return { ok: true, actorId: link.main_discord_id, viaSubaccount: true, rawActorId };
    }
    if (link?.status === "pending") return { ok: false, message: PENDING_MESSAGE };
    return { ok: false, message: NOT_LINKED_MESSAGE };
  }

  return { ok: false, message: NOT_UNEI_MESSAGE };
}
