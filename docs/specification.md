# OpsBot 技術仕様書（現在の実装ベース）

> **この文書の位置づけ**：**Phase 7時点で実際に動いているコードの仕様**を技術者向けにまとめたもの。
> 本リポジトリで公開している技術文書の一次資料である。運用者向けの使い方は
> [`guide-staff.md`](guide-staff.md)（運営者向け）/ [`guide-participants.md`](guide-participants.md)（参加者向け）、
> セットアップ手順は [`../README.md`](../README.md) を参照。
>
> なお、要件定義の原本・フェーズごとの実装計画・意思決定ログ（`decisions.md`）・未確定事項の管理表
> （`open-items.md`）は、運営内の未合意論点や環境固有の情報を含むため公開していない。本書および
> ソース中のコメントに残る `§5.7`・`decisions.md #53`・`open-items #41` のような参照は、それらの
> 非公開文書の該当箇所を指す。

最終更新：2026-09-07（Phase 7完了時点）

---

## 0. 設計上の絶対制約（C-1〜C-7）

実装上、以下は他のどの判断にも優先する。

| ID | 制約 | 理由 |
|---|---|---|
| C-1 | **LLM呼び出しは「機械的に判定できない処理」に限定する。** 判定可能な処理（面積計算、重複判定、期限計算、票の集計、通知送信、督促スケジューリング、状態遷移）は一切LLMを介さず実装する。 | 利用枠消費の抑制（C-5により一層重要） |
| C-2 | **LLM層が停止しても他の全機能は単独で動作を継続する。** LLM層は「あると便利な検出器」であり、申請受付・投票・許可・督促・台帳はLLM抜きで完結させる。 | 可用性・利用枠上限到達時の縮退運転 |
| C-3 | **Botは賛否の判断を代行しない。** 承認・却下・処罰・許可はすべて人間の入力を起点とする（例外：§5.7の形式審査） | ルール適合性 |
| C-4 | **開発者の手作業を要する運用は設計しない。** 日次の確認・手動投入・プロンプト実行を前提とする機能は不採用とする。 | 属人化の再生産を防ぐ |
| C-5 | **LLM呼び出しは開発者個人のClaude Pro利用枠を用いる（API課金は用いない）。** この利用枠は開発者の日常的なClaude Code利用と共有される。 | C-1の徹底が従来以上に重要になる |
| C-6 | **秘密投票・記名許可・Bot形式審査を混同しない。** 3者はルール上性質が異なり、実装上も別モジュールとして分離する。 | §5参照 |
| C-7 | **Minecraftサーバーの稼働に影響を与えない。** 実装可能な範囲で外部無料サービス（Cloudflare Workers等）を優先し、Proxmox CTでの常時稼働処理は必要最小限に絞る。 | 決定事項 |

あわせて、設定値・チャンネルID・運営者プロファイル・承認事項の分類表はハードコードせず、
D1の `settings` テーブルまたは環境変数へ外出しする。

---

## 1. システム構成

### 1.1 全体像

2層構成。DiscordへのGateway常時接続は持たない。

```
Discord ──(Interactions Webhook)──> Cloudflare Workers (opsbot) ──> D1 (opsbot)
                                            ^
                                            │ HTTPSポーリング（プル方式。Workers→CT102の経路は存在しない）
                                            │
                                     CT102 (Proxmox CT, Python, poller.py)
                                            │
                    ┌───────────────────────┼───────────────────────┐
                    │                       │                       │
              Crafty Controller API   制限付きSSH(強制コマンド)   Claude Code CLI（headless）
              (crafty:8443)           → CT104 (Dynmap配信)         （LLM呼び出し）
```

### 1.2 Cloudflare Workers（`workers/`）

- エントリポイント：`workers/src/index.ts`。`fetch`ハンドラは以下4エンドポイントのみを処理し、他はすべて404。
  - `GET /health`
  - `POST /interactions` — Discord Interactions受信。`src/discord/verify.ts`でEd25519署名検証必須。
  - `POST /ct/jobs/poll` — CT102からのジョブ取得。`isCtAuthorized`でBearerトークン認証。
  - `POST /ct/jobs/complete` — CT102からの処理結果報告。
- `handleInteractions`：PING応答、AUTOCOMPLETE（`buildAutocompleteResponse`）、APPLICATION_COMMAND（コマンド名でルーティング）、MESSAGE_COMPONENT（`custom_id`のprefixで分岐）、MODAL_SUBMITを処理。
- D1バインディング：`DB`（database_name: `opsbot`）。マイグレーションは`workers/migrations/`。
- 秘密情報（`DISCORD_BOT_TOKEN`等）は`wrangler secret`で登録。型定義は`src/env.ts`に集約。

### 1.3 Cron Triggers（`workers/wrangler.jsonc`）

