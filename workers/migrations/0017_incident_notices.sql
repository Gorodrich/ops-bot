-- 障害お知らせ（/shogai・2026-10-08決定・docs/decisions.md #66）。
-- 監視・自動通知はGrafana／UptimeRobotが担うため、本機能は運営者が手動で打つ告知文を
-- Embed形式に整形して投稿するだけの補助であり、障害の検知・状態判定は一切行わない。
--
-- incidents: 障害1件。第1報の投稿成功時に作成し、復旧報の投稿成功時に resolved にする。
-- incident_reports: 各報（第1報・続報・復旧報）。スラッシュコマンドの短いオプションを draft として先に保存し、
--   モーダル（長文の各項目）の送信で残りを埋めて posted にする（モーダルの custom_id には日本語の
--   オプション値を載せきれないため・custom_id は100文字上限）。放置された draft は投稿されないだけで実害はない。

CREATE TABLE incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,              -- 何が（例：Minecraftサーバー）。見出し「<subject>障害」に使う
  started_at TEXT NOT NULL,           -- 発生日時（UTC ISO8601）
  resolved_at TEXT,                   -- 復旧日時（UTC ISO8601）
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE incident_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER REFERENCES incidents(id),  -- 第1報の draft の間は NULL（投稿成功時に障害を作成して埋める）
  kind TEXT NOT NULL CHECK (kind IN ('first', 'update', 'resolved')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted')),
  report_no INTEGER,                  -- 第N報（投稿時に採番。復旧報も通し番号を持つ）
  subject TEXT,                       -- 第1報のみ：何が
  event_at TEXT,                      -- 第1報：発生日時／復旧報：復旧日時（UTC ISO8601）
  headline TEXT NOT NULL,             -- 見出し括弧内の状態要約
  lead TEXT,                          -- 冒頭文
  impact TEXT,                        -- 影響範囲
  cause TEXT,                         -- 原因
  eta TEXT,                           -- 復旧見込み（第1報・続報）
  data_impact TEXT,                   -- データへの影響
  timeline TEXT,                      -- 復旧までの経緯（復旧報）
  prevention TEXT,                    -- 再発防止策（復旧報）
  compensation TEXT,                  -- 補填（復旧報）
  next_notice TEXT,                   -- 次回のお知らせ（第1報・続報）
  channel_id TEXT,
  message_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  posted_at TEXT
);

-- 同じ障害で同じ番号の報が二重に投稿されないようにする（同時に2人が続報を出した場合の採番競合対策）。
CREATE UNIQUE INDEX idx_incident_reports_no ON incident_reports(incident_id, report_no) WHERE report_no IS NOT NULL;
CREATE INDEX idx_incidents_status ON incidents(status);

INSERT INTO settings (key, value, description) VALUES
  ('incident_notice', '{"services":[]}',
   '障害お知らせ（/shogai）：第1報の影響範囲欄に初期表示するサービス名の一覧。npm run settings:seed で投入');
