// メッセージ差分取得＋前処理フィルタ＋LLM検出ジョブの積み込み（§3.1・§7.1・§7.2・§4.1.1）。
//
// Cloudflare Workers Free枠のCronトリガー数制約（既存コメント参照・index.ts）により、
// このフェーズも新規cronは増やさず、既存の15分ごとの発火（CRON_SLOW）に乗せる。
// §7.1の「30分間隔」は、cursors テーブルの専用行（絶対時刻・§9）で間引いて実現する。

import type { Env } from "../env";
import { getChannelMessagesAfter, type DiscordMessage } from "../discord/rest";
import { getChannels, getGuildId, getLlmSetting, getTicketToolSetting } from "../settings";
import { enqueueJob } from "../jobs/queue";
import { filterMessages, type RawMessage } from "./prefilter";
import { listOpenTicketChannelIds } from "./ticketScan";

const SCAN_GATE_KEY = "__llm_scan_gate__";

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function isScanDue(env: Env, intervalSec: number): Promise<boolean> {
  const row = await env.DB.prepare("SELECT last_message_id FROM cursors WHERE channel_id = ? AND purpose = 'llm_scan_gate'")
    .bind(SCAN_GATE_KEY)
    .first<{ last_message_id: string | null }>();
  if (!row?.last_message_id) return true;
  const last = new Date(row.last_message_id).getTime();
  return Date.now() - last >= intervalSec * 1000;
}

async function markScanRan(env: Env): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO cursors (channel_id, last_message_id, purpose, updated_at) VALUES (?, ?, 'llm_scan_gate', ?)
     ON CONFLICT(channel_id) DO UPDATE SET last_message_id = excluded.last_message_id, updated_at = excluded.updated_at`,
  )
    .bind(SCAN_GATE_KEY, nowIso(), nowIso())
    .run();
}

async function getCursor(env: Env, channelId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT last_message_id FROM cursors WHERE channel_id = ? AND purpose = 'message_diff'")
    .bind(channelId)
    .first<{ last_message_id: string | null }>();
  return row?.last_message_id ?? null;
}

async function setCursor(env: Env, channelId: string, lastMessageId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO cursors (channel_id, last_message_id, purpose, updated_at) VALUES (?, ?, 'message_diff', ?)
     ON CONFLICT(channel_id) DO UPDATE SET last_message_id = excluded.last_message_id, updated_at = excluded.updated_at`,
  )
    .bind(channelId, lastMessageId, nowIso())
    .run();
}

/** 直近に検出済みのメッセージID集合（返信スレッドの二重検出防止・§7.2）。件数を絞って軽量に保つ。 */
async function recentlyDetectedMessageIds(env: Env): Promise<Set<string>> {
  const res = await env.DB.prepare("SELECT source_message_url FROM llm_shadow_detections ORDER BY id DESC LIMIT 500").all<{
    source_message_url: string;
  }>();
  const ids = new Set<string>();
  for (const r of res.results ?? []) {
    const m = r.source_message_url.match(/\/(\d+)$/);
    if (m) ids.add(m[1] as string);
  }
  return ids;
}

interface ChannelTarget {
  channelId: string;
  kind: "ticket" | "ops";
}

const MAX_MESSAGES_PER_JOB = 50;

export interface DetectMessageInput {
  source_message_url: string;
  channel_kind: "ticket" | "ops";
  author_discord_id: string;
  body: string;
}

/** §7.1〜§7.2：起動条件の判定と前処理フィルタを行い、通過分があればCT向けjob_queueに積む。 */
export async function runLlmMessageScan(env: Env): Promise<void> {
  const llmSetting = await getLlmSetting(env);
  if (!(await isScanDue(env, llmSetting.scan_interval_sec))) return;
  await markScanRan(env); // フィルタ不通過でもゲートは進める（§7.1：判定自体は毎回行うため）

  const guildId = await getGuildId(env);
  if (!guildId) return;

  const [channels, ticketSetting, openTicketIds, alreadyDetected] = await Promise.all([
    getChannels(env),
    getTicketToolSetting(env),
    listOpenTicketChannelIds(env),
    recentlyDetectedMessageIds(env),
  ]);

  const targets: ChannelTarget[] = [
    ...(channels.unei_only ? [{ channelId: channels.unei_only, kind: "ops" as const }] : []),
    ...openTicketIds.map((id) => ({ channelId: id, kind: "ticket" as const })),
  ];
  if (targets.length === 0) return;

  const eligible: DetectMessageInput[] = [];

  for (const target of targets) {
    const cursor = await getCursor(env, target.channelId);
    const { messages, mayHaveMore } = await getChannelMessagesAfter(env.DISCORD_BOT_TOKEN, target.channelId, cursor);
    if (messages.length === 0) continue;

    const newest = messages[messages.length - 1] as DiscordMessage;
    await setCursor(env, target.channelId, newest.id);

    // 初回登録時は既存ログを一括検出しない（バックフィル抑止）。ただしticketチャンネルは
    // 新規発行直後の本題（開設時点の最初のメッセージ）を取りこぼさないよう例外とする（§4.1.1）。
    if (cursor === null && target.kind === "ops") continue;
    if (mayHaveMore) {
      console.warn(`llm message scan: channel ${target.channelId} は1回のポーリングで取得しきれていません（100件到達）`);
    }

    const raw: RawMessage[] = messages.map((m) => ({ id: m.id, content: m.content, authorId: m.author.id, authorIsBot: !!m.author.bot }));
    const minChars =
      target.kind === "ticket"
        ? (ticketSetting.ticket_keyword_filter_threshold ?? llmSetting.min_message_chars)
        : llmSetting.min_message_chars;
    const patterns = target.kind === "ticket" ? [] : llmSetting.coarse_filter_patterns;

    const passed = filterMessages(raw, {
      minChars,
      coarseFilterPatterns: patterns,
      alreadyDetectedMessageIds: alreadyDetected,
    });

    for (const p of passed) {
      const original = messages.find((m) => m.id === p.id);
      if (!original) continue;
      eligible.push({
        source_message_url: `https://discord.com/channels/${guildId}/${target.channelId}/${p.id}`,
        channel_kind: target.kind,
        author_discord_id: p.authorId,
        body: p.content,
      });
    }
  }

  if (eligible.length === 0) return; // フィルタ不通過：CTへのリクエスト自体を発生させない（§7.1：起動コスト0）
  if (llmSetting.paused) return; // 縮退運転中（C-2）：機械層のみで完結させ、LLM呼び出しは行わない

  const batch = eligible.slice(0, MAX_MESSAGES_PER_JOB);
  await enqueueJob(env, "claude_code", {
    subkind: "detect_tasks",
    max_tokens: llmSetting.max_tokens,
    messages: batch,
  });
}