Cloudflare Workers Free枠の上限（アカウント全体で5件）のため、cron自体は5本に固定し、複数のバッチ処理を相乗りさせている。

| cron式 | 定数名 | 実行内容 |
|---|---|---|
| `*/5 * * * *` | CRON_STALE_JOBS | `detectStaleJobs`（job_queueの滞留検知） |
| `0 * * * *` | CRON_MEMBER_DIFF | `runMemberDiff`（脱退・ロール喪失の差分検知） |
| `0 9 * * *` | CRON_WHITELIST_AUDIT | `triggerWhitelistAudit`（日次ホワイトリスト突合） |
| `*/10 * * * *` | CRON_FAST | `processVoteDeadlines` + `processTaskHoldResume` + `processVoteReminders` |
| `*/15 * * * *` | CRON_SLOW | `processPhase3Deadlines` + `processNudges` + `updateDashboards` + `runTicketChannelScan` + `runLlmMessageScan` |

- `CRON_SLOW`配下のLLM関連2処理（`runTicketChannelScan`／`runLlmMessageScan`）は関数内部で絶対時刻ゲート（D1保存の最終実行時刻との比較）により実質30分・1時間間隔に間引かれる。
- 締切・撤回猶予等の期限判定はすべてD1保存の絶対時刻（UTC ISO8601）で行い、cronの発火間隔には依存しない設計（`workers/CLAUDE.md`）。そのため`*/10 * * * *`運用では締切処理に最大10分の遅延が生じ得る（`docs/decisions.md` #55）。

### 1.4 CT102（`ct/opsbot_ct/`、Python）

- `poller.py`：ポーリングループ本体。CT102からWorkersへ`POST /ct/jobs/poll`（`capacity: {image, llm, crafty}`）をアウトバウンドHTTPSで送信し、ジョブを取得。処理後`POST /ct/jobs/complete`で結果報告。適応間隔（`settings.polling`：`active_interval_sec`=4秒 / `idle_interval_sec`=45秒）。node-exporter textfile collector向けのハートビート出力もここで行う。
- `config.py`：`/etc/opsbot/ct.env`から読む設定を`Config`データクラスに集約。
- `image.py`：個人開発領のピクセル処理本体。ファイル名解析、条件①〜⑧判定、面積計算、重複判定、確認画像生成。単独申請・バッチ（代表者一括／グループ）の両方に対応。
- `crafty.py`：Crafty Controller v2 REST APIクライアント。コンソールコマンド送信は`POST /api/v2/servers/{id}/stdin`（プレーンテキスト）。静的APIトークン＋起動時TLS証明書フィンガープリントのピン留め（`verify_pin`）。ホワイトリスト一覧の取得はAPIに専用エンドポイントがないため、コンソールログをパースするベストエフォート実装（`parse_whitelist_list`）。
- `mojang.py`：Mojang APIによるユーザー名⇄UUID解決。Cloudflare WorkersからMojang APIへの直接呼び出しが403で拒否されることが判明したため、CT102経由（job_queue方式）に変更した（`docs/decisions.md`関連、メモリ参照）。
- `dynmap_regions.py`：既存Dynmapオーバーレイの`regions`配列JSのテキスト処理（純粋関数・ネットワークI/Oなし）。
- `dynmap_ssh.py`：CT104への制限付きSSH実行クライアント（強制コマンド・ホスト鍵ピン留め）。
- `dynmap_sync.py`：`dynmap_regions`と`dynmap_ssh`を組み合わせたジョブ本体。
- `llm.py`：Claude Code CLIのheadless呼び出し（`claude -p --output-format json --max-turns 1`）。プロンプトは標準入力経由で渡し、機微情報がプロセス引数や履歴に残らないようにしている。ルール条文は`grep_rule_excerpts`で該当部分のみを抜粋して投入する。

### 1.5 通信経路のまとめ

| 経路 | 方式 | 備考 |
|---|---|---|
| Discord → Workers | Interactions Webhook | Gateway常時接続なし |
| CT102 → Workers | アウトバウンドHTTPSポーリング | プル方式。Workers→CT102の経路は存在しない（`docs/decisions.md` #36） |
| CT102 → Crafty Controller | Vnet内直接HTTPS（`https://<crafty-host>:8443`） | Cloudflare Tunnel非経由。証明書ピン留め |
| CT102 → CT104（Dynmap配信） | 制限付きSSH（強制コマンド） | `OPSBOT_DYNMAP_SYNC_ENABLED=false`が既定。実際の疎通確認・true切替は未実施（`docs/decisions.md` #53） |
| CT102 → Claude Code CLI | ローカルプロセス呼び出し（headless） | 開発者個人のClaude Pro利用枠を使用（C-5） |

---

