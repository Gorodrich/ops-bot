// Discord REST API 呼び出し（アウトバウンド通知：DM・チャンネル投稿・メッセージ編集・§3.3）。
// Botトークンで直接呼び出す（Gateway常時接続は使わない）。

const API_BASE = "https://discord.com/api/v10";

export interface DiscordGuildMember {
  user?: { id: string; username: string };
  roles: string[];
}

async function discordFetch(path: string, botToken: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bot ${botToken}`,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

export async function getGuildMember(
  botToken: string,
  guildId: string,
  userId: string,
): Promise<DiscordGuildMember | null> {
  const res = await discordFetch(`/guilds/${guildId}/members/${userId}`, botToken);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Discord API エラー（getGuildMember）: ${res.status}`);
  return (await res.json()) as DiscordGuildMember;
}

/** ギルドメンバー一覧をページングしつつ全件取得する（脱退検知の差分取得・§6.4.3）。 */
export async function listAllGuildMembers(
  botToken: string,
  guildId: string,
): Promise<Array<{ id: string; roles: string[] }>> {
  const out: Array<{ id: string; roles: string[] }> = [];
  let after: string | undefined;
  for (;;) {
    const qs = new URLSearchParams({ limit: "1000", ...(after ? { after } : {}) });
    const res = await discordFetch(`/guilds/${guildId}/members?${qs.toString()}`, botToken);
    if (!res.ok) throw new Error(`Discord API エラー（listAllGuildMembers）: ${res.status}`);
    const page = (await res.json()) as DiscordGuildMember[];
    if (page.length === 0) break;
    for (const m of page) {
      if (m.user) out.push({ id: m.user.id, roles: m.roles });
    }
    if (page.length < 1000) break;
    after = page[page.length - 1]?.user?.id;
    if (!after) break;
  }
  return out;
}

export interface DiscordChannel {
  id: string;
  type: number;
  name?: string;
  parent_id?: string | null;
  topic?: string | null;
}

/** ギルドのチャンネル一覧（ticket toolチャンネルの自動検知・§4.1.1）。スレッドは含まない。 */
export async function listGuildChannels(botToken: string, guildId: string): Promise<DiscordChannel[]> {
  const res = await discordFetch(`/guilds/${guildId}/channels`, botToken);
  if (!res.ok) throw new Error(`Discord API エラー（listGuildChannels）: ${res.status}`);
  return (await res.json()) as DiscordChannel[];
}

export interface DiscordMessage {
  id: string;
  content: string;
  author: { id: string; bot?: boolean };
  channel_id: string;
}

/**
 * 指定メッセージIDより後の発言を古い順で取得する（§3.1：前回取得位置からの差分取得）。
 * Discord REST APIの `GET .../messages?after=` は新しい順に最大100件を返す仕様のため、
 * 呼び出し側で古い順に並べ替える。監視対象チャンネルは限定的で30分間隔のポーリングを
 * 前提とするため（§3.1）、1回の取得は100件（Discordの上限）で打ち切り、100件ぴったり
 * 返ってきた場合は取りこぼしがある旨をログに残すのみとする（次回ポーリングで追従する）。
 */
export async function getChannelMessagesAfter(
  botToken: string,
  channelId: string,
  afterMessageId: string | null,
): Promise<{ messages: DiscordMessage[]; mayHaveMore: boolean }> {
  const qs = new URLSearchParams({ limit: "100", ...(afterMessageId ? { after: afterMessageId } : {}) });
  const res = await discordFetch(`/channels/${channelId}/messages?${qs.toString()}`, botToken);
  if (res.status === 403 || res.status === 404) return { messages: [], mayHaveMore: false }; // 権限喪失・チャンネル消失
  if (!res.ok) throw new Error(`Discord API エラー（getChannelMessagesAfter）: ${res.status}`);
  const page = (await res.json()) as DiscordMessage[]; // 新しい順で返る
  page.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  return { messages: page, mayHaveMore: page.length >= 100 };
}

export async function sendChannelMessage(
  botToken: string,
  channelId: string,
  content: string,
  embeds?: unknown[],
): Promise<void> {
  const res = await discordFetch(`/channels/${channelId}/messages`, botToken, {
    method: "POST",
    body: JSON.stringify({ content, ...(embeds ? { embeds } : {}) }),
  });
  if (!res.ok) throw new Error(`Discord API エラー（sendChannelMessage）: ${res.status} ${await res.text()}`);
}

/** ボタン付きチャンネル投稿（画像なし）。投稿したメッセージIDを返す（記名許可・投票の対象メッセージ編集用）。 */
export async function sendChannelMessageWithComponents(
  botToken: string,
  channelId: string,
  content: string,
  components: unknown[],
  embeds?: unknown[],
): Promise<string> {
  const res = await discordFetch(`/channels/${channelId}/messages`, botToken, {
    method: "POST",
    body: JSON.stringify({ content, components, ...(embeds ? { embeds } : {}) }),
  });
  if (!res.ok) throw new Error(`Discord API エラー（sendChannelMessageWithComponents）: ${res.status} ${await res.text()}`);
  const { id } = (await res.json()) as { id: string };
  return id;
}

