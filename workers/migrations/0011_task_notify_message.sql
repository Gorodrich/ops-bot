-- タスクの起票通知を「1タスク1メッセージ」化するための参照先カラム（2026-09-06追加）。
-- dashboard_messages（固定1件）と異なりタスクごとに1件必要なため、tasksテーブルに直接持たせる。
-- notify_last_status は期限超過検知（ダッシュボード更新Cronと同時判定）で、既に「期限超過」表示
-- 済みのタスクへ無駄な再編集を繰り返さないためのキャッシュ。
ALTER TABLE tasks ADD COLUMN notify_channel_id TEXT;
ALTER TABLE tasks ADD COLUMN notify_message_id TEXT;
ALTER TABLE tasks ADD COLUMN notify_last_status TEXT;