## 2. データモデル（D1、`workers/migrations/0001〜0013`適用後）

### 2.1 テーブル一覧

| テーブル | 追加マイグレーション | 役割 |
|---|---|---|
| `settings` | 0001 | 設定値（key/value、valueはJSON文字列）。ハードコード禁止の設定はすべてここ |
| `staff` | 0001 | 運営者プロファイル（タグ・権限tier・休暇状態等） |
| `tasks` | 0001（0011で拡張） | タスク台帳（T-A/T-B/T-C共通） |
| `applications` | 0001（0003・0006で拡張） | 個人開発領の届出（申請） |
| `claims` | 0001（0003で拡張） | 個人開発領の確定した領域（面積・オーナー等） |
| `protected_areas` | 0001（0004で拡張） | 特定保護区域（現状0件運用。`docs/decisions.md` #50） |
| `votes` | 0001（0012で拡張） | 投票（運営投票・参加者投票を`voter_scope`列で1テーブルに統合） |
| `vote_ballots` | 0001 | 投票の個別票 |
| `permissions` | 0001 | 記名許可のOK/NG記録 |
| `permission_requests` | 0007 | 記名許可の要請本体（`/kyoka`・`/umetate`） |
| `revocations` | 0001 | 撤回記録 |
| `account_links` | 0001（0002で拡張） | Discordアカウント⇄Minecraft UUIDの紐づけ |
| `job_queue` | 0001（0005で拡張） | CT102とのジョブキュー |
| `nudge_log` | 0001 | 督促の送信記録 |
| `audit_log` | 0001 | 監査ログ（記名操作の証跡） |
| `llm_usage` | 0001 | LLM呼び出しのトークン数・コスト計測 |
| `cursors` | 0001 | 差分取得用カーソル（メンバー一覧等） |
| `application_groups` | 0006 | 個人開発領の同時処理グループ |
| `monitored_channels` | 0009 | LLM層が監視するチャンネル（ticket tool含む） |
| `llm_shadow_detections` | 0009（0011で拡張） | LLM層の検出結果（シャドーモード記録・候補審査） |
| `dashboard_messages` | 0008 | 固定ダッシュボードメッセージの管理 |
| `staff_subaccounts` | 0013 | 運営者本人とサブ垢の対応 |

### 2.2 主要な制約・冪等性の仕組み

- `tasks.source_message_url` に UNIQUE 制約。LLM検出ジョブが再実行されても`insertDetectedTask`が同一タスクIDを返す（冪等）。
- `account_links`：主キーは `minecraft_uuid`（ユーザー名は変更されうるため。`docs/decisions.md` #32）。`UNIQUE INDEX idx_account_links_discord_active ON account_links(discord_id) WHERE status='active'` により、1 Discord IDにつき有効な紐づけは常に1件のみ。
- `vote_ballots`：`PRIMARY KEY(vote_id, voter_id)` で二重投票を防止。
- `permissions`：`UNIQUE INDEX idx_permissions_request_granter ON permissions(permission_request_id, granter_id)` で同一人物の二重記名を防止。
- `llm_shadow_detections.source_message_url` に UNIQUE 制約（二重検出防止）。
- `staff_subaccounts`：主キー `sub_discord_id`（1サブ垢は1メイン垢のみに紐づく）。
- `votes.voter_scope`（`'unei'` | `'participant'`）で運営投票（`/modvote`）と参加者投票（`/vote`）を同一テーブル・同一集計ロジックで扱う。
- `applications`（0006）：`op`（`'set'` | `'delete'`）、`group_key`、`provisional_until`、`revocable_until`等を追加し、仮承認・同時処理グループ・撤回猶予の状態遷移をこのテーブルの列だけで表現している。
- 投票の締切処理は`finalizeVoteTally`のUPDATE文が`status='open'`を条件とすることで、Cronの締切処理と`/modvote end`・`/vote end`の同時実行を排他制御している（`docs/decisions.md` #58）。

---

## 3. スラッシュコマンド一覧（`workers/scripts/register-commands.mjs`が正）

全12コマンド。`vote_id`・`task_id`はいずれも `STRING` 型＋`autocomplete: true`（Discord上で件名／タイトルから検索できるようにするための実装。`docs/decisions.md` #59・#60）。