/**
 * 画像添付付きのチャンネル投稿（確認画像の添付・§6.3.4）。
 * CT102はDiscordへ直接アクセスしない（§3.3）ため、CTがbase64で返した画像バイト列を
 * Workersがここで multipart/form-data として送信する。
 */
export async function sendChannelMessageWithFile(
  botToken: string,
  channelId: string,
  content: string,
  file: { filename: string; bytes: Uint8Array; contentType?: string },
  embeds?: unknown[],
): Promise<void> {
  const form = new FormData();
  form.append("payload_json", JSON.stringify({ content, ...(embeds ? { embeds } : {}) }));
  form.append("files[0]", new Blob([file.bytes], { type: file.contentType ?? "image/png" }), file.filename);
  const res = await fetch(`${API_BASE}/channels/${channelId}/messages`, {
    method: "POST",
    headers: { authorization: `Bot ${botToken}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Discord API エラー（sendChannelMessageWithFile）: ${res.status} ${await res.text()}`);
}

/** 既存メッセージの編集（記名許可・投票の押下者一覧更新、締切時の結果反映・§5.4／§5.2）。 */
export async function editChannelMessage(
  botToken: string,
  channelId: string,
  messageId: string,
  body: { content?: string; components?: unknown[]; embeds?: unknown[] },
): Promise<void> {
  const res = await discordFetch(`/channels/${channelId}/messages/${messageId}`, botToken, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Discord API エラー（editChannelMessage）: ${res.status} ${await res.text()}`);
}

async function openDmChannel(botToken: string, userId: string): Promise<string> {
  const dm = await discordFetch("/users/@me/channels", botToken, {
    method: "POST",
    body: JSON.stringify({ recipient_id: userId }),
  });
  if (!dm.ok) throw new Error(`Discord API エラー（DM チャンネル作成）: ${dm.status}`);
  const { id } = (await dm.json()) as { id: string };
  return id;
}

export async function sendDirectMessage(botToken: string, userId: string, content: string, embeds?: unknown[]): Promise<void> {
  const dmChannelId = await openDmChannel(botToken, userId);
  await sendChannelMessage(botToken, dmChannelId, content, embeds);
}

/** ボタン付きDM（§5.7.3の本人確認照会：「この内容で申請する」「取り下げる」）。 */
export async function sendDirectMessageWithComponents(
  botToken: string,
  userId: string,
  content: string,
  components: unknown[],
  embeds?: unknown[],
): Promise<void> {
  const dmChannelId = await openDmChannel(botToken, userId);
  const res = await discordFetch(`/channels/${dmChannelId}/messages`, botToken, {
    method: "POST",
    body: JSON.stringify({ content, components, ...(embeds ? { embeds } : {}) }),
  });
  if (!res.ok) throw new Error(`Discord API エラー（sendDirectMessageWithComponents）: ${res.status} ${await res.text()}`);
}

/** ボタン付きDM＋画像添付（本人確認照会に確認画像を添える・§5.7.3）。 */
export async function sendDirectMessageWithComponentsAndFile(
  botToken: string,
  userId: string,
  content: string,
  components: unknown[],
  file: { filename: string; bytes: Uint8Array; contentType?: string },
  embeds?: unknown[],
): Promise<void> {
  const dmChannelId = await openDmChannel(botToken, userId);
  const form = new FormData();
  form.append("payload_json", JSON.stringify({ content, components, ...(embeds ? { embeds } : {}) }));
  form.append("files[0]", new Blob([file.bytes], { type: file.contentType ?? "image/png" }), file.filename);
  const res = await fetch(`${API_BASE}/channels/${dmChannelId}/messages`, {
    method: "POST",
    headers: { authorization: `Bot ${botToken}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Discord API エラー（sendDirectMessageWithComponentsAndFile）: ${res.status} ${await res.text()}`);
}

/** ボタン付きチャンネル投稿＋画像添付（承認時の撤回ボタン・§5.7.2）。 */
export async function sendChannelMessageWithFileAndComponents(
  botToken: string,
  channelId: string,
  content: string,
  components: unknown[],
  file?: { filename: string; bytes: Uint8Array; contentType?: string },
  embeds?: unknown[],
): Promise<void> {
  const form = new FormData();
  form.append("payload_json", JSON.stringify({ content, components, ...(embeds ? { embeds } : {}) }));
  if (file) form.append("files[0]", new Blob([file.bytes], { type: file.contentType ?? "image/png" }), file.filename);
  const res = await fetch(`${API_BASE}/channels/${channelId}/messages`, {
    method: "POST",
    headers: { authorization: `Bot ${botToken}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Discord API エラー（sendChannelMessageWithFileAndComponents）: ${res.status} ${await res.text()}`);
}

/** Interaction のフォローアップメッセージ送信（deferred応答の完了通知）。Botトークン不要（webhook）。 */
export async function sendFollowupMessage(
  appId: string,
  interactionToken: string,
  body: { content: string; flags?: number; components?: unknown[] },
): Promise<void> {
  const res = await fetch(`${API_BASE}/webhooks/${appId}/${interactionToken}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Discord API エラー（followup）: ${res.status} ${await res.text()}`);
}

export const EPHEMERAL_FLAG = 1 << 6;
