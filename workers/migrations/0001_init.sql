-- OpsBot D1 初期スキーマ（要件定義 §8）
-- 方針：
--   * 設定値・チャンネルID・分類表はこのスキーマ内にハードコードしない（ルールc）。
--     すべて settings テーブル（キー・バリュー）に格納し、再デプロイなしで変更可能とする（§9）。
--   * CT はこの D1 に直接接続しない。必ず Workers の内部APIエンドポイント経由（§8）。
--   * 締切判定は絶対時刻（UTC ISO8601 文字列）で保存し、Cron発火間隔に依存しない（§9）。
--
-- Phase 0 では「テーブルが存在し、マイグレーションが通る」ことがゴール。
-- 各機能のカラム追加・制約強化は後続フェーズのマイグレーションで積み増す。

-- ============================================================
-- 設定（ルールc：IDや重み・閾値・分類表の外出し先）
-- ============================================================
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,              -- JSON文字列。呼び出し側でパースする
  description TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ============================================================
-- 運営者プロファイル（§4.4）／実体は staff.yaml から seed
-- ============================================================
CREATE TABLE staff (
  discord_id             TEXT PRIMARY KEY,
  display_name           TEXT NOT NULL,
  active                 INTEGER NOT NULL DEFAULT 1,
  tags                   TEXT NOT NULL DEFAULT '[]',   -- JSON配列（§4.4 タグ語彙）
  weak_tags              TEXT NOT NULL DEFAULT '[]',   -- JSON配列
  is_technician          INTEGER NOT NULL DEFAULT 0,   -- 基本ルール第23条の技術者
  discord_permission_tier TEXT NOT NULL DEFAULT 'standard', -- admin|broad|standard（§4.5.1）
  requires_cosign        INTEGER NOT NULL DEFAULT 0,   -- §4.5.1
  max_concurrent         INTEGER NOT NULL DEFAULT 3,
  active_hours           TEXT NOT NULL DEFAULT '[]',   -- JSON配列
  response_pattern       TEXT NOT NULL DEFAULT 'normal', -- fast|normal|slow|deadline_driven
  nudge_style            TEXT NOT NULL DEFAULT 'standard', -- gentle|standard|firm
  on_leave_active        INTEGER NOT NULL DEFAULT 0,   -- 基本ルール第14条第2項：母数から除外
  on_leave_until         TEXT,
  notes                  TEXT,                          -- LLM層のみ参照（機械層は読まない）
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ============================================================
-- タスク台帳（§4.3）
-- ============================================================
CREATE TABLE tasks (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  type                  TEXT NOT NULL,                  -- T-A..T-E
  title                 TEXT NOT NULL,
  summary               TEXT,
  source_channel_id     TEXT,
  source_message_url    TEXT UNIQUE,                    -- 冪等性：同一メッセージから重複タスクを作らない（§9）
  related_rule          TEXT,
  required_tags         TEXT NOT NULL DEFAULT '[]',
  requires_technician   INTEGER NOT NULL DEFAULT 0,
  required_permission_tier TEXT,
  is_controversial      INTEGER NOT NULL DEFAULT 0,
  estimated_load        INTEGER,                        -- 1..5
  requester             TEXT,                           -- 参加者ID
  assignee              TEXT,                           -- 運営者ID
  co_signer             TEXT,
  co_sign_status        TEXT,
  status                TEXT NOT NULL DEFAULT 'unassigned',
  priority              TEXT NOT NULL DEFAULT 'medium', -- high|medium|low
  due_at                TEXT,
  deadline_source       TEXT,                           -- rule|bot_default
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  assigned_at           TEXT,
  started_at            TEXT,
  completed_at          TEXT,
  nudge_count           INTEGER NOT NULL DEFAULT 0,
  last_nudged_at        TEXT,
  escalation_level      INTEGER NOT NULL DEFAULT 0,
  completion_evidence   TEXT,
  vote_id               INTEGER,
  revocable_until       TEXT,
  revoked_by            TEXT,
  revoke_reason         TEXT
);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_assignee ON tasks(assignee);
CREATE INDEX idx_tasks_due_at ON tasks(due_at);

-- ============================================================
-- 申請（T-A）／個人開発領（§5.7・§6.3）
-- ============================================================
CREATE TABLE applications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,                          -- kaihatsu_set|kaihatsu_delete|kyoka|...
  requester     TEXT NOT NULL,                          -- 参加者Discord ID
  status        TEXT NOT NULL DEFAULT 'received',
  submitted_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  effective_at  TEXT,                                   -- 効力発生時刻（一括申請は代表者提出時刻に遡及・#28）
  payload       TEXT NOT NULL DEFAULT '{}',             -- JSON
  group_key     TEXT,                                   -- 同時処理グループ（#30）
  provisional_until TEXT,                               -- 仮承認の本人確認期限（72時間・#27）
  task_id       INTEGER REFERENCES tasks(id)
);
CREATE INDEX idx_applications_requester ON applications(requester);
CREATE INDEX idx_applications_status ON applications(status);

