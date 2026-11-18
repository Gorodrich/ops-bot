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

/** Service Binding（entrypoint: "RuleBuilderRpc"）で rule-builder から呼べるメソッド */
export interface RuleBuilderRpcMethods {
  getMemberStatus(discordUserId: string): Promise<MemberStatus>;
}
