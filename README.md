# OpsBot（運営タスク管理Bot）

Minecraftサーバーコミュニティ「3DS半分こするくらい仲良しクラフト」の運営業務を支援する Discord Bot。

Discord上で発生する運営タスクを台帳化して担当者を自動割当し、ルール上の申請手続（個人開発領の届出、各種許可・承認、アカウント紐づけ）をスラッシュコマンド化して受付・審査・集計・通知・督促を自動化する。

- **対象環境**：Edge層は Cloudflare Workers ＋ D1、CT層は Linux（Debian 13 で動作確認）＋ Python 3.11 以上
- **アーキテクチャ**：Discord Gateway常時接続なし（Webhook＋アウトバウンドHTTPSポーリングの2層構成）
- **主な特徴**：個人開発領のピクセル単位機械判定、運営・参加者の秘密投票・記名許可、タスク自動割当と段階的督促、LLM停止時も機能継続する縮退運転

## 目次

- [主な機能](#主な機能)
- [アーキテクチャ](#アーキテクチャ)
- [動作環境・前提](#動作環境前提)
- [コマンド一覧](#コマンド一覧)
  - [アカウント紐づけ](#アカウント紐づけ)
  - [個人開発領（/kaihatsu）](#個人開発領kaihatsu)
  - [承認投票・記名許可](#承認投票記名許可)
  - [タスク・運営者](#タスク運営者)
- [ディレクトリ構成](#ディレクトリ構成)
  - [主要モジュール](#主要モジュール)
- [セットアップ](#セットアップ)
  - [1. 事前準備（Discord・Cloudflare）](#1-事前準備discordcloudflare)
  - [2. Edge層（Workers ＋ D1）のデプロイ](#2-edge層workers--d1のデプロイ)
  - [3. 設定ファイル（staff.yaml / settings.yaml）の投入](#3-設定ファイルstaffyaml--settingsyamlの投入)
  - [4. スラッシュコマンドの登録](#4-スラッシュコマンドの登録)
  - [5. CT層（ポーリングプロセス）](#5-ct層ポーリングプロセス)
  - [6. Minecraftサーバー連携（Crafty Controller・任意）](#6-minecraftサーバー連携crafty-controller任意)
  - [7. Dynmap への自動反映（任意）](#7-dynmap-への自動反映任意)
  - [8. LLM層（任意・シャドーモード）](#8-llm層任意シャドーモード)
  - [9. 監視（任意）](#9-監視任意)
  - [10. 既存データの移行（既存環境からの引き継ぎ時のみ）](#10-既存データの移行既存環境からの引き継ぎ時のみ)
- [動作確認](#動作確認)
- [開発](#開発)
  - [前提環境](#前提環境)
  - [コマンド](#コマンド)
  - [開発上の原則](#開発上の原則)
- [運用](#運用)
  - [自動デプロイ（GitHub の deploy ブランチ）](#自動デプロイgithub-の-deploy-ブランチ)
  - [CT層の定期メンテナンス時間帯の自動停止](#ct層の定期メンテナンス時間帯の自動停止)
  - [トラブルシューティング](#トラブルシューティング)
- [ドキュメント](#ドキュメント)
- [ライセンス](#ライセンス)
- [免責事項](#免責事項)

## 主な機能

| 機能 | 概要 |
|---|---|
| アカウント紐づけ | Discord アカウントと Minecraft アカウント（主キーは UUID）を相互に紐づけ、成功時にホワイトリストへ自動追加。脱退・ロール喪失を定期差分検知して自動削除 |
| 個人開発領の届出 | 1px=1ブロックのゾーン画像で範囲を宣言し、面積・重複・保護区域を**ピクセル単位で機械判定**して即時承認／却下。代表者による一括申請は仮承認＋本人確認、譲渡は同時処理グループで原子的に処理 |
| 承認・許可 | 運営の秘密投票（`/modvote`）・参加者の秘密投票（`/vote`）・記名許可（`/kyoka`・`/umetate`）を、性質の異なる別モジュールとして実装。24時間自動締切、母数はDiscordの実ロールから算出 |
| タスク管理 | タスク台帳、運営者プロファイル（得意分野・権限・稼働時間帯）に基づく自動割当、共同確認制度、段階的督促（DM→メンション→全体共有→自動再割当）、ダッシュボードの定期更新 |
| LLM層 | 「機械的に判定できない検出」のみに限定して Claude Code CLI を呼ぶ。**停止しても他の全機能は動作を継続する**（縮退運転） |

判断そのもの（承認する／しないの決定）は Bot が代行しない。Bot が行うのは受付・形式審査・集計・通知・記録のみ。

## アーキテクチャ

**Discord への Gateway 常時接続を持たない2層構成**：

- **Edge層** — Cloudflare Workers ＋ D1 ＋ Cron Triggers。Interactions Webhook でコマンドを受け、台帳・投票・許可・督促・ダッシュボードをすべてここで完結させる。
- **CT層** — Proxmox LXC 等の Linux ホスト上の Python プロセス。Workers へアウトバウンド HTTPS でポーリングし、Edge では実行できない処理（画像のピクセル演算、Minecraftサーバー連携、LLM呼び出し）を担う。**Edge から CT への通信経路は存在しない**（プル方式）。

```
Discord ──(Interactions Webhook)──> Cloudflare Workers ──> D1
                                            ^
                                            │ HTTPSポーリング（プル方式）
                                            │
                                        CT層 (Python, poller.py)
                                            │
                    ┌───────────────────────┼───────────────────────┐
                    │                       │                       │
            Crafty Controller API   制限付きSSH(強制コマンド)   Claude Code CLI
            （ホワイトリスト操作）    → Dynmap配信ホスト          （headless）
```

Cron Triggers は5本。Cloudflare 無料枠の上限に収めるため、複数のバッチ処理を相乗りさせている。

| cron式 | 実行内容 |
|---|---|
| `*/5 * * * *` | `job_queue` の滞留検知 |
| `0 * * * *` | 脱退・ロール喪失の差分検知 |
| `0 9 * * *` | 日次ホワイトリスト突合 |
| `*/10 * * * *` | 投票の締切処理 ＋ 保留タスクの自動復帰 ＋ 投票締切3時間前リマインド |
| `*/15 * * * *` | 仮承認・グループの72h期限切れ ＋ 督促エスカレーション ＋ ダッシュボード更新 ＋ ticket監視 ＋ LLMメッセージスキャン |

締切・撤回猶予等の期限判定はすべて D1 に保存した絶対時刻（UTC ISO8601）で行い、Cron の発火間隔には依存しない。そのため締切処理には最大10分の遅延が生じ得る（仕様どおりの挙動）。

## 動作環境・前提

| 区分 | 必要なもの | 備考 |
|---|---|---|
| Edge層 | Cloudflare アカウント（Workers ＋ D1） | 無料枠で動作する。**Cron Triggers はアカウント全体で5件が上限**で、本Botはその5件すべてを使う |
| Discord | Bot アプリケーション（Application ID・Bot Token・Public Key） | **GUILD_MEMBERS 特権インテントの有効化が必須**（脱退検知・母数算出に使用） |
| CT層 | Linux ホスト（Debian 13 で動作確認）、Python 3.11 以上 | 常時稼働。アウトバウンド HTTPS のみ使用し、インバウンドの待受は一切持たない |
| 開発機 | Node.js 22 以上（Wrangler 実行用） | セットアップ・デプロイに使用 |
| Minecraft連携（任意） | Crafty Controller 4.10.4（v2 API） | ホワイトリスト操作に使用。無くても他機能は動作する |
| 地図反映（任意） | Dynmap ＋ カスタムオーバーレイJS を配信するホスト | 個人開発領の地図反映に使用。無効のままでも運用可能 |
| LLM層（任意） | Claude Code CLI（CT層のホストにインストール・ログイン済み） | 無くても他の全機能は動作する |
| 監視（任意） | Prometheus / Grafana | node-exporter の textfile collector 経由で死活を取る |

Discord 側には、Bot 専用ロールと、参加者を表す各ロール（「運営」「人民」「仮参加者」「サブ垢」等）が必要。ロール名は固定されておらず、**IDを `settings.yaml` に記入して参照する**（ハードコードしない）。

## コマンド一覧

### アカウント紐づけ

| コマンド | 内容 | 実行資格 |
|---|---|---|
| `/authorise mcuser:<name>` | 自分のMinecraftユーザー名をDiscordアカウントに紐づける。成功時ホワイトリストに自動追加される | 人民ロールまたは仮参加者ロール（サブ垢ロールのみは不可） |
| `/modauth link discord:<user> mcuser:<name>` | 運営者が他者の紐づけを登録・変更する。既存の紐づけと競合する場合は確認ボタンでの上書き確認を挟む | 運営者ロール |
| `/modauth remove discord:<user>` | 紐づけを解除する（ホワイトリストからも削除） | 運営者ロール |
| `/whoami` | 自分の紐づけ状況を確認する（自分にのみ表示） | 誰でも |

### 個人開発領（/kaihatsu）

| コマンド | 内容 | 実行資格 |
|---|---|---|
| `/kaihatsu set image1:<file> [image2..16] [group:<id>]` | 個人開発領の設定・変更を届け出る（宣言型）。自分の画像のみなら即時承認・却下（撤回ボタン付き）。他者の画像を含む場合は代表者一括申請として仮承認＋本人への72時間確認DMを送る。`group` 指定時は評価を開始せず受付のみ行う | `/authorise` 済みの参加者。代表者一括申請・グループの場合、ファイル名のプレイヤーが全員 `/authorise` 済みであること |
| `/kaihatsu delete [mcuser:<name>] [group:<id>]` | 個人開発領の全部削除を届け出る（復元不可）。自分自身かつ group 未指定なら即時削除。他者を対象とする場合は必ず `group` を伴わせ、対象者本人の72時間確認を要する | 本人（自分自身の即時削除）、または代表者（group を介した他者 delete） |
| `/kaihatsu group_finalize group:<id>` | 同時処理グループの受付を締め切り、判定処理（delete先行評価→set評価→全員への本人確認DM送信）を開始する | グループを最初に作成した代表者のみ |
| `/kaihatsu list` | 自分の個人開発領の登録状況（面積・座標）を確認する | 誰でも |

**撤回**：`/kaihatsu set` の承認投稿には撤回ボタンが付き、承認から24時間以内であれば運営者が理由を入力（モーダル）した上で撤回できる。撤回すると当該claimの効力が止まり、手動審査タスクが起票される。

**申請は宣言型**：`set` で送った画像がその参加者の全範囲を表す。**含まれていない従前の範囲は削除扱いになる**（削除された範囲は復元されない）。確認画像で削除される範囲が強調表示されるので、確定前に必ず確認すること。

### 承認投票・記名許可

> **`/modvote` と `/vote` の違い**：`/modvote` は**運営の承認**（母数＝「運営」ロール保有者から休暇中の者を除いた人数）、`/vote` は**参加者投票**（母数＝「人民」ロール保有者）。両者は母数の算出も承認事項の分類表も別で、投稿先チャンネルも分かれている（`settings.channels.vote_hall` / `participant_vote_hall`）。どちらも投票の開始・終了の実行資格は運営者ロール。

| コマンド | 内容 | 実行資格 |
|---|---|---|
| `/modvote start approval_key:<事項> subject:<件名> [target:<user>]` | 運営の秘密投票（類型A）を開始する。24時間で自動締切、締切までの未投票は棄権扱い | 運営者ロール |
| `/modvote quick approval_key:<事項> subject:<件名> [target:<user>]` | 短縮投票を開始する。母数計算は通常投票と別ロジック（明示的棄権者を除く運営者総数の過半数）。**同時会議で全運営者が短縮投票の実施に同意していることが開始条件**（Botはこの前提を機械的に検証できないため、開始者が確認した上で実行すること） | 運営者ロール |
| `/modvote status [vote_id:<id>]` | 運営投票の状況を確認する（省略時は進行中の投票を一覧表示。`vote_id` は入力中に件名で候補表示） | 誰でも |
| `/modvote end vote_id:<id>` | 運営投票を期限前に終了し、即座に集計・結果投稿する。急を要する案件や、締切前に全員の投票が出揃った場合を想定。1人の実行で即終了する | 運営者ロール |
| `/modvote hogokuiki_build area_name:<名称> [description] [area_image:<file>]` | 特定保護区域内の建築・採掘の承認要請。内部的に `/modvote start` と同じ秘密投票の経路に乗る | 運営者ロール |
| `/vote start approval_key:<事項> subject:<件名>` | **参加者投票**（秘密投票）を開始する。24時間で自動締切。短縮投票（`quick`）は存在しない | 運営者ロール |
| `/vote status [vote_id:<id>]` | 参加者投票の状況を確認する | 誰でも |
| `/vote end vote_id:<id>` | 参加者投票を期限前に終了し、即座に集計・結果投稿する | 運営者ロール |
| `/kyoka kind:<事項> subject:<件名> [description]` | 記名許可要請を作成する（類型B）。押下者名・押下時刻は公開・永久記録される | 運営者ロール（作成）。OK/NGボタンの押下も運営者ロールが必要 |
| `/umetate [image:<file>] [description]` | 海の埋立ての許可要請。image・description のいずれか必須。「運営」ロール保有者2人以上のOKで成立 | 誰でも（作成）。OK/NGボタンの押下は運営者ロールが必要 |

**秘密投票の秘匿性**：`/modvote`・`/vote` の賛否ボタンは ephemeral 応答とし、他の投票者からは見えない。締切・集計後は個票（`vote_ballots`）を破棄する。「誰が投票したか」の事実のみ棄権みなし判定のため D1 に残るが、選択内容（賛成／反対）自体は監査ログにも記録しない。

### タスク・運営者

| コマンド | 内容 | 実行資格 |
|---|---|---|
| `/task add title:<タイトル> [summary] [assignee] [priority] [required_tags] [requires_technician] [required_permission_tier] [controversial] [estimated_load]` | タスクを登録する。`assignee` 省略時は割当アルゴリズムで自動割当する。`controversial:true` 等の場合は共同確認者も自動追加される | 運営者ロール |
| `/task done task_id:<id> evidence:<根拠>` | タスクを完了にする。根拠（メッセージリンク等）の記入が必須。共同確認者が設定されているタスクは担当者・共同確認者の双方の完了操作で初めて完了になる | 運営者ロール（共同確認タスクは担当者・共同確認者本人のみ） |
| `/task decline task_id:<id>` | 自分に割り当てられたタスクを辞退する（理由不要）。割当アルゴリズムで次点の運営者へ自動再割当する。候補がなければ運営チャンネルに手動対応を依頼 | 現在の担当者本人 |
| `/task hold task_id:<id> resume_at:<YYYY-MM-DD> [reason]` | 自分に割り当てられたタスクを保留にする。再開予定日到来時に Cron で自動的に割当済へ戻る | 現在の担当者本人 |
| `/task list` | 自分に残っているタスクと期限を確認する（本人にのみ表示） | 運営者ロール |
| `/staff leave action:start until:<YYYY-MM-DD>` / `action:end` | 自分の休暇を登録・解除する。休暇中は運営投票・記名許可の母数から除外される | 運営者ロール（自分自身のみ対象） |
| `/subaccount link discord:<user>` | サブ垢に本人確認DMを送り、承認されればメイン垢として連携する。以後サブ垢から実行された運営コマンドはメイン垢が行ったものとして扱う（投票の一票・記名許可の署名を含む） | 運営者ロール（メイン垢からのみ） |
| `/subaccount unlink discord:<user>` | サブ垢の連携を解除する | 運営者ロール（メイン垢からのみ） |
| `/subaccount list` | 自分のメイン垢に連携中のサブ垢の一覧を表示する | 運営者ロール |
| `/ops cost` | LLM利用枠（`llm_usage`）の消費状況を確認する | 運営者ロール |
| `/ops log [limit] [actor]` | 監査ログ（`audit_log`）を確認する | 運営者ロール |
| `/ops dashboard action:<update\|repost>` | ダッシュボードを即時更新、または運営ダッシュボードを新規投稿し直す | 運営者ロール |
| `/ops llm [action:<status\|pause\|resume>]` | LLM層の状態確認・一時停止・再開を行う（縮退運転）。省略時は状態確認のみ | 運営者ロール |

`/modauth` は Discord API の制約（サブコマンドと通常オプションを同一コマンドに混在できない）により、`link` サブコマンドとして実装している。

## ディレクトリ構成

```
.
├── workers/                  # Edge層：Cloudflare Workers (TypeScript) ＋ D1 ＋ Cron
│   ├── migrations/           # D1 スキーマ定義
│   ├── scripts/              # 設定投入・検証・コマンド登録スクリプト
│   └── src/                  # 実装コード（コマンド、ドメイン、Cron、通知）
├── ct/                       # CT層：Python プロセス（ポーリング、画像演算、Minecraft連携）
│   ├── opsbot_ct/            # CT層実装パッケージ
│   └── deploy/               # systemd サービス定義、環境変数ひな形、デプロイスクリプト
├── tools/                    # データ移行ツール（claims 移行等）
├── docs/                     # 詳細ドキュメント（技術仕様書、運営・参加者ガイド）
├── staff.example.yaml        # 運営者プロファイルのひな形
├── settings.example.yaml     # D1 settings テーブルのひな形
└── LICENSE
```

### 主要モジュール

| パス | 内容 |
|---|---|
| `workers/src/index.ts` | エントリポイント。`/health`・`/interactions`・`/ct/jobs/poll`・`/ct/jobs/complete` と Cron ハンドラ |
| `workers/src/accountLinks/` | `/authorise` `/modauth` `/whoami` の判定ロジック・D1リポジトリ |
| `workers/src/kaihatsu/` | `/kaihatsu` 各サブコマンドの判定ロジック・D1リポジトリ・通知文面 |
| `workers/src/kaihatsu/phase3.ts` | 仮承認・正式承認確定・保留解放の共通オーケストレーション |
| `workers/src/kaihatsu/groupResolution.ts` | 同時処理グループの原子性判定・確定処理 |
| `workers/src/kaihatsu/confirmCommand.ts` | 本人確認ボタン（確認する／取り下げる）ハンドラ |
| `workers/src/kaihatsu/revokeCommand.ts` | 運営による撤回ボタン・理由入力モーダル |
| `workers/src/votes/modvoteCommand.ts` | `/modvote start`/`quick`/`status`/`end`/`hogokuiki_build` |
| `workers/src/votes/participantVoteCommand.ts` | `/vote start`/`status`/`end`（参加者投票） |
| `workers/src/votes/voteShared.ts` | 両投票コマンドが共有する開始・集計・結果投稿の経路 |
| `workers/src/votes/domain.ts` | 票の集計（過半数・特別多数・本人除外の全会一致）・母数算出の純粋関数 |
| `workers/src/votes/eligibility.ts` | 母数の算出：運営投票は「運営」ロール保有者から休暇者を除外、参加者投票は「人民」ロール保有者 |
| `workers/src/permissions/` | `/kyoka`・`/umetate` の判定ロジック・D1リポジトリ・通知文面（記名許可・類型B） |
| `workers/src/tasks/` | `/task` 各サブコマンドの状態遷移 |
| `workers/src/tasks/assignment.ts` | 割当アルゴリズムのスコアリング・ハード条件・稼働時間帯判定（純粋関数） |
| `workers/src/tasks/autoAssign.ts` | 割当アルゴリズムのオーケストレーション |
| `workers/src/tasks/deadlines.ts` | Bot既定の目標期限の算出 |
| `workers/src/tasks/templates.ts` | タスク関連の通知文面（督促・自動割当・再割当・保留復帰・投票リマインド） |
| `workers/src/staff/` | staffテーブル読み出し・統計値、`/staff leave`、`/subaccount`、タグ語彙 |
| `workers/src/dashboard/` | ダッシュボード表示内容の組み立て（純粋関数）・固定メッセージ参照先の保存 |
| `workers/src/ops/opsCommand.ts` | `/ops cost`・`log`・`dashboard`・`llm` |
| `workers/src/cron/` | 各 Cron ハンドラ（締切・督促・保留復帰・投票リマインド・ダッシュボード・差分検知・突合・滞留検知） |
| `workers/src/llm/prefilter.ts` | 前処理フィルタ（純粋関数） |
| `workers/src/llm/safety.ts` | LLM出力の安全フィルタ（純粋関数。評価の推察可能な文言・マイナス評価の混入を機械的に破棄） |
| `workers/src/llm/ticketScan.ts` | ticketチャンネルの監視対象自動登録・クローズ検知 |
| `workers/src/llm/messageScan.ts` | メッセージ差分取得＋前処理フィルタ＋LLM検出ジョブの積み込み |
| `workers/src/llm/detectionCompletion.ts` | 検出結果の記録・割当プレビュー・開発者DM通知・連続失敗時の自動一時停止 |
| `ct/opsbot_ct/poller.py` | ジョブキューのポーリング取得（プル方式）・ハートビート出力 |
| `ct/opsbot_ct/image.py` | 個人開発領の画像処理・形式審査ライブラリ |
| `ct/opsbot_ct/crafty.py` | Crafty Controller REST API クライアント（ホワイトリスト操作・証明書ピン留め） |
| `ct/opsbot_ct/mojang.py` | Mojang API によるユーザー名⇄UUID解決 |
| `ct/opsbot_ct/llm.py` | Claude Code CLI の headless 呼び出し・プロンプト構築・出力JSON整形 |
| `ct/opsbot_ct/dynmap_regions.py` | カスタムオーバーレイJSの `regions` 配列のテキスト更新（純粋関数） |
| `ct/opsbot_ct/dynmap_ssh.py` | 配信ホストへの制限付きSSHクライアント |
| `ct/opsbot_ct/dynmap_sync.py` | Dynmap反映の全体オーケストレーション |
| `tools/migrate_claims.py` | 既存カスタムオーバーレイからの移行ツール |

## セットアップ

新規に構築する場合は 1 から順に実施する。1〜5 は必須、6〜9 は任意（未実施でも他の機能は動作する）、10 は既存環境からの引き継ぎ時のみ実施する。

### 1. 事前準備（Discord・Cloudflare）

- Discord Developer Portal で Bot アプリケーションを作成し、**GUILD_MEMBERS 特権インテントを有効化**する。Application ID・Bot Token・Public Key を控える。
- Bot 専用ロールを作成してサーバーに招待する（運営者ロールは付与しない）。
- 「運営」「人民」「仮参加者」「サブ垢」等のロール、および Bot が投稿する各チャンネル（個人開発領・諸国法・会議場フォーラム・運営専用・投票場・参加者投票場・申請受付状況・通知先）を用意し、それぞれの **ID を控える**。
- Cloudflare アカウントを用意する。

### 2. Edge層（Workers ＋ D1）のデプロイ

```powershell
cd workers
npm install
npm run typecheck
npm test                     # 単体テスト（集計・割当・期限判定などの純粋関数）

# D1 データベース作成 → 出力された database_id を wrangler.jsonc に貼る
npm run db:create
npm run db:migrate:remote    # migrations/ 配下を順に適用（未適用分をすべて）

# シークレット登録
npx wrangler secret put DISCORD_PUBLIC_KEY   # Interactions 署名検証用（Ed25519 公開鍵, hex）
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put DISCORD_APP_ID
npx wrangler secret put CT_SHARED_SECRET     # 長いランダム文字列を自分で生成する（CT層と同値）

npm run deploy
npx wrangler deployments list   # crons が5件反映されていることを確認
```

- `https://opsbot.<subdomain>.workers.dev/health` が `{"ok":true}` を返すことを確認する。
- **その URL に `/interactions` を付けたものを、Discord の "Interactions Endpoint URL" に設定する。**
- シークレットは `wrangler secret` にのみ登録する。`wrangler.jsonc` にもソースにも書かない。

### 3. 設定ファイル（staff.yaml / settings.yaml）の投入

D1 の `settings` テーブルには初期マイグレーションでプレースホルダ値が入っている。実際のIDや期限値は YAML に記入して UPSERT する。**この2ファイルは実IDと個人情報を含むため `.gitignore` 済み。**

```powershell
copy staff.example.yaml staff.yaml
copy settings.example.yaml settings.yaml
# 両方を編集（IDは "文字列" で記入。settings.yaml で記入しなかったキーは投入対象から外れる）

cd workers
npm run staff:validate                           # 検証
npm run staff:seed > ..\staff-seed.sql
npx wrangler d1 execute opsbot --remote --file ..\staff-seed.sql

npm run settings:validate                        # 検証（Snowflake 桁数・正規表現・期限値の型）
npm run settings:seed > ..\settings-seed.sql
npx wrangler d1 execute opsbot --remote --file ..\settings-seed.sql

npx wrangler d1 execute opsbot --remote --command "SELECT key, value FROM settings"   # 確認
```

`settings.yaml` の主なキー（すべて `settings.example.yaml` に記入欄とコメントがある）：

| キー | 内容 |
|---|---|
| `discord_guild_id` / `channels` / `roles` | ギルドID・各チャンネルID・各ロールID |
| `ticket_tool` | ticket tool のカテゴリID・チャンネル名パターン・スキャン間隔 |
| `deadlines` | 投票24h・本人確認72h・撤回猶予24h・短縮投票15分 等 |
| `approval_types` / `participant_approval_types` | 承認事項の分類表。**運営投票用と参加者投票用でテーブルが別**。事項ごとに `method`（A=秘密投票／B=記名許可）・`quorum_type`・`threshold`・`exclude_self`・`required_count` を持つ |
| `assignment_weights` / `task_target_days` | 割当アルゴリズムの重み・閾値、Bot既定の目標日数 |
| `nudge` | 督促の段階（Lv1:24h後DM → Lv2:72h後メンション → Lv3:120h後全体共有 → Lv4:168h後自動再割当）と静穏時間 |
| `llm` | LLM層の設定（後述） |
| `job_retry` / `account_link` / `polling` | 再試行上限、日次突合レポート時刻、ポーリング間隔 |
| `attachment_zone_count_default` | `/kaihatsu set` の添付オプション本数の既定値 |

**後から一部の値だけ変えたいとき**（期限の調整など）は、そのキーだけを `settings.yaml` に残して validate → seed → 投入を再実行すればよい。記入しなかったキーは触られない。

分類表に事項を追加する場合、`settings.yaml` への追記だけでなく **コマンドの選択肢（`workers/scripts/register-commands.mjs` の `APPROVAL_KEY_CHOICES_A` / `_B` / `APPROVAL_KEY_CHOICES_PARTICIPANT`）にも追記してコマンド再登録が必要**（固定選択肢のため）。

### 4. スラッシュコマンドの登録

```powershell
cd workers
$env:DISCORD_APP_ID="<Application ID>"
$env:DISCORD_BOT_TOKEN="<Bot Token>"
npm run commands:register           # グローバル登録（反映まで最大1時間）

# 開発中は即時反映されるギルド限定登録が便利：
# $env:DISCORD_GUILD_ID="<Guild ID>"; npm run commands:register:guild
```

コマンド定義（サブコマンド・オプション・選択肢）を変更したときは、その都度この再登録が必要。再登録すると、定義から削除されたコマンドは Discord 側からも自動的に消える。グローバル登録をまとめて取り消したい場合は `npm run commands:unregister:global` を使う。

撤回理由の入力などに Discord の**モーダル**を使うため、Interactions Endpoint が MODAL（type=9）応答と MODAL_SUBMIT interaction を扱えることを確認する（Bot Permissions の追加は不要。応答種別の話）。

### 5. CT層（ポーリングプロセス）

対象ホスト上で：

```bash
sudo useradd -r -s /usr/sbin/nologin opsbot
sudo mkdir -p /opt/opsbot /etc/opsbot
sudo rsync -a ct/ /opt/opsbot/ct/            # またはリポジトリを clone
cd /opt/opsbot/ct
python3 -m venv .venv && .venv/bin/pip install -e .

# 個人開発領のマスク画像の保存先
sudo mkdir -p /var/lib/opsbot/masks
sudo chown opsbot:opsbot /var/lib/opsbot/masks

sudo cp deploy/ct.env.example /etc/opsbot/ct.env
sudo chmod 600 /etc/opsbot/ct.env
# /etc/opsbot/ct.env を編集する。最低限、次の2つを設定すれば起動する：
#   OPSBOT_WORKERS_BASE_URL  … デプロイした Workers の URL
#   OPSBOT_CT_SHARED_SECRET  … Workers の CT_SHARED_SECRET と同値

sudo cp deploy/opsbot-ct-poller.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now opsbot-ct-poller
sudo systemctl status opsbot-ct-poller       # active、ログにポーリング成功が出ること
```

`/etc/opsbot/ct.env` の全項目は [`ct/deploy/ct.env.example`](ct/deploy/ct.env.example) にコメント付きで列挙してある。**このファイルは秘密情報を含むため CT ホストの外に出さない**（`chmod 600` / owner `opsbot`）。以降の手順で項目を追記したら、その都度 `sudo systemctl restart opsbot-ct-poller` で反映する。

### 6. Minecraftサーバー連携（Crafty Controller・任意）

ホワイトリストの自動追加・削除に使う。設定しない場合、紐づけ自体は成立するがホワイトリスト操作は行われない。

- Crafty のアカウント設定 > **API Tokens** で、Bot専用ユーザーの非ログイン静的トークンを発行する（`/auth/login` によるパスワードログインは使わない）。ユーザーには最小権限のみを与える。
- 対象サーバーの Server ID（UUID。`GET /api/v2/servers` または管理UIのURLで確認）を控える。
- 自己署名証明書の SHA-256 フィンガープリントを控える（**TLS 検証は無効化せず、ピン留めする**）。
- `/etc/opsbot/ct.env` に追記：

  ```
  OPSBOT_CRAFTY_BASE_URL=https://<crafty-host>:8443
  OPSBOT_CRAFTY_API_TOKEN=<発行したトークン>
  OPSBOT_CRAFTY_SERVER_ID=<Server ID>
  OPSBOT_CRAFTY_CERT_FINGERPRINT_SHA256=<フィンガープリント>
  ```

- 再起動後、起動ログに「Crafty証明書ピン留め確認に失敗」が出ないこと。フィンガープリント不一致・未到達の場合は Crafty 連携が自動的に無効化される（他機能は継続）。

### 7. Dynmap への自動反映（任意）

個人開発領の承認確定時に、配信ホスト上の画像とカスタムオーバーレイJSの `regions` 配列を自動更新する。

**方式**：配信ホストへの**制限付きSSH**（強制コマンド）。Crafty の File Manager API は、読み取り用エンドポイントが公式ドキュメントに記載のない非公開実装であること、および API トークンの FILES 権限が対象サーバーの全ファイルに及び最小権限の原則に反することから採用していない。

配信ホスト側には [`ct/deploy/dynmap_deploy.sh`](ct/deploy/dynmap_deploy.sh) を配置し、専用ユーザーの `authorized_keys` に `command=` 付きで登録する（スクリプト冒頭に手順がある）。これにより CT層から実行できる操作は「配信ディレクトリへの画像配置・regions.js 更新」のみに限定され、Minecraft サーバープロセスには触れない。配信先のディレクトリは環境ごとに異なるため、スクリプトには書かず `/etc/opsbot/dynmap_deploy.conf` に置く（[`ct/deploy/dynmap_deploy.conf.example`](ct/deploy/dynmap_deploy.conf.example)）。配置後のスクリプト更新は [自動デプロイ](#自動デプロイgithub-の-deploy-ブランチ) で行う。

```bash
# CT層側：SSH鍵ペアを生成（秘密鍵はこのホストの外に出さない）
ssh-keygen -t ed25519 -f /etc/opsbot/dynmap_ssh_id_ed25519 -N "" -C opsbot-ct
# 公開鍵を配信ホストの opsbot-dynmap ユーザーの authorized_keys へ強制コマンド付きで登録する
ssh-keyscan -p 22 <配信ホスト> > /etc/opsbot/dynmap_known_hosts   # ホスト鍵を事前登録
```

`/etc/opsbot/ct.env` に追記：

```
OPSBOT_DYNMAP_WEB_RELATIVE_DIR=plugins/dynmap/web
OPSBOT_DYNMAP_IMAGES_SUBDIR=images/indiv
OPSBOT_DYNMAP_OVERLAY_JS_PATH=js/custom_overlay.js
OPSBOT_DYNMAP_SSH_HOST=<配信ホスト>
OPSBOT_DYNMAP_SSH_USER=opsbot-dynmap
OPSBOT_DYNMAP_SSH_IDENTITY_FILE=/etc/opsbot/dynmap_ssh_id_ed25519
OPSBOT_DYNMAP_SSH_KNOWN_HOSTS_FILE=/etc/opsbot/dynmap_known_hosts
OPSBOT_DYNMAP_SYNC_ENABLED=false   # まずは false のまま疎通確認する
```

`ssh -i /etc/opsbot/dynmap_ssh_id_ed25519 opsbot-dynmap@<配信ホスト> read-regions` が通ることを確認してから `OPSBOT_DYNMAP_SYNC_ENABLED=true` にして再起動する。

`false` の間は `dynmap_sync` ジョブは**黙ってスキップされる**（失敗扱いにはならず、タスクも起票されない）。Dynmap への反映は運営の手動作業のままになるため、配置ディレクトリを手動で確認すること。

### 8. LLM層（任意・シャドーモード）

`settings.llm` と Claude Code CLI の両方を設定したときのみ動作する。**未設定でも他の全機能は動作する。**

`SHADOW_MODE`（`wrangler.jsonc` の `vars`）が `true` の間は、検出・割当のロジックは動くが結果は**開発者への DM 通知にのみ**送られる。運営専用チャンネル・参加者・担当予定の運営者本人には一切通知しない。

CT層のホストで、ポーリングを動かす OS ユーザー自身でログインする（認証情報の保管をこのホストに限定するため）：

```bash
sudo -u opsbot claude login
# ブラウザでの認証完了後、opsbot ユーザーのホーム配下にセッション情報が保存されることを確認
```

`/etc/opsbot/ct.env` に追記：

```
OPSBOT_ANTHROPIC_CLI_PATH=claude
OPSBOT_ANTHROPIC_MODEL=claude-sonnet-5-5
OPSBOT_CLAUDE_TIMEOUT_SEC=120
OPSBOT_RULES_DIR=            # 根拠条文の抜粋に使うMarkdownディレクトリ。未設定でも動作する
```

`settings.yaml` の `llm` キー：

| フィールド | 内容 |
|---|---|
| `developer_discord_id` | シャドーモードの検出結果DMの送り先。**プレースホルダのままでは通知が届かないため必ず実IDに書き換える** |
| `confidence_threshold` | これ未満は「候補」扱いとして割当プレビューを行わず記録のみ |
| `max_tokens` | LLM出力の目標トークン数上限（プロンプト内の指示として使う） |
| `coarse_filter_patterns` | 通常監視チャンネル用のキーワード正規表現。空なら文字数のみで判定 |
| `scan_interval_sec` | メッセージ差分取得の間隔（既定30分）。新規 cron は追加せず、15分ごとの発火に乗せて内部で間引いている |
| `consecutive_failure_pause_threshold` | LLM呼び出しがこの回数連続で失敗すると自動的に一時停止する |
| `paused` | 手動一時停止フラグ（`/ops llm action:pause` / `resume` で切り替え） |

`ticket_tool.ticket_keyword_filter_threshold` は ticket チャンネル専用の最低文字数として使う（`null` なら `llm.min_message_chars` と同じ値になる）。

**本稼働へ切り替える前に**、最低1週間はシャドーモードで運用し、開発者DMに届く検出結果と実際にチャンネルで起きていた出来事を突き合わせて誤検出率を確認すること。

### 9. 監視（任意）

CT層への node-exporter 導入と textfile collector（`opsbot_ct.prom`）の設定、blackbox_http による Workers の `/health` 死活監視、Grafana アラートの追加を行う。出力先は `OPSBOT_HEARTBEAT_PATH`（既定 `/var/lib/node_exporter/textfile_collector/opsbot_ct.prom`）。

### 10. 既存データの移行（既存環境からの引き継ぎ時のみ）

> 新規に立ち上げる環境では**不要**。既に Dynmap のカスタムオーバーレイで個人開発領を運用している環境から引き継ぐ場合のみ実施する。

既存のカスタムオーバーレイJS（`regions` 配列）と `images/indiv/` フォルダを用意し、**本稼働（`/kaihatsu set` の受付開始）前に**実行する：

```bash
# Mojang API へ直接到達できる環境で実行すること（Cloudflare Workers からは403で拒否される）
python tools/migrate_claims.py \
  --regions-js path/to/custom_overlay.js \
  --images-dir path/to/images/indiv \
  --masks-dir ./migrated_masks \
  --out claims-seed.sql

# 1) migrated_masks/ の中身を CT層の /var/lib/opsbot/masks へコピー
# 2) claims-seed.sql を D1 へ投入
npx wrangler d1 execute opsbot --remote --file claims-seed.sql
```

移行を怠ったまま本稼働すると、既存の個人開発領と重複する新規申請を誤って承認してしまう（重複判定が既存データを認識できないため）。

既存のアカウント紐づけについても、運営者が `/modauth link discord:<user> mcuser:<name>` で一括登録する運用を想定している（新規参加者は以後 `/authorise` を各自で実行する）。

**特定保護区域**は `protected_areas` が0件でも動作し、その場合は保護区域の判定条件が常に通過する。データが用意でき次第、CT層の masks_dir にマスク画像を配置して `protected_areas` テーブルへ `INSERT`（name・mask_ref・bbox_loc1・bbox_loc2）すれば、コード変更なしに判定が有効になる。

## 動作確認

セットアップ後、次の順で確認する。任意機能を導入していない場合、その項目は飛ばす。

**アカウント紐づけ**
- `/whoami` が未紐づけ状態で応答する
- `/authorise mcuser:<有効なMinecraft名>` で紐づき、CT層のログに `whitelist add` 実行ログが出る
- `SELECT * FROM account_links` で反映を確認する
- 運営専用チャンネルに日次ホワイトリスト突合が届く（差分がある場合のみ投稿）

**個人開発領**
- `/kaihatsu set image1:<5000x5000のPNG>` で受付され、専用チャンネルに承認または却下の投稿と確認画像が届く
- `/kaihatsu list` で登録状況が表示され、`/kaihatsu delete` 後は「登録されていません」となる
- わざと他人の範囲と重なる画像を送ると重複で却下され、相手のMinecraft名が示される
- **撤回**：承認投稿の撤回ボタン → モーダルで理由入力 → 撤回され、申請者にDMが届き、手動審査タスクが起票される
- **代表者一括申請**：他者の画像を含む `set` → 対象者に本人確認DM（確認する／取り下げる）が届く。「確認する」で正式承認、「取り下げる」または72時間放置で却下（Cron 15分ごと）
- **同時処理グループ**：`delete ... group:X` ＋ `set group:X` の後に `group_finalize group:X` → 全員に確認DMが届き、全員の確認で同時に確定、1人でも取り下げるとグループ全体が却下される
- **保留と自動再審査**：仮承認中の範囲と重複する届出は却下されず保留され、先行の仮承認が却下／期限切れになった時点で自動的に再審査される
- **Dynmap反映**（`OPSBOT_DYNMAP_SYNC_ENABLED=true` の場合）：承認確定後に配信ディレクトリへ画像が配置され、`custom_overlay.js` の `regions` にエントリが追加・更新される。削除確定後は取り除かれる

**投票・許可**
- `/modvote start approval_key:punishment_decision subject:テスト` で秘密投票が開始され、投票場チャンネルに投稿される。賛否ボタンを押すと ephemeral 応答のみが返り、他の運営者には見えない
- `settings.deadlines.vote_hours` を一時的に短縮してテストし、締切到来後に `/modvote status` で結果が表示される。締切時に結果が投稿され、`SELECT * FROM vote_ballots WHERE vote_id=<id>` が0件になる
- `/modvote end vote_id:<id>` で締切前でも即座に締め切られ、結果に「締切前に終了されました」の注記が付く。締切済みの投票IDに対して実行すると却下される
- `/staff leave action:start until:2099-01-01` を実行した本人が母数から除外される
- `/kyoka kind:technician_beneficial_command subject:テスト` で、運営者が2人OKを押しても成立せず（`required_count:3`）、3人目で成立してDMが届く。押下者名・時刻が投稿に表示され続ける
- `/umetate description:テスト範囲` で要請が作成でき、image・description 両方省略すると却下される
- `/modvote hogokuiki_build area_name:テスト区域` が秘密投票として開始される

**タスク・督促**
- `/task add title:テスト`（`assignee` 省略）で自動割当されDMが届く。ハード条件を満たす者がいない場合は運営専用チャンネルに「要手動対応」の通知が届く
- `controversial:true` で作成すると共同確認者が自動追加され、片方のみの `/task done` では完了しない
- `/task decline` で次点の運営者へ自動再割当される。担当者以外が実行すると拒否される
- `/task hold` で保留にしたタスクが再開予定日到来時（Cron発火後 **最大10分**以内）に自動的に割当済へ戻る
- `settings.nudge.levels` の `hours_after_due` を一時的に短縮し、段階的督促（DM→メンション→全体共有→自動再割当）が発火する。静穏時間中は発火しない
- 運営専用チャンネルと参加者向け申請受付状況チャンネルに固定メッセージが投稿され、以後は編集で更新され続ける

**LLM層**（シャドーモード）
- 監視対象チャンネルに、粗フィルタを通過する程度の長さの発言を投稿する
- 最大30分待つか、ticket カテゴリ配下に新規チケットチャンネルを作成して自動登録を確認する
- `llm.developer_discord_id` 宛にDMが届き、**運営専用チャンネル・対象の運営者本人には一切通知が行かない**
- `/ops llm` で状態と処理待ち件数を確認でき、`action:pause` → `resume` で手動の一時停止・再開ができる
- `/ops cost` の呼び出し件数が増えている

## 開発

### 前提環境

- Edge層：Node.js 22 以上（Wrangler 4 の要件）
- CT層：Linux（Debian 13 等）、Python 3.11 以上

### コマンド

```powershell
# Edge層（Cloudflare Workers）
cd workers
npm test          # 単体テスト（vitest）
npm run typecheck # 型チェック（tsc --noEmit）
npm run dev       # ローカル開発サーバー起動（wrangler dev）
npm run db:migrate:local
```

```bash
# CT層（Python）
cd ct
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest tests -q
.venv/bin/ruff check .
```

### 開発上の原則

- **LLM 呼び出しは「機械的に判定できない処理」に限定する**（C-1）。面積計算・重複判定・期限計算・票の集計・通知送信・督促・状態遷移は一切 LLM を介さない。
- **LLM 層が停止しても他の全機能は動作を継続する**（C-2）。
- **Bot は賛否の判断を代行しない**（C-3）。承認・却下・処罰・許可はすべて人間の入力を起点とする（例外は機械的に一意に判定できる範囲に限定した個人開発領の形式審査のみ）。
- **秘密投票・記名許可・Bot形式審査を混同しない**（C-6）。3者は性質が異なり、実装上も別モジュールとして分離する。
- 設定値・チャンネルID・運営者プロファイル・承認事項の分類表を**ハードコードしない**。D1 の `settings` テーブルまたは環境変数へ外出しする。
- D1 スキーマ変更は `migrations/` に連番で追加する（既存ファイルは編集しない）。
- 締切・撤回猶予の判定は D1 保存の絶対時刻（UTC ISO8601）で行い、Cron の発火間隔に依存させない。
- Discord Interactions は必ず Ed25519 署名検証を通す。
- 面積計算・重複判定・票集計・定足数・期限判定には必ず単体テストを書く。

設計上の絶対制約 C-1〜C-7 の全文は [`docs/specification.md`](docs/specification.md) §0 を参照。

## 運用

### 自動デプロイ（GitHub の deploy ブランチ）

`deploy` ブランチへのマージを合図に、Workers・CT102・CT104 がそれぞれ自動で更新される。CT へは外から一切接続しない（CT 側が5分おきに GitHub を取りに行くプル型・§11-8）。

```
main で開発 → PR（main → deploy）→ CI（ct-test / workers-test）が通ればマージ
  ├─ Workers：GitHub Actions（deploy-workers.yml）が D1 マイグレーション適用 → wrangler deploy
  ├─ CT102 ：opsbot-ct-deploy.timer が取得 → /opt/opsbot/ct へ反映 → 再起動 → 起動確認（失敗なら復元）
  └─ CT104 ：dynmap-deploy-update.timer が dynmap_deploy.sh だけを取得 → 検証 → 差し替え
結果はすべて Discord Webhook に通知される。
```

| 対象 | 実行者 | 自動で反映されるもの | 手作業が必要なもの |
|---|---|---|---|
| Workers | GitHub Actions（Environment `production`） | `workers/` のコード、D1 マイグレーション | スラッシュコマンド定義の変更（`npm run commands:register`。通知で知らせる）、`wrangler secret` |
| CT102 | `opsbot-deploy` ユーザー（root ではない） | `ct/` のコード、依存（`pyproject.toml` 変更時に `pip install`） | `ct/deploy/` 配下（systemd ユニット等。通知で知らせる）、`/etc/opsbot/*` |
| CT104 | root（取得したファイルは実行しない） | `ct/deploy/dynmap_deploy.sh` | `/etc/opsbot/dynmap_deploy.conf` |

**権限の考え方**：deploy ブランチに書ける人＝本番を動かせる人になるため、GitHub アカウントの2FAとブランチ保護を必須とする。CT102 では、取得・`pip install` を root ではない `opsbot-deploy` で行い、root 権限は poller の再起動1コマンドだけを sudoers で許可する。poller を動かす `opsbot` はコードを読めるが書けない。各ホストの更新スクリプト自体（`/usr/local/bin/opsbot-ct-deploy` 等）は自動更新しない（変更時は手作業で入れ直す）。

**CT102 と CT104 の間のやり取り（`dynmap_deploy.sh` のサブコマンド）を変えるとき**：両ホストの更新タイミングは最大数分ずれるため、まず新しいサブコマンドを「追加」し、旧サブコマンドは両方の更新を確認してから次の変更で削除する。切り替わりの数分間に失敗したジョブは既存の再試行で回復する。

#### 初回導入：GitHub

1. アカウントの2FAを有効にする（Settings → Password and authentication）。
2. `main` から `deploy` ブランチを作る（リポジトリトップのブランチ選択 → `deploy` と入力 → Create branch deploy from main）。
3. ルールセットで `deploy` を保護する（Settings → Rules → Rulesets → New ruleset → New branch ruleset）。
   - Ruleset name：`deploy`、Enforcement status：**Active**
   - Bypass list：空のまま（自分も含め、誰も規則を飛ばせないようにする）
   - Target branches：Add target → Include by pattern → `deploy`
   - Rules：**Restrict deletions**／**Block force pushes**／**Require a pull request before merging**（Required approvals は 0）／**Require status checks to pass** → Add checks で `ct-test` と `workers-test` を追加
4. Environment を作る（Settings → Environments → New environment → `production`）。
   - Deployment branches and tags：**Selected branches and tags** → `deploy` を追加
   - Environment secrets：`CLOUDFLARE_API_TOKEN`／`CLOUDFLARE_ACCOUNT_ID`／`DISCORD_DEPLOY_WEBHOOK_URL`
5. Cloudflare の API トークンを作る（ダッシュボード → My Profile → API Tokens → Create Token → テンプレート「Edit Cloudflare Workers」）。Permissions に **Account → D1 → Edit** を追加し、Account Resources を自分のアカウントだけに絞る。Account ID は Workers & Pages の概要画面右側に表示される。
6. 公開リポジトリのため、外部からのPRで勝手に Actions が動かないようにする（Settings → Actions → General → Approval for running fork pull request workflows from contributors → **Require approval for all external contributors**）。

#### 初回導入：CT102

docker ユーザーの `~/ops-bot`（`ct/` のみの sparse-checkout）を最新にしてから実行する。以後、手作業の rsync は行わない。

```bash
cd ~/ops-bot && git pull --ff-only

# 自動デプロイ専用ユーザー（ログイン不可）
sudo useradd -r -m -d /var/lib/opsbot-deploy -s /usr/sbin/nologin opsbot-deploy

# コードと .venv は opsbot-deploy の所有に、Bot が書く work/ だけは opsbot のままにする
sudo chown -R opsbot-deploy:opsbot-deploy /opt/opsbot/ct
sudo chown -R opsbot:opsbot /opt/opsbot/ct/work
sudo chmod -R go+rX,go-w /opt/opsbot/ct

# 更新スクリプト（root 所有・自動更新しない）・sudoers・設定
sudo install -o root -g root -m 0755 ct/deploy/opsbot-ct-deploy.sh /usr/local/bin/opsbot-ct-deploy
sudo install -o root -g root -m 0440 ct/deploy/opsbot-ct-deploy.sudoers /etc/sudoers.d/opsbot-ct-deploy
sudo visudo -cf /etc/sudoers.d/opsbot-ct-deploy        # "parsed OK" を確認
sudo install -o root -g root -m 0600 ct/deploy/deploy.env.example /etc/opsbot/deploy.env
sudo nano /etc/opsbot/deploy.env                         # Webhook URL を記入

sudo cp ct/deploy/opsbot-ct-deploy.service ct/deploy/opsbot-ct-deploy.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start opsbot-ct-deploy                    # 初回は手動で実行して結果を確認
journalctl -u opsbot-ct-deploy -n 30 --no-pager
sudo systemctl enable --now opsbot-ct-deploy.timer
```

今すぐ反映したいときは `sudo systemctl start opsbot-ct-deploy`。一度失敗して復元したコミットは、新しいコミットが来るまで再試行しない。定期メンテナンスで poller が止まっている間はファイルだけ更新し、再起動はしない（再開時に反映される）。

#### 初回導入：CT104

```bash
# 配信先の設定を、現行スクリプトに書かれている値から設定ファイルへ移す
sudo mkdir -p /etc/opsbot
sudo grep -E '^(DYNMAP_WEB_DIR|IMAGES_SUBDIR|REGIONS_JS_PATH)=' /opt/opsbot/dynmap_deploy.sh \
  | sudo tee /etc/opsbot/dynmap_deploy.conf
sudo chown root:root /etc/opsbot/dynmap_deploy.conf && sudo chmod 0644 /etc/opsbot/dynmap_deploy.conf
ls -ld /opt/opsbot                                       # root 所有で opsbot-dynmap が書き込めないこと

# 更新スクリプトと timer（root 所有・更新スクリプト自体は自動更新しない）
base=https://raw.githubusercontent.com/Gorodrich/ops-bot/deploy/ct/deploy
sudo curl -fsSLo /usr/local/sbin/dynmap-deploy-update "$base/dynmap-deploy-update.sh"
sudo chmod 0755 /usr/local/sbin/dynmap-deploy-update
sudo curl -fsSLo /etc/systemd/system/dynmap-deploy-update.service "$base/dynmap-deploy-update.service"
sudo curl -fsSLo /etc/systemd/system/dynmap-deploy-update.timer "$base/dynmap-deploy-update.timer"
echo 'OPSBOT_DEPLOY_DISCORD_WEBHOOK_URL=<Webhook URL>' | sudo tee /etc/opsbot/dynmap-update.env >/dev/null
sudo chmod 0600 /etc/opsbot/dynmap-update.env

sudo systemctl daemon-reload
sudo systemctl start dynmap-deploy-update                # 初回は手動で実行して結果を確認
journalctl -u dynmap-deploy-update -n 30 --no-pager
sudo systemctl enable --now dynmap-deploy-update.timer
```

更新スクリプトは、取得したファイルが `bash -n` を通らない場合や `/etc/opsbot/dynmap_deploy.conf` が無い場合は差し替えない（現行版で動き続ける）。直前の版は `/opt/opsbot/dynmap_deploy.sh.prev` に残る。

### CT層の定期メンテナンス時間帯の自動停止

ホスト側の定期メンテナンスで CT が再起動すると Crafty との通信が不安定化するため、想定時間帯を挟んで `opsbot-ct-poller` を自動停止・再開する。`systemctl disable` は稼働中のプロセスを止めない（次回起動時の自動起動を抑止するだけ）ため使わず、calendar タイマーによる `stop`/`start` で対応する。

```bash
sudo cp deploy/opsbot-ct-poller-pause.service deploy/opsbot-ct-poller-pause.timer \
        deploy/opsbot-ct-poller-resume.service deploy/opsbot-ct-poller-resume.timer \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now opsbot-ct-poller-pause.timer opsbot-ct-poller-resume.timer
systemctl list-timers | grep opsbot-ct-poller   # 次回発火時刻を確認
```

既定の停止時間帯は 07:59〜08:15（ホストのローカル時刻）。変更する場合は各 `.timer` の `OnCalendar` を編集し、`daemon-reload` 後に対象タイマーを `restart` する。

停止中は heartbeat も更新されないため、監視側のアラートがこの時間帯に誤検知しないようサイレンスを別途設定すること。

### トラブルシューティング

| 症状 | 対処 |
|---|---|
| `wrangler d1 migrations apply` が Cloudflare API エラー **7403** を返す | `npx wrangler d1 execute opsbot --remote --file migrations/<該当ファイル>.sql` で直接適用し、`d1_migrations` テーブルへ手動で1行 INSERT して記録を揃える |
| Mojang API が **403** を返す | Cloudflare Workers から Mojang API へは直接到達できない。ユーザー名／UUID 解決は CT層経由（ジョブキュー方式）で行う設計になっている。`tools/migrate_claims.py` も Mojang へ到達できる環境で実行する |
| スラッシュコマンドが Discord に出てこない | グローバル登録は反映まで最大1時間かかる。開発中は `npm run commands:register:guild` でギルド限定登録すると即時反映される |
| Crafty 連携が動かない | 起動ログで証明書ピン留めの成否を確認する。フィンガープリント不一致・未到達の場合は連携が自動的に無効化される（他機能は継続） |
| Dynmap に反映されない | `OPSBOT_DYNMAP_SYNC_ENABLED` が `false` の間はジョブが黙ってスキップされる（失敗扱いにならずタスクも起票されない） |
| 締切処理が遅れる | Cron は10分ごとのため最大10分の遅延が生じる（仕様）。急ぐ場合は `/modvote end` で期限前終了できる |

## ドキュメント

| 文書 | 内容 |
|---|---|
| 本 README | システム構成・コマンド一覧・セットアップ手順・運用 |
| [`docs/specification.md`](docs/specification.md) | 技術仕様書。設計上の絶対制約 C-1〜C-7・データモデル・処理フロー |
| [`docs/guide-staff.md`](docs/guide-staff.md) | 運営者向けガイド。全コマンドの使い方と裏側の仕組み |
| [`docs/guide-participants.md`](docs/guide-participants.md) | 参加者向けガイド |
| [`docs/guide-kaihatsu.md`](docs/guide-kaihatsu.md) | 個人開発領ガイド。届出・審査・譲渡の手順と仕様 |

> **非公開の文書について**：要件定義の原本・フェーズごとの実装計画とチェックリスト・意思決定ログ（`decisions.md`）・未確定事項の管理表（`open-items.md`）・インフラ構成図は、運営内の未合意論点や個人・環境固有の情報を含むため、このリポジトリには含めていません。ソース中のコメントや本 README に `decisions.md #53`・`open-items #41`・`§6.3.4` のような参照が残っていますが、いずれもそれらの非公開文書の該当箇所を指すものです。参照先が無くてもコメント自体で文脈が追えるようにしてあります。

## ライセンス

本プロジェクトは **[GNU Affero General Public License v3.0 or later（AGPL-3.0-or-later）](LICENSE)** のもとで公開されています。

```
Copyright (C) 2026 3DS半分こするくらい仲良しクラフト中央委員会
```

### 利用条件と特記事項

- **ネットワーク経由での利用（AGPL §13）**：本ソフトウェアを改変してネットワーク経由でサービス・機能として提供する場合、バイナリを直接配布していなくても、その利用者に対して改変後のソースコードを開示する義務があります。フォークを公開リポジトリ等に配置し、Bot の案内（README や `/ops` の応答など）からそこへリンクしておくのが最も簡単な履行方法です。
- **依存関係の両立性**：依存関係はすべて AGPL と両立します。Cloudflare Workers 側は外部ランタイム依存を持たず、CT層の Python 依存は BSD-3-Clause / MIT / MIT-CMU / ISC 等の寛容型と、MPL-2.0（`certifi`。§3.3 の Secondary Licenses により GPL 系と併用可）のみです。Crafty Controller・Dynmap・Claude Code CLI はいずれもネットワーク API またはサブプロセスとして呼ぶだけで、リンクも同梱もしていません。

## 免責事項

本プロジェクトは Minecraft 公式の製品・サービスではありません。Mojang または Microsoft から承認を受けておらず、それらとの関連性もありません。　

「Minecraft」は Mojang Synergies AB の商標です。