| コマンド | サブコマンド | 概要 |
|---|---|---|
| `/kaihatsu` | `set` / `delete` / `list` / `group_finalize` | 個人開発領の届出（§4節） |
| `/authorise` | — | 自分のMinecraftアカウントを紐づける |
| `/modauth` | `link` / `remove` | 運営者による紐づけの登録・変更・解除 |
| `/whoami` | — | 自分の紐づけ状況確認 |
| `/modvote` | `start` / `quick` / `status` / `end` / `hogokuiki_build` | 運営の秘密投票（旧`/vote`。§5節） |
| `/vote` | `start` / `status` / `end` | 参加者投票（`quick`は存在しない。§5節） |
| `/kyoka` | — | 記名許可要請（技術者コマンド使用等） |
| `/umetate` | — | 海の埋立て許可要請 |
| `/task` | `add` / `done` / `decline` / `hold` / `list` | タスク管理（§6節） |
| `/staff` | `leave` | 運営者の休暇登録・解除 |
| `/subaccount` | `link` / `unlink` / `list` | 運営サブ垢連携（§7節） |
| `/ops` | `cost` / `log` / `dashboard` / `llm` | 運用系（利用枠確認・監査ログ・ダッシュボード・LLM層制御） |

**未実装**：`/kokka territory`・`/kokka rename`（国家代表者ロール未整備のため`docs/open-items.md` #46のとおり保留。コマンド定義自体が存在しない）。`/toiawase`は仕様として不採用（`docs/decisions.md` #41。既存ticket toolチャンネルの監視＋LLM層のバッチ処理で代替）。

---

## 4. 個人開発領の届出（`/kaihatsu`、`workers/src/kaihatsu/`）

### 4.1 3つの申請経路

1. **単独申請**：`set`の添付画像がすべて自分自身のものであれば、Bot形式審査により即時承認・却下（撤回ボタン付き）。
2. **代表者による一括申請**：添付画像に他者のものが含まれる場合、代表者一括申請として扱われ、形式要件を満たせば**仮承認**となり、本人へ72時間の確認DMを送信する。72時間以内に本人が承認すれば正式承認、取り下げまたは無反応ならその者のみ却下される（`docs/decisions.md` #27・#28）。
3. **同時処理グループ**：`set`/`delete`に`group`オプションを指定することで、複数人分の申請を1つのグループとしてまとめ、アトミックに扱う（1人でも不成立ならグループ全体を却下）。`group_finalize`で受付を締め切ると評価が開始される。**削除を先に評価してから設定を判定**する順序になっている（第8条第3項ただし書を自然に満たすための設計。`docs/decisions.md` #30）。

### 4.2 実装上の主なファイルと役割

- `setCommand.ts`：上記3経路への振り分け。単独申請は即時job投入、代表者一括申請は`startBatchKaihatsuSetJob`。
- `deleteCommand.ts`：自分自身なら即時確定、他者を対象とする場合は必ず`group`を伴わせる。
- `groupFinalizeCommand.ts`：グループ作成者本人のみ実行可能。締切操作でCT評価とDM送信を開始。
- `confirmCommand.ts`：本人確認ボタン（確認／取り下げ）のハンドラ。
- `revokeCommand.ts`：正式承認から24時間以内、運営者1人の操作（モーダルで理由入力）で撤回可能。撤回すると監査ログに記録され、手動審査タスク（T-A）が起票される（`docs/decisions.md` #12）。
- `phase3.ts`：保留解放・正式承認確定（`finalizeApprovedSet`／`finalizeApprovedDelete`）、重複候補プール構築の共通処理。正式承認が確定すると`dynmap_sync`ジョブがenqueueされる（§1.4参照。実際の反映は`OPSBOT_DYNMAP_SYNC_ENABLED`次第）。
- `domain.ts`：純粋関数群。`decomposeApplication`（設定／変更／一部削除ラベルの算出）、`resolveGroup`（アトミック判定）、`orderGroupMembersForEvaluation`（delete先行評価の順序決定）等。

### 4.3 競合・仮承認まわりの規則

- 仮承認中の同一人物による新規`set`は拒否される（先行の仮承認の確認完了・却下確定まで。`docs/decisions.md` #47）。
- 仮承認と競合する後続の届出は却下せず保留とし、先行が却下確定した時点で当初の届出時刻を維持したまま自動再審査される（`docs/decisions.md` #29）。
- 重複却下時は重複相手のMinecraft名を却下通知に含める。削除された範囲は復元しない代わりに、確認画像で警告表示を充実させる（`docs/decisions.md` #52・open-items #38）。
- 特定保護区域（`protected_areas`）は現状登録0件として運用しており、条件⑤は常に通過する暫定運用（`docs/decisions.md` #50）。テーブル・判定ロジック自体はPhase 2で実装済みで、データ投入後に自動的に機能する。

### 4.4 CT102側の処理（`ct/opsbot_ct/image.py`）

ファイル名解析、条件①〜⑧の判定、面積計算（+1補正）、重複判定、確認画像生成を行う。単独申請・バッチ両対応。

### 4.5 移行ツール

