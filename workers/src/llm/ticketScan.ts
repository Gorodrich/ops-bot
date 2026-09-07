// ticket toolチャンネルの監視対象自動登録・クローズ検知（§4.1.1・docs/appendix/ticket-tool-spec.md）。
// 親カテゴリIDで判別し、チャンネル名の変化 or 一覧からの消失でクローズを検知する。

import type { Env } from "../env";
import { listGuildChannels, sendChannelMessage, type DiscordChannel } from "../discord/rest";
import { getChannels, getGuildId, getTicketToolSetting } from "../settings";

export interface MonitoredChannelRow {
  channel_id: string;
  kind: "ticket" | "ops";
  status: "open" | "closed";
  requester_discord_id: string | null;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** topicまたは冒頭embed相当の文字列からTicket Tool既定のユーザーIDらしきものを拾う（ベストエフォート）。 */
function extractRequesterId(topic: string | null | undefined): string | null {
  if (!topic) return null;
  const m = topic.match(/\b(\d{17,20})\b/);
  return m ? (m[1] as string) : null;
}

const SCAN_GATE_KEY = "__ticket_scan_gate__";

async function isScanDue(env: Env, intervalSec: number): Promise<boolean> {
  const row = await env.DB.prepare("SELECT last_message_id FROM cursors WHERE channel_id = ? AND purpose = 'ticket_scan_gate'")
    .bind(SCAN_GATE_KEY)
    .first<{ last_message_id: string | null }>();
  if (!row?.last_message_id) return true;
  return Date.now() - new Date(row.last_message_id).getTime() >= intervalSec * 1000;
}

async function markScanRan(env: Env): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO cursors (channel_id, last_message_id, purpose, updated_at) VALUES (?, ?, 'ticket_scan_gate', ?)
     ON CONFLICT(channel_id) DO UPDATE SET last_message_id = excluded.last_message_id, updated_at = excluded.updated_at`,
  )
    .bind(SCAN_GATE_KEY, nowIso(), nowIso())
    .run();
}

/** §4.1.1：ticketチャンネルの監視対象自動登録・クローズ検知。既定1時間ごと（絶対時刻で間引く・§9）。 */
export async function runTicketChannelScan(env: Env): Promise<void> {
  const guildId = await getGuildId(env);
  if (!guildId) return; // 未セットアップ

  const ticketSetting = await getTicketToolSetting(env);
  if (ticketSetting.ticket_open_category_ids.length === 0) return; // 未確定のまま（プレースホルダ）
  if (!(await isScanDue(env, ticketSetting.ticket_channel_scan_interval_sec))) return;
  await markScanRan(env);

  const channels = await listGuildChannels(env.DISCORD_BOT_TOKEN, guildId);
  const byId = new Map(channels.map((c) => [c.id, c]));
  const closedNamePattern = new RegExp(ticketSetting.ticket_closed_name_pattern);

  const existing = await env.DB.prepare(
    "SELECT channel_id, kind, status, requester_discord_id FROM monitored_channels WHERE kind = 'ticket'",
  ).all<MonitoredChannelRow>();
  const existingById = new Map((existing.results ?? []).map((r) => [r.channel_id, r]));

  // 1) 新規出現の検知：対象カテゴリ配下のテキストチャンネル（type=0）で未登録のもの
  const GUILD_TEXT = 0;
  for (const c of channels) {
    if (c.type !== GUILD_TEXT) continue;
    if (!c.parent_id || !ticketSetting.ticket_open_category_ids.includes(c.parent_id)) continue;
    if (existingById.has(c.id)) continue;
    if (closedNamePattern.test(c.name ?? "")) continue; // 既にクローズ名で作成されている異常系はスキップ

    await env.DB.prepare(
      `INSERT INTO monitored_channels (channel_id, kind, status, requester_discord_id, created_at)
       VALUES (?, 'ticket', 'open', ?, ?)`,
    )
      .bind(c.id, extractRequesterId(c.topic), nowIso())
      .run();
  }

  // 2) クローズ検知：チャンネル名がクローズパターンに一致、または一覧から消失
  for (const row of existing.results ?? []) {
    if (row.status === "closed") continue;
    const current = byId.get(row.channel_id);
    const disappeared = !current;
    const renamedToClosed = !disappeared && closedNamePattern.test(current!.name ?? "");
    // クローズ済み移動先カテゴリへ移動された場合も「一覧から消えた」に準じてクローズ扱いとする（§3）。
    const movedToClosedCategory =
      !disappeared &&
      current!.parent_id != null &&
      ticketSetting.ticket_closed_category_ids.includes(current!.parent_id);

    if (!disappeared && !renamedToClosed && !movedToClosedCategory) continue;

    await env.DB.prepare("UPDATE monitored_channels SET status = 'closed', closed_at = ? WHERE channel_id = ?")
      .bind(nowIso(), row.channel_id)
      .run();
    await notifyIfIncompleteTasksRemain(env, row.channel_id);
  }
}

async function notifyIfIncompleteTasksRemain(env: Env, channelId: string): Promise<void> {
  // §4.1.1：クローズ検知時、当該チケットに紐づく未完了タスクが残っていれば運営に確認を促す。
  // shadow_mode=true（Phase 6相当）の間はLLM検出タスクが本物の tasks テーブルに入らないため
  // （migrations/0009参照）、ここでヒットするのは手動/機械層で起票された本物のタスクのみになる。
  // shadow_mode=false（Phase 7・本稼働）ではLLM検出タスクもsource_channel_id付きでtasksに入るため、
  // 特別な分岐なしにそのまま検知対象に含まれる。
  const incomplete = await env.DB.prepare(
    "SELECT COUNT(*) as n FROM tasks WHERE source_channel_id = ? AND status NOT IN ('done')",
  )
    .bind(channelId)
    .first<{ n: number }>();
  if (!incomplete || incomplete.n === 0) return;

  const channels = await getChannels(env);
  if (!channels.unei_only) return;
  await sendChannelMessage(
    env.DISCORD_BOT_TOKEN,
    channels.unei_only,
    `【要確認】ticketチャンネル <#${channelId}> がクローズされましたが、紐づく未完了タスクが${incomplete.n}件残っています（§4.1.1）。`,
  ).catch(() => {});
}

/** チケット開設者のDiscord ID（topicから判明している場合のみ・Phase 7：LLM検出タスクのrequester欄に使う）。 */
export async function getTicketRequester(env: Env, channelId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT requester_discord_id FROM monitored_channels WHERE channel_id = ?")
    .bind(channelId)
    .first<{ requester_discord_id: string | null }>();
  return row?.requester_discord_id ?? null;
}

/** 現在監視対象（open）のticketチャンネルID一覧（メッセージ差分取得の対象channel集合に使う）。 */
export async function listOpenTicketChannelIds(env: Env): Promise<string[]> {
  const res = await env.DB.prepare("SELECT channel_id FROM monitored_channels WHERE kind = 'ticket' AND status = 'open'").all<{
    channel_id: string;
  }>();
  return (res.results ?? []).map((r) => r.channel_id);
}
