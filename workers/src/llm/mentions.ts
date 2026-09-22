// Discordメンション構文（`<@ID>`/`<@!ID>`）からのメンション先ID抽出（機械的処理・C-1：LLM不使用）。
// 検出元メッセージの発言者除外・タイブレークプレビューの「宛先優先」ヒントに使う（decisions.md #65）。

const MENTION_RE = /<@!?(\d+)>/g;

export function extractMentionedDiscordIds(body: string): string[] {
  const ids = new Set<string>();
  for (const m of body.matchAll(MENTION_RE)) {
    ids.add(m[1] as string);
  }
  return [...ids];
}