`tools/migrate_claims.py`：既存Dynmapオーバーレイの`regions.js`（正規表現パース）と`images/indiv/*.png`から`claims`テーブルへ一回限りの移行を行うスクリプト。Mojang UUID解決を含む。CT102への配置手順込みで`claims-seed.sql`を生成する。実データの提供待ちで本番投入は未実施（`migrated_masks/`にサンプル実行分と見られる出力が存在）。

---

## 5. 投票・記名許可（`workers/src/votes/`・`workers/src/permissions/`）

### 5.1 秘密投票（`/modvote`・`/vote`）

- `tallyVote`（`votes/domain.ts`）が6種類の定足数計算方式（quorum_type）を実装：

  | quorum_type | 意味 |
  |---|---|
  | `voters_majority` | 棄権者を除く運営投票者の過半数（通常の秘密投票） |
  | `supermajority_voters` | 同・特別多数（`threshold`使用） |
  | `total_majority_excl_abstain` | 短縮投票専用（`/modvote quick`固定） |
  | `supermajority_total` | 運営者総数に対する特別多数（`threshold`使用） |
  | `total_majority_incl_abstain` | 棄権者も母数に含めた総数の過半数（`threshold`不使用。参加者投票の「ワールドデータの外部利用（非参加者含む）」用。2026-09-06決定） |
  | `unanimous_excl_target` | 対象者本人を除く全員の賛成（`exclude_self: true`とセット） |

- `/modvote`（運営投票）＝`modvoteCommand.ts`：`start`・`quick`・`status`・`end`・`hogokuiki_build`（内部的に`start`と同じ経路で`approval_key: protected_area_build_approval`固定。`docs/decisions.md` #56）。
- `/vote`（参加者投票）＝`participantVoteCommand.ts`：`start`・`status`・`end`のみ（`quick`は存在しない）。実行資格（開始・終了）は運営者ロールと同じだが、母数は「人民」ロール保有者数（休暇制度は運営者のみに適用のため除外判定なし。`docs/decisions.md` #61）。
- 両者は`voteShared.ts`の`closeAndTallyVote`を共用。締切cronは`processVoteDeadlines`（10分毎、最大10分遅延あり）。急を要する場合や短縮投票で全員投票済みの場合は`/modvote end`・`/vote end`で1人の実行により即時終了できる（`docs/decisions.md` #58）。
- 承認事項の分類表は運営投票用（`settings.approval_types`）と参加者投票用（`settings.participant_approval_types`）でテーブルが分かれている（§6.2参照）。

### 5.2 記名許可（`/kyoka`・`/umetate`）

- 共通実装：`permissions/kyokaCommand.ts`の`createPermissionRequest`。OK/NG/取り下げボタンは`handlePermissionButton`。
- 成立判定はただ1つの純粋関数：`isPermissionApproved(okCount, requiredCount) = okCount >= requiredCount`（`permissions/domain.ts`）。
- `/kyoka kind:technician_beneficial_command`：`required_count: 3`（技術者のコマンド使用・利益増進目的）。
- `/umetate`：`approval_key`固定`land_reclamation`、`required_count: 2`（禁止事項及び罰則に関するルール第11条第1項。`docs/decisions.md` #40）。画像または文章説明のいずれか必須。
- 押下者名・押下時刻は公開・永久記録（類型B）。

---

## 6. タスク管理（`/task`、`workers/src/tasks/`）

### 6.1 自動割当アルゴリズム（`assignment.ts`）

1. **ハード条件**（`isHardEligible`）：`active`である／休暇中でない／技術者要件を満たす／必要な`discord_permission_tier`以上／現在の負荷が`max_concurrent`未満、など。
2. **スコア式**（`computeScore`）：

   ```
   score = w1 * タグ一致度 − w1' * 弱みペナルティ
         + w2 * 空き度 + w3 * 完了率 + w4 * 稼働時間適合度
         − w5 * 連続割当ペナルティ
   ```

   重みは`settings.assignment_weights`（w1, w1_prime, w2, w3, w4, w5, tag_match_threshold, consecutive_assign_limit）。
3. 同点、または全候補がタグ一致度閾値未満の場合は`llmFallbackCandidateIds`（スコア上位5件）をLLM層のタイブレークに委ねる（C-1の例外＝機械的に一意に決められない場合のみLLMを使う）。

### 6.2 共同確認（`requires_cosign`）

`autoAssign.ts`：`requires_cosign`（staffプロファイル側の属性）、または`/task add controversial:true`、または`controversial_review`タグが絡む場合、次点候補者を共同確認者として自動追加する（§4.5.1）。`done`は担当者・共同確認者の両方の完了操作が揃って初めて完了になる（`recordCompletion`）。

### 6.3 コマンド

