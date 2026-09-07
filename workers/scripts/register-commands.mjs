// Discordスラッシュコマンドの登録（グローバルコマンド）。
// 使い方: DISCORD_APP_ID / DISCORD_BOT_TOKEN / DISCORD_GUILD_ID を環境変数に設定して実行。
//   node scripts/register-commands.mjs            → グローバル登録（反映まで最大1時間）
//   node scripts/register-commands.mjs --guild     → ギルド限定登録（即時反映・開発向け）
//
// Phase 1 で追加するコマンドのみ定義する（既存コマンドが増えたら追記する）。

const OPTION_TYPE = { SUB_COMMAND: 1, STRING: 3, INTEGER: 4, BOOLEAN: 5, USER: 6, ATTACHMENT: 11 };

// /task add の permission_tier 選択肢（§4.5.1・staff.discord_permission_tierと同じ語彙）
const PERMISSION_TIER_CHOICES = [
  { name: "admin", value: "admin" },
  { name: "broad", value: "broad" },
  { name: "standard", value: "standard" },
];

// /task add の required_tags 選択肢（§4.4・src/staff/tags.ts の TAG_VOCAB / TAG_DESCRIPTIONS と同じ内容。
// スクリプト側はCLIから素のJSとして実行するため依存を分け、値のみ重複させている。変更時は両方を更新すること）。
// Discordのchoicesは固定selectのため、カンマ区切り1フィールド＋autocompleteの構成は採用しない
// （選択時に入力欄全体が選択肢のvalueで上書きされ、既存の選択済みタグを保持できないため）。
const REQUIRED_TAG_CHOICES = [
  { name: "rule_drafting — ルール起草・改正案の検討", value: "rule_drafting" },
  { name: "technical — マイクラ鯖技術対応（プラグイン導入、鯖設定、障害対応等）", value: "technical" },
  { name: "participant_support — 参加者からの問い合わせ・個別対応", value: "participant_support" },
  { name: "moderation — 処分・紛争対応", value: "moderation" },
  { name: "community_management — コミュニティの雰囲気づくり、雑談鯖等の運営", value: "community_management" },
  { name: "announcement — 告知文・周知文書の作成", value: "announcement" },
  { name: "survey — 情報収集・調査・資料整理", value: "survey" },
  { name: "controversial_review — 意見が割れやすい、または対外的な火種になりうる議題の一次検討", value: "controversial_review" },
  { name: "data_handling — ワールドデータ等の機微情報の取扱いに関する業務", value: "data_handling" },
];

// /vote start・/vote quick で選択できる承認事項（§5.5）。
// /vote hogokuiki_build は approval_key を "protected_area_build_approval" に内部固定するため対象外。
// settings.approval_types のキーと一致させること（Discordのコマンド定義自体は固定選択肢のため、
// 事項を追加する場合はここにも追記した上で再登録が必要）。
const APPROVAL_KEY_CHOICES_A = [
  { name: "処罰の決定・執行", value: "punishment_decision" },
  { name: "恩赦", value: "amnesty" },
  { name: "特定保護区域の設定", value: "protected_area_designation" },
  { name: "情報の不開示決定", value: "info_nondisclosure" },
  { name: "参加審査後の可否", value: "participation_review" },
  { name: "領土の譲渡の承認", value: "territory_transfer_approval" },
  { name: "国家の公認・公認取消", value: "nation_recognition" },
  { name: "ルールの制定・改正（特別多数）", value: "rule_enactment" },
  { name: "ワールドデータの外部利用（参加者限定）", value: "worlddata_external_participants_only" },
  { name: "ワールドデータの外部利用（非参加者含む・特別多数）", value: "worlddata_external_include_nonparticipants" },
  { name: "運営者の処罰・解任（本人除く全会一致・target必須）", value: "staff_punishment_dismissal" },
  { name: "運営者の再任（本人除く全会一致・target必須）", value: "staff_reappointment" },
  { name: "その他（分類表にない事項・通常多数決）", value: "other_majority" },
];

const APPROVAL_KEY_CHOICES_B = [
  { name: "技術者のコマンド使用（利益増進目的）", value: "technician_beneficial_command" },
];

