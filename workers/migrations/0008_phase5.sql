-- Phase 5：期限管理・プロファイル割当・督促・ダッシュボード（§4.2・§4.5・§4.5.1・§4.6・§4.7・§4.8）
--
-- 方針（CLAUDE.md ルールc）：重み・閾値・督促文面のパラメータは settings テーブルに外出しする。
-- ここではスキーマ変更と、新規に追加した settings キーの初期値（プレースホルダ）投入のみを行う。

-- 辞退履歴（§4.2：辞退されたタスクは次順位の運営者へ再割当する。同一人物への再割当を避けるための除外リスト）
ALTER TABLE tasks ADD COLUMN declined_by TEXT NOT NULL DEFAULT '[]';

-- 保留の再開予定日（§4.2：保留は再開予定日の入力必須、その日に自動で割当済へ戻す）。
-- Phase 4 の暫定実装では due_at を再開日で上書きしていたが、これは本来の期限（due_at）を破壊するため
-- Phase 5 で列を分離する（既存の due_at 値はそのまま保持。保留中タスクの due_at は誤って再開日が
-- 入っている可能性があるため、on_hold のタスクに限り一旦 resume_at へ退避し due_at をクリアする）。
ALTER TABLE tasks ADD COLUMN resume_at TEXT;
UPDATE tasks SET resume_at = due_at, due_at = NULL, deadline_source = NULL
  WHERE status = 'on_hold' AND deadline_source = 'bot_default';

-- 投票の締切前リマインド（§4.7：未投票の投票タスクは締切3時間前に1回DM）の重複送信防止
ALTER TABLE votes ADD COLUMN reminder_sent_at TEXT;

-- ダッシュボード固定メッセージ（§4.8：運営チャンネル1つ・参加者向け公開チャンネル1つを想定）
CREATE TABLE dashboard_messages (
  kind        TEXT PRIMARY KEY,      -- ops（運営向け）| applications（参加者向け・申請受付状況のみ）
  channel_id  TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ルール由来でない期限（申請の審査など）のBot既定目標日数（§4.6：「目標」であり義務ではないことを通知文に明示する）
INSERT INTO settings (key, value, description) VALUES
  ('task_target_days', '{"default_days":5,"by_type":{"T-A":3,"T-C":5}}',
   'ルール上の義務ではないBot既定の目標日数（§4.6）。type別に上書き可、未指定はdefault_days');