- `add`：`assignee`省略時は上記アルゴリズムで自動割当。`priority`・`tag_1〜3`・`requires_technician`・`required_permission_tier`・`controversial`・`estimated_load`・`due_at`を指定可能。
- `done`：`evidence`（根拠）記入必須。運営者なら誰でも実行可（共同確認タスクは担当者・共同確認者本人のみ）。
- `decline`：担当者本人のみ、理由不要。割当アルゴリズムで次点の運営者へ自動再割当（候補がなければ運営チャンネルへ手動対応依頼）。
- `hold`：担当者本人のみ。再開予定日（`resume_at`）必須。到来時に`processTaskHoldResume`（cron）で自動的に割当済へ復帰。
- `list`：一覧表示。
- `task_id`はいずれもタイトルの部分一致でautocomplete表示（`decline`・`hold`は自分に割り当てられたタスクのみ候補、`done`は全未完了タスクが候補）。

### 6.4 督促（Nudge）

`settings.nudge`：Lv1（DM・24h後）／Lv2（担当者メンション・運営専用チャンネル・72h後）／Lv3（全体共有・120h後）／Lv4（自動再割当・168h後）。`quiet_hours`・`max_per_day`あり。

---

## 7. アカウント紐づけ・ホワイトリスト（`workers/src/accountLinks/`）

- `/authorise mcuser:<name>`（本人）・`/modauth link|remove`（運営者・監査ログ保存）・`/whoami`。
- 主キーはMinecraft UUID（ユーザー名変更対策。`docs/decisions.md` #32）。
- 却下条件（`domain.ts`の`decideAuthorise`／`decideModauth`が純粋関数として実装）：実在しないMinecraftユーザー名、既に他者に紐づけ済み、等。
- `/modauth`はDiscord APIの制約（同一コマンドにサブコマンドと通常オプションを混在できない）により、要件定義上の記法（`/modauth discord:... mcuser:...`）を`link`サブコマンドとして実装している。
- 上書き時（既存の紐づけと競合する場合）は確認ボタンを挟む。
- 紐づけ成功時はホワイトリストへ自動追加、脱退・ロール喪失時は自動削除。実処理は`crafty_op`ジョブとしてenqueueし、CT102の`crafty.py`がCrafty Controller経由でコンソールコマンドを送信する。
- 脱退検知：`runMemberDiff`（毎時cron）によるギルドメンバー一覧の定期差分検知。GUILD_MEMBERS特権インテントが必要。

### 7.1 運営サブ垢連携（`/subaccount`、2026-09-07決定）

- `staffCommand`系ではなく`workers/src/staff/subaccountCommand.ts`・`subaccountEligibility.ts`。
- `resolveUneiActor`が全運営コマンドの実行資格解決の共通経路になっており、サブ垢からの操作を本体の運営者アカウントとして扱えるようにしている。
- `staff_subaccounts`テーブル：主キー`sub_discord_id`（1サブ垢は1メイン垢のみに紐づく）。

---

## 8. LLM層（`workers/src/llm/`・C-1〜C-2・§7）

### 8.1 検出対象と前処理

- `prefilter.ts`：Bot発言除外、スタンプのみのメッセージ除外、`settings.llm.min_message_chars`未満の除外、`coarse_filter_patterns`（キーワード正規表現、空なら文字数のみで判定）。
- `messageScan.ts`：通常監視チャンネルの差分取得。絶対時刻ゲートで実質30分間隔（`settings.llm.scan_interval_sec`）。1ジョブあたり最大50メッセージ（`MAX_MESSAGES_PER_JOB`）。
- `ticketScan.ts`：ticket toolチャンネルの監視。親カテゴリIDで判別し、クローズ検知は3パターン（チャンネル消失／リネーム／カテゴリ移動）に対応。
- `safety.ts`：`sanitizePositiveNote`（LLMが生成した補足コメントの安全化。60文字超やNGワード含みの場合はnullにする）。

### 8.2 シャドーモード（`settings.llm.shadow_mode`、Phase 6〜7）

- `detectionCompletion.ts`が本体。`shadow_mode: true`（既定）の間は、検出結果を`llm_shadow_detections`に記録するのみで、通知は開発者個人のDMにしか送らない。実タスク・実通知は一切発生しない。
- `confidence < confidence_threshold`（既定0.6）の検出は「候補」として扱われ、`shadow_mode: false`の本稼働時には運営専用チャンネルへ採否ボタン（`candidateReview.ts`）付きで提示される。「採用してタスク化」を押すと`autoAssign`を実行して実タスク化、「却下」を押すと`candidate_rejected`として終了する。
- `shadow_mode`をfalseに切り替えるだけで本稼働（実タスク起票・実通知）に切り替わる設計で、コード変更・再デプロイは不要（`settings.yaml`書き換え＋`npm run settings:seed`のみ）。`/ops llm action:pause|resume`（縮退運転）とは独立した別軸のフラグ。
- LLM検出タスクであることが担当者に分かるよう、手動`/task add`とは異なる通知文面（`buildLlmDetectedAssignedNotice`）を使う（確信度・AI補足コメントを含む。§10-8：Botの判定であることの明示）。

