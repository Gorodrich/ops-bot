// LLM層の前処理フィルタ（Edge層で実行・§7.2）。純粋関数として実装し単体テストで担保する（§11-5の精神）。
//
// 目的：投入トークン量を生ログの10%以下に圧縮する（§7.2）。判定できるものはここで弾き、
// CTへのジョブ投入自体を発生させない（§7.1：フィルタ不通過なら起動コスト0）。

export interface RawMessage {
  id: string;
  content: string;
  authorId: string;
  authorIsBot: boolean;
}

export interface PrefilterOptions {
  minChars: number;
  // 空配列なら「キーワード要件なし」（文字数のみで判定）。ticketチャンネルは既定でこちらを使う（§4.1.1）。
  coarseFilterPatterns: string[];
  // 既にタスク化済み（=検出済み）のメッセージURLの集合（返信スレッドの二重検出防止・§7.2）。
  alreadyDetectedMessageIds?: ReadonlySet<string>;
}

const STAMP_ONLY_RE = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s:]+$/u;

/** 1メッセージがLLM検出の入力候補として前処理フィルタを通過するか（§7.2）。 */
export function passesPrefilter(msg: RawMessage, opts: PrefilterOptions): boolean {
  if (msg.authorIsBot) return false; // Bot自身・他Botの発言
  if (opts.alreadyDetectedMessageIds?.has(msg.id)) return false; // 既にタスク化済みメッセージへの返信スレッド

  const body = msg.content.trim();
  if (body.length === 0) return false; // スタンプ・リアクションのみ（本文が空＝添付/リアクションのみ）
  if (STAMP_ONLY_RE.test(body)) return false; // 絵文字のみの本文（スタンプ相当）
  if (body.length < opts.minChars) return false; // 一定文字数未満の発言

  if (opts.coarseFilterPatterns.length === 0) return true; // キーワード要件なし（例：ticketチャンネル）
  return opts.coarseFilterPatterns.some((pattern) => {
    try {
      return new RegExp(pattern, "iu").test(body);
    } catch {
      return false; // 不正な正規表現は「一致なし」として無視する（設定側の検証はvalidate-settingsで担保）
    }
  });
}

export function filterMessages(messages: RawMessage[], opts: PrefilterOptions): RawMessage[] {
  return messages.filter((m) => passesPrefilter(m, opts));
}
