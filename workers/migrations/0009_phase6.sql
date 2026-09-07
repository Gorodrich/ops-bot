-- Phase 6：LLM層（シャドーモード。§7・§4.1.1）
--
-- 方針：
--   * LLM層はこのフェーズで初めて導入する。シャドーモード＝検出・割当のロジックは動かすが、
--     結果は本物の tasks テーブルへは書かず、専用テーブル（llm_shadow_detections）に記録し、
--     開発者へのDM通知のみを行う（C-2・C-3・§9のドライラン）。既存のダッシュボード・督促・
--     割当統計（現在の未完了負荷等）を一切汚染しない設計とする。
--   * staff.notes は開発者の個人的な評価を含みうる（CLAUDE.mdに基づく追加指示）。この列は
--     従来どおりLLM呼び出しのペイロード構築時にのみ読み出し、job_queue.payload（CT向け）以外の
--     どこにも保存・転送しない。LLMの出力についても、機械的なフィルタ（llm/safety.ts）を通した
--     ものだけを保存・通知する（notesの内容や評価そのものを匂わせる文言は破棄する）。

-- ticket toolチャンネルの監視台帳（§4.1.1）。ticket_open_category_ids配下に出現したチャンネルを登録し、
-- クローズ検知（チャンネル名変化 or 一覧から消失）で status を 'closed' にする。
CREATE TABLE monitored_channels (
  channel_id           TEXT PRIMARY KEY,
  kind                 TEXT NOT NULL,                -- 'ticket' | 'ops'
  status               TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'closed'
  requester_discord_id TEXT,                          -- ticket開設者（topic/embedから判明時のみ）
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  closed_at            TEXT
);

-- LLM層のシャドーモード検出結果（§7.3の出力スキーマ＋割当プレビュー）。
-- source_message_url にユニーク制約を持たせ、同一メッセージからの重複検出を防ぐ（§9：冪等性）。
CREATE TABLE llm_shadow_detections (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id                 INTEGER,
  source_message_url     TEXT NOT NULL UNIQUE,
  type                   TEXT NOT NULL,                 -- T-B | T-C
  title                  TEXT NOT NULL,
  summary                TEXT NOT NULL,
  required_tags          TEXT NOT NULL DEFAULT '[]',
  suggested_priority     TEXT,
  suggested_rule         TEXT,
  confidence             REAL NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'pending_assignment', -- pending_assignment|pending_tiebreak|resolved
  would_assign_primary   TEXT,                          -- staff.discord_id（あれば）
  would_assign_cosigner  TEXT,
  would_assign_reason    TEXT,                          -- ok|no_eligible|tie_or_below_threshold|llm_tiebreak
  positive_note          TEXT,                          -- LLMによる短い前向きな適性コメント（安全フィルタ通過分のみ）
  notified_at            TEXT,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- LLM呼び出しの連続失敗検知（§7.4：縮退運転の自動発火）。llm_usageは既存テーブルを流用し、
-- ここでは判定に使う設定キーのみ追加する。

INSERT INTO settings (key, value, description) VALUES
  ('llm', '{"developer_discord_id":"","confidence_threshold":0.6,"max_tokens":1024,"min_message_chars":8,"coarse_filter_patterns":[],"scan_interval_sec":1800,"consecutive_failure_pause_threshold":5,"paused":false}',
   'LLM層の起動条件・前処理フィルタ・利用枠の縮退運転条件（§7）。developer_discord_idは未確定のためプレースホルダ。Phase 6はシャドーモード固定');
