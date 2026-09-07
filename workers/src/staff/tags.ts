// 運営者プロファイルのタグ語彙（§4.4・確定済み）。
// workers/scripts/staff-schema.mjs の TAG_VOCAB と同じ内容。スクリプト側はCLIから素のJSとして
// 実行するため依存を分け、値のみ重複させている（変更時は両方を更新すること）。

export const TAG_VOCAB = [
  "rule_drafting",
  "technical",
  "participant_support",
  "moderation",
  "community_management",
  "announcement",
  "survey",
  "controversial_review",
  "data_handling",
] as const;

export type StaffTag = (typeof TAG_VOCAB)[number];

export function isValidTag(t: string): t is StaffTag {
  return (TAG_VOCAB as readonly string[]).includes(t);
}

// §4.4の説明文（requirements/02-tasks.md）。/task add の required_tags 選択時の説明表示に使う。
export const TAG_DESCRIPTIONS: Record<StaffTag, string> = {
  rule_drafting: "ルール起草・改正案の検討",
  technical: "マイクラ鯖技術対応（プラグイン導入、鯖設定、障害対応等）",
  participant_support: "参加者からの問い合わせ・個別対応",
  moderation: "処分・紛争対応",
  community_management: "コミュニティの雰囲気づくり、雑談鯖等の運営",
  announcement: "告知文・周知文書の作成",
  survey: "情報収集・調査・資料整理",
  controversial_review: "意見が割れやすい、または対外的な火種になりうる議題の一次検討",
  data_handling: "ワールドデータ等の機微情報の取扱いに関する業務",
};
