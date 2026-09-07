-- Phase 4：承認投票（類型A・§5.2）・短縮投票（§5.3）・記名許可（類型B・§5.4／§5.4.1）・
-- 承認事項の分類表（§5.5）・タスク操作コマンド（§4.3）・休暇登録（§4.6）。
--
-- 設計方針：
--   * 承認事項の分類表（§5.5：quorum_type/threshold/exclude_self/method/必要人数）は
--     コードにハードコードせず settings.approval_types に格納する（ルールc）。値は
--     npm run settings:seed で投入する（settings.yaml 参照）。
--   * votes は Phase 0 で作成済み（0001_init.sql）。定足数計算に必要な列を追加する。
--   * 記名許可（permissions）は「1回の押下＝1行」だったが、要請本体（必要人数・状態・
--     対象メッセージ）を束ねる permission_requests を新設し、permissions.permission_request_id
--     で対応づける。permissions(permission_request_id, granter_id) の一意制約で
--     二重の記名を防ぐ（§9：冪等性）。
--   * tasks / staff は Phase 0 で作成済みの列でそのまま足りる（§4.3・§4.6）。

ALTER TABLE votes ADD COLUMN approval_key TEXT NOT NULL DEFAULT '';
ALTER TABLE votes ADD COLUMN method TEXT NOT NULL DEFAULT 'secret';      -- secret（§5.2）|quick（§5.3）
ALTER TABLE votes ADD COLUMN quorum_type TEXT NOT NULL DEFAULT 'voters_majority';
ALTER TABLE votes ADD COLUMN threshold REAL NOT NULL DEFAULT 0.5;
ALTER TABLE votes ADD COLUMN exclude_target TEXT;                       -- 本人除外の対象Discord ID（§5.5）
ALTER TABLE votes ADD COLUMN created_by TEXT NOT NULL DEFAULT '';
ALTER TABLE votes ADD COLUMN channel_id TEXT;
ALTER TABLE votes ADD COLUMN message_id TEXT;
ALTER TABLE votes ADD COLUMN task_id INTEGER REFERENCES tasks(id);       -- T-E（§4.1）との対応

CREATE INDEX idx_votes_status ON votes(status);
CREATE INDEX idx_votes_closes_at ON votes(closes_at);

-- 記名許可要請の本体（§5.4／§5.4.1）。
CREATE TABLE permission_requests (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_key   TEXT NOT NULL,
  subject        TEXT NOT NULL,
  requester_id   TEXT NOT NULL,
  required_count INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open',   -- open|approved|withdrawn
  description    TEXT,
  image_url      TEXT,
  channel_id     TEXT,
  message_id     TEXT,
  task_id        INTEGER REFERENCES tasks(id),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  decided_at     TEXT
);
CREATE INDEX idx_permission_requests_status ON permission_requests(status);

ALTER TABLE permissions ADD COLUMN permission_request_id INTEGER REFERENCES permission_requests(id);
CREATE UNIQUE INDEX idx_permissions_request_granter ON permissions(permission_request_id, granter_id);

-- 既存の deadlines 設定に短縮投票の締切（§5.3：会議継続中の短時間タイマー）を追加する。
-- json_set は既存キーがあれば変更しない（settings.yaml で既にカスタマイズ済みの値を壊さないため）。
UPDATE settings
SET value = json_set(value, '$.quick_vote_minutes', 15), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
WHERE key = 'deadlines' AND json_extract(value, '$.quick_vote_minutes') IS NULL;

-- 承認事項の分類表（§5.5）。プレースホルダとして空オブジェクトを入れ、実値は settings.yaml から投入する
-- （§5.5の表そのものは要件定義で確定済みのため、settings.example.yaml には全事項を記入済みにしてある）。
INSERT INTO settings (key, value, description) VALUES
  ('approval_types', '{}', '承認事項の分類表（§5.5）。quorum_type/threshold/exclude_self/method/required_count。npm run settings:seed で投入');
