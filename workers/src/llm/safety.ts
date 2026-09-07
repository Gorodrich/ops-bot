// LLMの出力のうち、人（運営者）に見せる可能性のあるテキストへの機械的な安全フィルタ。
//
// 背景（開発者からの追加指示）：staff.yaml の notes 欄には開発者個人の評価・過去の会話ログ等の
// 機微情報が混在しうる。§4.5「割当フォールバック時のみnotesを渡す」運用自体は要件どおり維持するが、
// その結果としてLLMが生成する自由記述（positive_note）が運営・参加者に見える形で外部に出る際は、
// 「staff.yamlにこう書かれている／評価されている」と推察できる内容や、マイナス面の言及を一切
// 含めてはならない（ポジティブな適性の一般論的な言及のみ許容）。
//
// 方針：プロンプト側で「前向きな適性の一言のみ・評価源に触れない・null可」と指示した上で、
// ここでは受け取った文字列を信用せず機械的に検査する（プロンプトインジェクション・モデルの
// 指示逸脱を前提にした多層防御）。判定に迷う場合は必ず破棄する（null を返す）。

const DISALLOWED_SUBSTRINGS = [
  // 評価の出所を匂わせる語
  "notes",
  "note",
  "staff.yaml",
  "staff.yml",
  "プロファイル",
  "評価",
  "メモ",
  "記載",
  "記述",
  "書かれて",
  "とされて",
  "だそう",
  "らしい",
  // マイナス評価・懸念を示す語（厳禁・decisions.md追加指示）
  "苦手",
  "不安",
  "懸念",
  "弱み",
  "弱点",
  "課題",
  "注意が必要",
  "向いていない",
  "得意ではない",
  "あまり得意",
];

const MAX_LEN = 60;

/**
 * LLM生成のpositive_noteを検査し、安全でなければnullを返す。
 * 呼び出し側（jobs/completion.ts）はここを通過した文字列のみを保存・通知してよい。
 */
export function sanitizePositiveNote(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const note = raw.trim();
  if (note.length === 0) return null;
  if (note.length > MAX_LEN) return null; // 長文は自由記述が紛れ込んでいる可能性が高く、安全側に倒して破棄
  const lower = note.toLowerCase();
  for (const bad of DISALLOWED_SUBSTRINGS) {
    if (lower.includes(bad.toLowerCase())) return null;
  }
  return note;
}
