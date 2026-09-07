// 記名許可（類型B・§5.4／§5.4.1）の純粋ロジック。D1・Discordへの依存を持たない。

export function isPermissionApproved(okCount: number, requiredCount: number): boolean {
  return okCount >= requiredCount;
}
