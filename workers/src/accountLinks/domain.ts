// アカウント紐づけの判定ロジック（純粋関数）。
// Discord REST・Mojang API・D1 への依存を持たず、リポジトリインターフェースを注入して受け取る。
// §6.4.1・§6.4.2 の却下条件と、再参加時の復元（§6.4.1「再参加時の扱い」）を実装する。
//
// 重要な順序制約（原文どおり）：
//   「実行者の discord_id と入力された mcuser（のUUID）の組が、status: inactive の既存レコードと
//    一致する場合は、却下条件②に該当させず、当該レコードを active に復元する。却下条件③の判定も、
//    この復元処理より先には行わない。」
// → 復元判定を条件②③より必ず先に行う。

export type AccountLinkStatus = "active" | "inactive";

export interface AccountLinkRecord {
  minecraft_uuid: string;
  minecraft_name: string;
  discord_id: string;
  status: AccountLinkStatus;
  linked_by: string; // "self" | "modauth:<operator_id>"
  linked_at: string;
  deactivated_at: string | null;
}

export interface AccountLinkRepo {
  getByUuid(uuid: string): Promise<AccountLinkRecord | null>;
  getActiveByDiscordId(discordId: string): Promise<AccountLinkRecord | null>;
}

export type RejectCode = "①" | "②" | "③" | "④";

export const REJECT_MESSAGES: Record<RejectCode, string> = {
  "①": "入力されたMinecraftユーザー名が実在しません。",
  "②": "そのMinecraftアカウントは既に他のDiscordアカウントに紐づけられています。",
  "③": "既に別のMinecraftアカウントを紐づけ済みです。変更は運営者の /modauth によってのみ行えます。",
  "④": "人民ロールまたは仮参加者ロールを持つ方のみが実行できます（サブ垢ロールのみでは対象外です）。",
};

export type AuthoriseDecision =
  | { kind: "reject"; code: RejectCode; message: string }
  | { kind: "reactivate"; uuid: string; name: string; existing: AccountLinkRecord }
  | { kind: "create"; uuid: string; name: string };

export interface AuthoriseEligibility {
  hasHito: boolean;
  hasKariSanka: boolean;
}

export async function decideAuthorise(
  repo: AccountLinkRepo,
  input: { discordId: string; mojangUuid: string | null; mojangName: string; eligibility: AuthoriseEligibility },
): Promise<AuthoriseDecision> {
  const { discordId, mojangUuid, mojangName, eligibility } = input;

  // 条件④：実行資格（先に弾く。Mojang API を無駄に呼ばない）
  if (!eligibility.hasHito && !eligibility.hasKariSanka) {
    return { kind: "reject", code: "④", message: REJECT_MESSAGES["④"] };
  }

  // 条件①：実在確認
  if (!mojangUuid) {
    return { kind: "reject", code: "①", message: REJECT_MESSAGES["①"] };
  }

  const existing = await repo.getByUuid(mojangUuid);

  // 再参加時の扱い：復元判定を②③より先に行う（実行者自身の inactive レコードのみ対象）
  if (existing && existing.status === "inactive" && existing.discord_id === discordId) {
    return { kind: "reactivate", uuid: mojangUuid, name: mojangName, existing };
  }

  // 条件②：他者に紐づけ済み（active）。minecraft_uuid が主キーのため、discord_id が
  // 異なる inactive レコードも自己申告での上書きは認めず、運営者の /modauth に委ねる。
  if (existing && existing.discord_id !== discordId) {
    return { kind: "reject", code: "②", message: REJECT_MESSAGES["②"] };
  }

  // 条件③：実行者が既に別アカウントを紐づけ済み（自分自身の再実行も含む＝上書き不可）
  const myActive = await repo.getActiveByDiscordId(discordId);
  if (myActive) {
    return { kind: "reject", code: "③", message: REJECT_MESSAGES["③"] };
  }

  return { kind: "create", uuid: mojangUuid, name: mojangName };
}

// ── /modauth（運営者による紐づけ）─────────────────────────────
// 却下条件①②は /authorise と同一。③（既存紐づけの上書き）は運営者の判断で上書き可能（確認ボタンを挟む）。
// ④は対象者に対して適用する。⑤（BAN中）はPhase 1では未実装（処罰台帳が存在しないため・open-items #23）。

export type ModauthDecision =
  | { kind: "reject"; code: RejectCode; message: string }
  | { kind: "reactivate"; uuid: string; name: string; existing: AccountLinkRecord }
  | { kind: "create"; uuid: string; name: string }
  | { kind: "confirm_overwrite"; uuid: string; name: string; targetPreviousLink: AccountLinkRecord }
  | { kind: "noop"; uuid: string; name: string };

export async function decideModauth(
  repo: AccountLinkRepo,
  input: {
    targetDiscordId: string;
    mojangUuid: string | null;
    mojangName: string;
    targetEligibility: AuthoriseEligibility;
    confirmedOverwrite: boolean; // 確認ボタン押下後の再実行かどうか
  },
): Promise<ModauthDecision> {
  const { targetDiscordId, mojangUuid, mojangName, targetEligibility, confirmedOverwrite } = input;

  if (!targetEligibility.hasHito && !targetEligibility.hasKariSanka) {
    return { kind: "reject", code: "④", message: REJECT_MESSAGES["④"] };
  }

  if (!mojangUuid) {
    return { kind: "reject", code: "①", message: REJECT_MESSAGES["①"] };
  }

  const existingByUuid = await repo.getByUuid(mojangUuid);

  if (existingByUuid && existingByUuid.status === "active" && existingByUuid.discord_id !== targetDiscordId) {
    return { kind: "reject", code: "②", message: REJECT_MESSAGES["②"] };
  }

  const targetActive = await repo.getActiveByDiscordId(targetDiscordId);
  if (targetActive && targetActive.minecraft_uuid === mojangUuid) {
    // 既に同一アカウントへ紐づけ済み（再実行）。上書き不要のため何もしない。
    return { kind: "noop", uuid: mojangUuid, name: mojangName };
  }
  if (targetActive && targetActive.minecraft_uuid !== mojangUuid && !confirmedOverwrite) {
    return { kind: "confirm_overwrite", uuid: mojangUuid, name: mojangName, targetPreviousLink: targetActive };
  }

  // ここに到達するのは「対象者に他の紐づけがない」か「上書き確認済み」の場合。
  // minecraft_uuid が主キーのため、discord_id の一致有無を問わず inactive な既存行は
  // 常に復元（再割当）する。新規INSERTすると同一UUIDでUNIQUE制約違反になるため。
  if (existingByUuid && existingByUuid.status === "inactive") {
    return { kind: "reactivate", uuid: mojangUuid, name: mojangName, existing: existingByUuid };
  }

  return { kind: "create", uuid: mojangUuid, name: mojangName };
}