### 8.3 縮退運転（C-2）

- `consecutive_failure_pause_threshold`（既定5）回連続でLLM呼び出しが失敗すると自動的に`paused: true`になる（`maybeAutoPauseOnFailures`）。
- `/ops llm action:status|pause|resume`で運営者が手動制御可能。
- 利用枠計測は`llm_usage`テーブルへ記録し、`/ops cost`で確認できる。この記録・縮退運転ロジックは`shadow_mode`の値に関わらず同じ挙動を維持する。

### 8.4 現状のドライラン状況

Phase 7完了時点で`shadow_mode: true`のまま。§9のドライラン（最低1週間のシャドーモード運用・誤検出率の確認）は未実施（`docs/phases/phase-7-checklist.md`）。

---

## 9. 設定スキーマ

### 9.1 `settings.yaml`（D1 `settings`テーブルへ投入。実ファイルは`.gitignore`対象、ひな形は`settings.example.yaml`）

`workers/scripts/settings-schema.mjs`の`KNOWN_KEYS`（14キー）：

`discord_guild_id` / `channels` / `ticket_tool` / `deadlines` / `assignment_weights` / `nudge` / `attachment_zone_count_default` / `polling` / `account_link` / `roles` / `job_retry` / `approval_types` / `participant_approval_types` / `task_target_days` / `llm`

主なサブキー：

- `channels`：`kaihatsu_ryo` / `shokokuho` / `kaigijo_forum` / `unei_only` / `vote_hall`（運営投票専用。`docs/decisions.md` #54） / `participant_vote_hall`（参加者投票専用。当初`vote_hall`と同値だったが2026-09-06に専用チャンネルへ切替済み） / `application_status` / `notify_default`
- `deadlines`：`vote_hours`(24) / `provisional_confirm_hours`(72) / `revoke_window_hours`(24) / `conflict_hold_hours`(72) / `quick_vote_minutes`(15)
- `roles`：`hito`（人民） / `kari_sanka`（仮参加者） / `sub_aka`（サブ垢・`/authorise`対象外） / `unei`（運営者）。**注意**：0013で追加された`unei_sub`（運営サブ垢ロール）は`settings-schema.mjs`のバリデータが現状チェック対象に含めていない可能性がある。仕様書執筆時点で要確認・要修正候補。
- `approval_types`（運営投票の分類表・§5.5）：`punishment_decision` / `amnesty` / `protected_area_designation` / `protected_area_build_approval` / `info_nondisclosure` / `participation_review` / `territory_transfer_approval` / `nation_recognition` / `rule_enactment`（特別多数2/3） / `worlddata_external_participants_only` / `worlddata_external_include_nonparticipants`（特別多数2/3） / `staff_punishment_dismissal`（`unanimous_excl_target`・`target`必須） / `staff_reappointment`（同） / `land_reclamation`（method B、`/umetate`用） / `technician_beneficial_command`（method B、`/kyoka`用） / `other_majority`（汎用枠。2026-09-06追加、`docs/decisions.md` #57）
- `participant_approval_types`（参加者投票の分類表。2026-09-06新設、`docs/decisions.md` #61）：`former_participant_readmission` / `worlddata_external_participants_only` / `worlddata_external_include_nonparticipants`（`total_majority_incl_abstain`） / `rule_enactment`（通常の`voters_majority`。運営側の2/3特別多数とは揃えない） / `other_majority`
- `llm`：`developer_discord_id` / `confidence_threshold`(0.6) / `max_tokens`(1024) / `min_message_chars`(8) / `coarse_filter_patterns` / `scan_interval_sec`(1800) / `consecutive_failure_pause_threshold`(5) / `paused` / `shadow_mode`(true)
- `attachment_zone_count_default`：`/kaihatsu set`の画像添付オプション本数の既定値（暫定5。open-items #33）。ゾーンは01〜16の16区画が上限。
- `polling`：CT102ポーリング間隔（`active_interval_sec`=4 / `idle_interval_sec`=45）
- `job_retry`：`crafty_max_attempts`(5) / `crafty_retry_backoff_sec`(60) / `crafty_audit_report_hour_utc`(9) / `stale_after_sec`(300)

### 9.2 `staff.yaml`（D1 `staff`テーブルへ投入。実ファイルは`.gitignore`対象）

`workers/scripts/staff-schema.mjs`の`TAG_VOCAB`（9種、§4.4で確定済みの語彙）：

`rule_drafting` / `technical` / `participant_support` / `moderation` / `community_management` / `announcement` / `survey` / `controversial_review` / `data_handling`