// /vote start・/vote status・/vote end（参加者投票・2026-09-06決定）で選択できる承認事項。
// settings.participant_approval_types のキーと一致させること（運営投票側のsettings.approval_typesとは
// 別テーブルのため、一部キー名が重複していても競合しない）。
const APPROVAL_KEY_CHOICES_PARTICIPANT = [
  { name: "参加者となる権利の取得（元参加者）", value: "former_participant_readmission" },
  { name: "ワールドデータの外部利用（参加者限定）", value: "worlddata_external_participants_only" },
  { name: "ワールドデータの外部利用（非参加者含む・特別多数）", value: "worlddata_external_include_nonparticipants" },
  { name: "ルール改正", value: "rule_enactment" },
  { name: "その他（分類表にない事項・通常多数決）", value: "other_majority" },
];

// /kaihatsu set の image1..imageN オプション数（既定値。実際の上限はsettings.attachment_zone_count_default
// で運用時に変更できるが、Discordのコマンド定義自体は固定値のため、最大値（ゾーン数16・#33）で登録する）。
const KAIHATSU_SET_MAX_IMAGES = 16;

function kaihatsuSetImageOptions() {
  const options = [];
  for (let i = 1; i <= KAIHATSU_SET_MAX_IMAGES; i++) {
    options.push({
      type: OPTION_TYPE.ATTACHMENT,
      name: `image${i}`,
      description: `申請画像 ${i}枚目（{ゾーン番号2桁}_{プレイヤー名}.png）`,
      required: i === 1,
    });
  }
  return options;
}

