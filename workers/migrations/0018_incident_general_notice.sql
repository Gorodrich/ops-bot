-- 障害お知らせ（/shogai）の「全般用お知らせ」対応（2026-10-08決定・docs/decisions.md #66）。
-- 第1報・復旧報の投稿時に、詳細報（サーバーお知らせ）とは別に短いアナウンスを全般用お知らせへ投稿する。
--
-- minecraft_down: マイクラ鯖に入れない障害か。1なら【重要】版の文面で @everyone 付き、0ならメンションなしの文面にする。
-- announce: 全般用お知らせの入力（JSON）。NULL なら全般用お知らせを投稿しない（続報は常に NULL）。
-- announce_message_id: 全般用お知らせの投稿メッセージID。

ALTER TABLE incidents ADD COLUMN minecraft_down INTEGER NOT NULL DEFAULT 0;
ALTER TABLE incident_reports ADD COLUMN minecraft_down INTEGER;
ALTER TABLE incident_reports ADD COLUMN announce TEXT;
ALTER TABLE incident_reports ADD COLUMN announce_message_id TEXT;
