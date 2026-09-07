-- Phase 3：仮承認・本人確認（72h）・同時処理グループ・保留と自動再審査・撤回（24h）・
-- Dynmap自動反映（§5.7.3〜§5.7.6・§6.3.4）。
--
-- 設計方針：
--   * 「届出がされた時」は代表者の提出時刻（applications.submitted_at）のまま変えない
--     （決定#28：本人確認は効力発生の条件であって届出時刻そのものではない）。
--   * 仮承認・保留・撤回はいずれも既存の applications 行の status 遷移で表現し、
--     新規レコードは作らない（再審査時も同一行を使い回すことで届出時刻を自然に保つ）。
--   * owner_mc_uuid/owner_mc_name は claims.owner_mc_name（#52）と同じ理由で非正規化する
--     （account_links への JOIN無しで「この人は今処理中か」を判定できるようにするため）。

ALTER TABLE applications ADD COLUMN submitted_by TEXT;              -- 代表者のDiscord ID（単独申請はrequesterと同じ値を入れる）
ALTER TABLE applications ADD COLUMN owner_mc_uuid TEXT;             -- このapplication行が対象とする参加者のMinecraft UUID
ALTER TABLE applications ADD COLUMN owner_mc_name TEXT;
ALTER TABLE applications ADD COLUMN target_claim_id INTEGER REFERENCES claims(id); -- delete/縮小の対象claim（§5.7.4のグループ内delete・予約判定に使う）
ALTER TABLE applications ADD COLUMN op TEXT NOT NULL DEFAULT 'set'; -- 'set'|'delete'（グループ内の評価順序：delete→set・§5.7.4）
ALTER TABLE applications ADD COLUMN confirmed_at TEXT;              -- 本人確認ボタン押下時刻（グループはこれが揃うまで待つ）
ALTER TABLE applications ADD COLUMN revocable_until TEXT;           -- 正式承認確定時刻+24h（§5.7.2）
ALTER TABLE applications ADD COLUMN held_blocking_application_id INTEGER REFERENCES applications(id); -- §5.7.5：先行する仮承認との競合
ALTER TABLE applications ADD COLUMN held_blocking_group_key TEXT;   -- §5.7.4：グループの土地予約との競合

CREATE INDEX idx_applications_owner_status ON applications(owner_mc_uuid, status);
CREATE INDEX idx_applications_group_key ON applications(group_key);
CREATE INDEX idx_applications_held_blocking_app ON applications(held_blocking_application_id);
CREATE INDEX idx_applications_held_blocking_group ON applications(held_blocking_group_key);
CREATE INDEX idx_applications_provisional_until ON applications(provisional_until);

-- 同時処理グループ本体（§5.7.4）。applications.group_key で個々のメンバー行と対応する。
CREATE TABLE application_groups (
  group_key                TEXT PRIMARY KEY,
  representative_discord_id TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'collecting', -- collecting|finalized|approved|rejected
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  finalized_at             TEXT,
  deadline_at              TEXT,  -- finalized_at + 72h（§4.6）
  resolved_at              TEXT
);

-- Dynmap反映ジョブの追跡は job_queue（kind='dynmap_sync'）をそのまま使う（新規テーブル不要）。
