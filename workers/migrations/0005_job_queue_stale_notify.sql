-- Phase 2 動作確認（G-10）で判明：CT102のポーリングプロセス自体が完全停止していると、
-- job_queue の行は誰にも claim/complete 報告されないため attempts が 0 のまま増えず、
-- jobs/completion.ts の再試行上限チェック（attempts >= crafty_max_attempts）が一切発火しない。
-- 「一度も claim されないまま長時間 pending のジョブ」を検知する別経路が必要（§6.4.4と同型の縮退動作）。
--
-- stale_notified_at は一度エスカレーション通知を送った印（通知の連投防止）。ジョブ自体は
-- 引き続き pending のままとし、CT102復旧後は通常どおり claim・処理される。

ALTER TABLE job_queue ADD COLUMN stale_notified_at TEXT;