-- 個人開発領（ピクセルマスクで表現。bbox は表示用にすぎない・§6.3.1／決定#5）
CREATE TABLE claims (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_uuid    TEXT NOT NULL,                          -- Minecraft UUID
  status        TEXT NOT NULL DEFAULT 'active',
  mask_ref      TEXT,                                   -- CT側マスク成果物への参照
  area_blocks   INTEGER,                                -- 面積（機械判定・ピクセル数）
  bbox_loc1     TEXT,                                   -- Dynmap表示用 {x,y,z}（JSON）
  bbox_loc2     TEXT,
  application_id INTEGER REFERENCES applications(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_claims_owner ON claims(owner_uuid);

-- 特定保護区域（§6.3.3 条件⑤／データ所在は未確定 #6）
CREATE TABLE protected_areas (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  mask_ref    TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ============================================================
-- 投票（秘密投票・§5.2）と個票（集計後に破棄・§8）
-- ============================================================
CREATE TABLE votes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  subject       TEXT NOT NULL,
  vote_type     TEXT NOT NULL,                          -- type_a など（§5）
  started_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  closes_at     TEXT NOT NULL,                          -- 絶対時刻（24時間自動締切・基本ルール第2条第2項）
  status        TEXT NOT NULL DEFAULT 'open',
  eligible_count INTEGER,                               -- 母数（休暇者を除外・§10-2）
  result        TEXT,                                   -- JSON（集計結果。個票破棄後もこれは保持）
  tallied_at    TEXT
);

-- 個票：秘密・短期保持。集計後 DELETE する（§8。バックアップにも残さない）
CREATE TABLE vote_ballots (
  vote_id     INTEGER NOT NULL REFERENCES votes(id),
  voter_id    TEXT NOT NULL,
  choice      TEXT NOT NULL,                            -- yes|no|abstain
  cast_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (vote_id, voter_id)                       -- 二重投票防止（§9）
);

-- ============================================================
-- 記名許可（永久保持・監査証跡・§5／§8）
-- ============================================================
CREATE TABLE permissions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  subject       TEXT NOT NULL,
  granter_id    TEXT NOT NULL,                          -- 記名
  decision      TEXT NOT NULL,                          -- ok|ng
  reason        TEXT,
  decided_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  context       TEXT                                    -- JSON（対象タスク等）
);

-- 撤回（個人開発領審査の24時間撤回・§5.7.2）
CREATE TABLE revocations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type   TEXT NOT NULL,                          -- application|claim
  target_id     INTEGER NOT NULL,
  revoked_by    TEXT NOT NULL,                          -- 記名（監査ログ）
  reason        TEXT NOT NULL,
  revoked_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ============================================================
-- アカウント紐づけ台帳（主キーはUUID・決定#32／§8）
-- ============================================================
CREATE TABLE account_links (
  minecraft_uuid  TEXT PRIMARY KEY,
  minecraft_name  TEXT NOT NULL,                        -- 変更されうるため主キーにしない
  discord_id      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',       -- active|inactive（退会後も保持・§6.4.3）
  linked_by       TEXT NOT NULL,                        -- self|modauth:<operator_id>
  linked_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  deactivated_at  TEXT
);
CREATE UNIQUE INDEX idx_account_links_discord_active
  ON account_links(discord_id) WHERE status = 'active';

-- ============================================================
-- ジョブキュー（CT102 がポーリングで取得・§3.4.2／§8）
-- ============================================================
CREATE TABLE job_queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,                          -- image_process|crafty_op|claude_code
  payload       TEXT NOT NULL DEFAULT '{}',             -- JSON
  status        TEXT NOT NULL DEFAULT 'pending',        -- pending|processing|done|failed
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  locked_by     TEXT,                                   -- CT側が取得時に排他ロック（二重実行防止・§8）
  locked_at     TEXT,
  result        TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_job_queue_status ON job_queue(status, next_retry_at);

-- ============================================================
-- 督促ログ・監査ログ・LLM利用量・カーソル（§8）
-- ============================================================
CREATE TABLE nudge_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER NOT NULL REFERENCES tasks(id),
  level       INTEGER NOT NULL,
  target_id   TEXT,
  sent_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor       TEXT,                                     -- operator_id|bot|system
  action      TEXT NOT NULL,
  target      TEXT,
  detail      TEXT,                                     -- JSON
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_audit_log_created ON audit_log(created_at);

CREATE TABLE llm_usage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      INTEGER,
  kind        TEXT,
  ok          INTEGER,
  detail      TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- メッセージ差分取得の「前回取得位置」（§3.1）
CREATE TABLE cursors (
  channel_id      TEXT PRIMARY KEY,
  last_message_id TEXT,
  purpose         TEXT NOT NULL DEFAULT 'message_diff', -- message_diff|ticket_scan
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ============================================================
-- 設定の初期キー（値はプレースホルダ。Phase 0 のチャンネル構成確認後に投入）
-- ============================================================
INSERT INTO settings (key, value, description) VALUES
  ('channels', '{}', 'チャンネルID一覧（個人開発領・諸国法・会議場フォーラム・運営専用・Bot通知先）。未確定#4'),
  ('ticket_tool', '{"ticket_open_category_ids":[],"ticket_closed_category_ids":[],"ticket_open_name_pattern":"^ticket-","ticket_closed_name_pattern":"^closed-","ticket_channel_scan_interval_sec":3600,"ticket_keyword_filter_threshold":null}', 'ticket-tool-spec.md §6'),
  ('deadlines', '{"vote_hours":24,"provisional_confirm_hours":72,"revoke_window_hours":24,"conflict_hold_hours":72}', 'ルール由来の期限（§4.6）。運用実績で調整#37'),
  ('assignment_weights', '{"w1":1.0,"w1_prime":1.0,"w2":1.0,"w3":1.0,"w4":1.0,"w5":1.0,"tag_match_threshold":0.0,"consecutive_assign_limit":3}', '割当アルゴリズムの重み・閾値（§4.5）'),
  ('nudge', '{"quiet_hours":{"from":"23:00","to":"08:00"},"max_per_day":3,"levels":[]}', '督促の間隔・宛先・静穏時間（§4.7）'),
  ('attachment_zone_count_default', '5', '1人あたり申請ゾーン数の暫定値N（未確定#33）'),
  ('polling', '{"active_interval_sec":4,"idle_interval_sec":45}', 'CT102ポーリング間隔（§3.4.2）'),
  ('account_link', '{"allow_self_overwrite":false,"whitelist_removal_grace_hours":0,"inactive_retention_days":null}', '未確定#42・#44'),
  ('discord_guild_id', '""', 'ギルドID。未確定#4');