staff1行のフィールド：`discord_id` / `display_name` / `active` / `tags`（TAG_VOCABのみ） / `weak_tags`（TAG_VOCABのみ・`tags`との重複禁止） / `is_technician` / `discord_permission_tier`（`admin` | `broad` | `standard`） / `requires_cosign` / `max_concurrent` / `active_hours`（`days`/`from`/`to`の配列） / `response_pattern`（`fast` | `normal` | `slow` | `deadline_driven`） / `nudge_style`（`gentle` | `standard` | `firm`） / `on_leave`（`active`/`until`） / `notes`（機械層は読まない自由記述）

---

## 10. テスト

### 10.1 Workers側（`workers/test/*.mjs`、vitest）

10ファイル、いずれも純粋関数（`domain.ts`系）のみを対象。D1・Discord API・CT102呼び出しを含む結合テストは存在しない。

`accountLinks-domain` / `assignment-domain` / `kaihatsu-domain` / `llm-prefilter` / `llm-safety` / `permissions-domain` / `settings-schema` / `staff-schema` / `tasks-deadlines` / `votes-domain`

### 10.2 CT102側（`ct/tests/*.py`、pytest）

`test_crafty`（ログパースのみ） / `test_dynmap_regions`（純粋テキスト処理） / `test_dynmap_ssh`（subprocessモック） / `test_image`（面積計算・+1補正・重複判定の中核ロジック） / `test_llm`（CLI呼び出しモック） / `test_mojang`（httpxのMockTransport） / `test_poller`（ハートビート書き込みのみ）

---

## 11. 未実装・既知のギャップ

- **`/kokka territory`・`/kokka rename`**：国家代表者ロールが未整備で実行資格を機械的に判定できないため、v1では実装しない（`docs/open-items.md` #46）。承認自体（運営の承認）は`approval_types`に維持されているが、届出は当面手動対応。
- **Dynmap自動反映**：正式承認確定時に`dynmap_sync`ジョブをenqueueする実装は完成しているが、`OPSBOT_DYNMAP_SYNC_ENABLED=false`のままで、CT104側のSSHセットアップ・疎通確認は未実施（`docs/decisions.md` #53）。
- **LLM層のドライラン**：`shadow_mode: true`のまま。最低1週間のシャドーモード運用による誤検出率の確認が未実施。
- **既存個人開発領データの移行**：`tools/migrate_claims.py`は実装済みだが、実データ（`regions.js`・画像）の提供待ちで本番投入は未実施。
- **`staff.yaml`の実運用復帰**：テスト用に`active: false`にしている運営者、テスト用サブ垢の後始末が必要（`docs/phases/phase-7-checklist.md`）。
- **`settings-schema.mjs`の`roles.unei_sub`検証漏れの疑い**：0013で追加されたロールキーがバリデータの必須チェック対象に含まれていない可能性がある（要確認）。
- **将来検討（`docs/open-items.md` §14.3）**：参加者投票の自動化、Minecraftサーバー連携（座標検証・ロールバック支援）、処罰事例のログDB化、Cloudflare無料枠超過時の課金移行判断基準は未着手。
- **運営内合意待ちの論点（`docs/open-items.md` §14.2）**：Bot投稿の告知としての効力、代表者一括申請の明文化、72h/24hの期限の妥当性、本人による紐づけ上書きの可否、脱退者の個人開発領の扱い、ホワイトリスト即時削除の是非、等。

---

## 12. 関連ドキュメント一覧

### 公開しているもの

| ファイル | 位置づけ |
|---|---|
| 本書（`docs/specification.md`） | 現在の実装仕様（技術者向け）。設計上の最重要制約 C-1〜C-7 は §0 |
| `README.md` | セットアップ手順（Phase 0〜6）・リポジトリ構成 |
| `docs/guide-staff.md` | 運営者向け運用ガイド（コマンド使用法） |
| `docs/guide-participants.md` | 参加者向け運用ガイド |

### 公開していないもの（運営内の未合意論点・環境固有の情報を含むため）

| ファイル | 位置づけ |
|---|---|
| `CLAUDE.md`・`workers/CLAUDE.md`・`ct/CLAUDE.md` | 実装時の作業規約（C-1〜C-7 の全文は本書 §0 に転記済み） |
| `docs/decisions.md` | 決定事項サマリー（実装の「なぜ」の経緯） |
| `docs/open-items.md` | 未確定事項（勝手に確定させない） |
| `docs/discord_ops_bot_requirements.md`・`docs/requirements/*.md` | 要件定義の原本（転記のまま・実装未反映） |
| `docs/phases/phase-N.md`・`phase-N-checklist.md` | フェーズごとの実装指示・実施記録 |
| `docs/appendix/*.md` | 外部システム仕様（ticket tool・画像ツール・サーバー構成） |