const commands = [
  {
    name: "kaihatsu",
    description: "個人開発領の届出・確認（令和8年ルール第3号）",
    options: [
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "set",
        description: "個人開発領の設定・変更を届け出ます（全範囲を宣言する宣言型モデル）",
        options: [
          ...kaihatsuSetImageOptions(),
          {
            type: OPTION_TYPE.STRING,
            name: "group",
            description: "同時処理グループ識別子（譲渡等。指定するとgroup_finalizeで締め切るまで受付のみ行う）",
            required: false,
          },
        ],
      },
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "delete",
        description: "個人開発領の全部削除を届け出ます（復元はできません）",
        options: [
          {
            type: OPTION_TYPE.STRING,
            name: "mcuser",
            description: "削除対象のMinecraftユーザー名（省略時は自分自身。他者指定は必ずgroupを伴わせてください）",
            required: false,
          },
          {
            type: OPTION_TYPE.STRING,
            name: "group",
            description: "同時処理グループ識別子（譲渡等。他者を指定する場合は必須）",
            required: false,
          },
        ],
      },
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "list",
        description: "自分の個人開発領の登録状況を確認します",
      },
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "group_finalize",
        description: "同時処理グループの受付を締め切り、判定処理を開始します（代表者のみ実行可）",
        options: [
          {
            type: OPTION_TYPE.STRING,
            name: "group",
            description: "締め切る同時処理グループ識別子",
            required: true,
          },
        ],
      },
    ],
  },
  {
    name: "authorise",
    description: "自身のMinecraftユーザー名をDiscordアカウントに紐づけます",
    options: [
      {
        type: OPTION_TYPE.STRING,
        name: "mcuser",
        description: "Minecraftのユーザー名",
        required: true,
      },
    ],
  },
  {
    // Discord APIの制約：同一コマンドでサブコマンドと通常オプションは混在できないため、
    // 要件定義の「/modauth discord:... mcuser:...」＋「サブコマンドremove」は
    // 「/modauth link ...」「/modauth remove ...」の2サブコマンドとして実装する。
    name: "modauth",
    description: "運営者による紐づけの登録・変更・解除",
    options: [
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "link",
        description: "紐づけを登録・変更します",
        options: [
          {
            type: OPTION_TYPE.USER,
            name: "discord",
            description: "対象のDiscordユーザー",
            required: true,
          },
          {
            type: OPTION_TYPE.STRING,
            name: "mcuser",
            description: "Minecraftのユーザー名",
            required: true,
          },
        ],
      },
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "remove",
        description: "紐づけを解除します",
        options: [
          {
            type: OPTION_TYPE.USER,
            name: "discord",
            description: "対象のDiscordユーザー",
            required: true,
          },
        ],
      },
    ],
  },
  {
    name: "whoami",
    description: "自身の紐づけ状況を確認します（自分にのみ表示）",
  },
  {
    name: "modvote",
    description: "運営の承認（秘密投票・類型A）の開始・状況確認（基本ルール第2条。旧/voteを改名・2026-09-06）",
    options: [
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "start",
        description: "秘密投票を開始します（24時間で自動締切）",
        options: [
          { type: OPTION_TYPE.STRING, name: "approval_key", description: "承認事項（§5.5の分類表）", required: true, choices: APPROVAL_KEY_CHOICES_A },
          { type: OPTION_TYPE.STRING, name: "subject", description: "件名・案件の内容", required: true },
          { type: OPTION_TYPE.USER, name: "target", description: "対象者（本人除外が必要な事項では必須）", required: false },
        ],
      },
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "quick",
        description: "短縮投票を開始します（基本ルール第2条の2。同時会議での全員同意が前提）",
        options: [
          { type: OPTION_TYPE.STRING, name: "approval_key", description: "承認事項（§5.5の分類表）", required: true, choices: APPROVAL_KEY_CHOICES_A },
          { type: OPTION_TYPE.STRING, name: "subject", description: "件名・案件の内容", required: true },
          { type: OPTION_TYPE.USER, name: "target", description: "対象者（本人除外が必要な事項では必須）", required: false },
        ],
      },
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "status",
        description: "投票の状況を確認します（vote_id省略時は進行中の投票を一覧表示）",
        options: [
          { type: OPTION_TYPE.STRING, name: "vote_id", description: "投票ID（入力中に件名で候補表示）", required: false, autocomplete: true },
        ],
      },
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "end",
        description: "投票を期限前に終了し、直ちに集計・結果投稿します（実行資格はstart/quickと同じ）",
        options: [
          { type: OPTION_TYPE.STRING, name: "vote_id", description: "終了する投票ID（入力中に件名で候補表示）", required: true, autocomplete: true },
        ],
      },
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "hogokuiki_build",
        description: "特定保護区域内での建築・採掘の承認を要請します（秘密投票・類型A。禁止事項及び罰則に関するルール第12条第1項）",
        options: [
          { type: OPTION_TYPE.STRING, name: "area_name", description: "対象の特定保護区域名", required: true },
          { type: OPTION_TYPE.STRING, name: "description", description: "建築・採掘内容の説明", required: false },
          { type: OPTION_TYPE.ATTACHMENT, name: "area_image", description: "対象範囲を示す画像（任意）", required: false },
        ],
      },
    ],
  },
  {
    name: "vote",
    description: "参加者投票（秘密投票）の開始・状況確認（2026-09-06新設。/modvoteとは別の母数・分類表を使用）",
    options: [
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "start",
        description: "参加者投票を開始します（24時間で自動締切。短縮投票〔quick〕はありません）",
        options: [
          { type: OPTION_TYPE.STRING, name: "approval_key", description: "承認事項（参加者投票の分類表）", required: true, choices: APPROVAL_KEY_CHOICES_PARTICIPANT },
          { type: OPTION_TYPE.STRING, name: "subject", description: "件名・案件の内容", required: true },
        ],
      },
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "status",
        description: "参加者投票の状況を確認します（vote_id省略時は進行中の投票を一覧表示）",
        options: [
          { type: OPTION_TYPE.STRING, name: "vote_id", description: "投票ID（入力中に件名で候補表示）", required: false, autocomplete: true },
        ],
      },
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "end",
        description: "参加者投票を期限前に終了し、直ちに集計・結果投稿します（実行資格はstartと同じ）",
        options: [
          { type: OPTION_TYPE.STRING, name: "vote_id", description: "終了する投票ID（入力中に件名で候補表示）", required: true, autocomplete: true },
        ],
      },
    ],
  },
  {
    name: "kyoka",
    description: "記名許可要請を作成します（類型B・§5.4）",
    options: [
      { type: OPTION_TYPE.STRING, name: "kind", description: "許可の種別", required: true, choices: APPROVAL_KEY_CHOICES_B },
      { type: OPTION_TYPE.STRING, name: "subject", description: "件名・案件の内容", required: true },
      { type: OPTION_TYPE.STRING, name: "description", description: "補足説明（任意）", required: false },
    ],
  },
  {
    name: "umetate",
    description: "海の埋立ての許可要請（禁止事項及び罰則に関するルール第11条第1項・運営者2人以上のOKで成立）",
    options: [
      { type: OPTION_TYPE.ATTACHMENT, name: "image", description: "埋め立てる範囲を示す地図画像（imageまたはdescriptionのいずれか必須）", required: false },
      { type: OPTION_TYPE.STRING, name: "description", description: "埋め立てる範囲の文章による説明（imageまたはdescriptionのいずれか必須）", required: false },
    ],
  },
  {
    name: "task",
    description: "運営内タスクの操作（§4.2・§4.3・§4.5割当アルゴリズム・§4.5.1共同確認）",
    options: [
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "add",
        description: "タスクを登録します（assignee省略時は割当アルゴリズムで自動割当）",
        options: [
          { type: OPTION_TYPE.STRING, name: "title", description: "タスク名", required: true },
          { type: OPTION_TYPE.STRING, name: "summary", description: "詳細（任意）", required: false },
          { type: OPTION_TYPE.USER, name: "assignee", description: "担当者（任意・省略時は割当アルゴリズムで自動選定）", required: false },
          {
            type: OPTION_TYPE.STRING,
            name: "priority",
            description: "優先度（既定：medium）",
            required: false,
            choices: [
              { name: "高", value: "high" },
              { name: "中", value: "medium" },
              { name: "低", value: "low" },
            ],
          },
          { type: OPTION_TYPE.STRING, name: "tag_1", description: "必要タグ1（§4.4・任意）", required: false, choices: REQUIRED_TAG_CHOICES },
          { type: OPTION_TYPE.STRING, name: "tag_2", description: "必要タグ2（§4.4・任意）", required: false, choices: REQUIRED_TAG_CHOICES },
          { type: OPTION_TYPE.STRING, name: "tag_3", description: "必要タグ3（§4.4・任意）", required: false, choices: REQUIRED_TAG_CHOICES },
          { type: OPTION_TYPE.BOOLEAN, name: "requires_technician", description: "技術者（OP保持者）限定か（既定：false）", required: false },
          { type: OPTION_TYPE.STRING, name: "required_permission_tier", description: "必要な実行権限レベル（§4.5.1・任意）", required: false, choices: PERMISSION_TIER_CHOICES },
          { type: OPTION_TYPE.BOOLEAN, name: "controversial", description: "論争性の高いタスクか（§4.5.1：共同確認者を自動追加）", required: false },
          { type: OPTION_TYPE.INTEGER, name: "estimated_load", description: "想定負荷（1〜5・任意）", required: false, min_value: 1, max_value: 5 },
          {
            type: OPTION_TYPE.STRING,
            name: "due_at",
            description: "期限を手動指定（任意・日本時間・形式：YYYY-MM-DD-hh-mm 例 2026-09-10-18-30）。省略時はBot既定の目標期限",
            required: false,
          },
        ],
      },
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "done",
        description: "タスクを完了にします（根拠の記入が必須）",
        options: [
          { type: OPTION_TYPE.STRING, name: "task_id", description: "タスクID（入力中にタイトルで候補表示）", required: true, autocomplete: true },
          { type: OPTION_TYPE.STRING, name: "evidence", description: "完了の根拠（メッセージリンク等）", required: true },
        ],
      },
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "decline",
        description: "自分に割り当てられたタスクを辞退します（理由不要）",
        options: [
          { type: OPTION_TYPE.STRING, name: "task_id", description: "タスクID（入力中にタイトルで候補表示）", required: true, autocomplete: true },
        ],
      },
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "hold",
        description: "自分に割り当てられたタスクを保留にします（再開予定日が必須）",
        options: [
          { type: OPTION_TYPE.STRING, name: "task_id", description: "タスクID（入力中にタイトルで候補表示）", required: true, autocomplete: true },
          { type: OPTION_TYPE.STRING, name: "resume_at", description: "再開予定日（YYYY-MM-DD）", required: true },
          { type: OPTION_TYPE.STRING, name: "reason", description: "保留理由（任意）", required: false },
        ],
      },
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "list",
        description: "自分に残っているタスクと期限を確認します（本人にのみ表示）",
        options: [],
      },
    ],
  },
  {
    name: "staff",
    description: "運営者本人のプロファイル操作",
    options: [
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "leave",
        description: "休暇の登録・解除（基本ルール第14条。休暇中は投票・記名許可の母数から除外されます）",
        options: [
          {
            type: OPTION_TYPE.STRING,
            name: "action",
            description: "start：休暇を登録 / end：休暇を解除",
            required: true,
            choices: [
              { name: "start（休暇を登録）", value: "start" },
              { name: "end（休暇を解除）", value: "end" },
            ],
          },
          { type: OPTION_TYPE.STRING, name: "until", description: "復帰予定日（YYYY-MM-DD。action:start時に必須）", required: false },
        ],
      },
    ],
  },
  {
    name: "subaccount",
    description: "運営サブ垢の連携（メイン垢からのみ実行可・2026-09-07追加）",
    options: [
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "link",
        description: "サブ垢に本人確認DMを送り、承認されればメイン垢として連携します",
        options: [
          { type: OPTION_TYPE.USER, name: "user", description: "連携するサブ垢（「運営サブ垢」ロール保有者に限る）", required: true },
        ],
      },
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "unlink",
        description: "自分のメイン垢に連携済みのサブ垢の連携を解除します",
        options: [
          { type: OPTION_TYPE.USER, name: "user", description: "解除するサブ垢", required: true },
        ],
      },
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "list",
        description: "自分のメイン垢に連携中のサブ垢の一覧を表示します",
      },
    ],
  },
  {
    name: "ops",
    description: "利用枠消費状況・監査ログの確認",
    options: [
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "cost",
        description: "LLM利用枠の消費状況を確認します（C-5：開発者個人のClaude Pro利用枠）",
      },
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "log",
        description: "監査ログを確認します",
        options: [
          { type: OPTION_TYPE.INTEGER, name: "limit", description: "表示件数（既定20・最大50）", required: false },
          { type: OPTION_TYPE.USER, name: "actor", description: "実行者で絞り込み（任意）", required: false },
        ],
      },
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "dashboard",
        description: "運営・参加者向けダッシュボードを即時更新、または運営ダッシュボードを新規投稿し直します",
        options: [
          {
            type: OPTION_TYPE.STRING,
            name: "action",
            description: "即時更新：既存メッセージを自動更新を待たず即時に更新 / 再投稿：運営ダッシュボードを新規投稿し直す",
            required: true,
            choices: [
              { name: "即時更新（既存メッセージを更新）", value: "update" },
              { name: "再投稿（運営ダッシュボードを新規投稿し直す）", value: "repost" },
            ],
          },
        ],
      },
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "llm",
        description: "LLM層（シャドーモード・§7）の一時停止／再開／状態確認を行います",
        options: [
          {
            type: OPTION_TYPE.STRING,
            name: "action",
            description: "省略時は状態確認のみ",
            required: false,
            choices: [
              { name: "状態確認", value: "status" },
              { name: "一時停止（縮退運転・C-2）", value: "pause" },
              { name: "再開", value: "resume" },
            ],
          },
        ],
      },
    ],
  },
];

async function main() {
  const appId = requireEnv("DISCORD_APP_ID");
  const token = requireEnv("DISCORD_BOT_TOKEN");
  const guildOnly = process.argv.includes("--guild");

  const url = guildOnly
    ? `https://discord.com/api/v10/applications/${appId}/guilds/${requireEnv("DISCORD_GUILD_ID")}/commands`
    : `https://discord.com/api/v10/applications/${appId}/commands`;

  const res = await fetch(url, {
    method: "PUT",
    headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!res.ok) {
    console.error(`登録失敗: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  console.log(`登録成功（${guildOnly ? "ギルド限定" : "グローバル"}）: ${commands.map((c) => c.name).join(", ")}`);
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`環境変数 ${name} が未設定です`);
    process.exit(1);
  }
  return v;
}

main();
