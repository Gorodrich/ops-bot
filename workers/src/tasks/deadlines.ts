// 期限管理（§4.6）。ルール由来でない期限（申請の審査など）はBot既定の「目標」日数を用いる
// （義務ではないことを通知文で明示する・templates.tsのbotDefaultDueNote参照）。

import type { TaskTargetDaysSetting } from "../settings";

/** Bot既定の目標日数から due_at（絶対時刻・ISO8601）を算出する。 */
export function computeBotDefaultDueAt(setting: TaskTargetDaysSetting, taskType: string, now: Date): string {
  const days = setting.by_type[taskType] ?? setting.default_days;
  const due = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  return due.toISOString().replace(/\.\d{3}Z$/, "Z");
}

const MANUAL_DUE_AT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/;

/**
 * `/task add` の期限手動指定オプション（`YYYY-MM-DD-hh-mm`・JST）をUTCのISO8601へ変換する
 * （2026-09-06追加）。DiscordのSlashコマンドにはカレンダー／時刻ピッカーのオプション型が
 * 存在しないため手入力形式とした。運営の入力はJSTである前提でUTCへ変換して保存する
 * （D1保存の絶対時刻はUTC ISO8601・workers/CLAUDE.md）。存在しない日時（2月30日等）や
 * 形式不正の場合はnullを返す。
 */
export function parseManualDueAtJst(input: string): string | null {
  const m = MANUAL_DUE_AT_PATTERN.exec(input);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const hh = Number(m[4]);
  const mi = Number(m[5]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59) return null;

  const asIfUtc = Date.UTC(y, mo - 1, d, hh, mi);
  const check = new Date(asIfUtc);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;

  const utcMs = asIfUtc - 9 * 60 * 60 * 1000; // JST（UTC+9）→UTC
  return new Date(utcMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}
