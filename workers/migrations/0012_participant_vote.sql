-- 参加者投票の新設（2026-09-06決定）。
-- 従来の /vote（運営の承認・秘密投票／短縮投票）を /modvote に改名し、参加者向けの秘密投票を
-- 新設の /vote（start・status・end のみ。quickは参加者投票にはない）として追加する。
-- 混同防止のため votes.voter_scope で母数の算出元（unei=運営ロール／participant=hito ロール）を区別する。
-- 承認事項の分類表は運営投票側（settings.approval_types）とテーブルを分け、
-- settings.participant_approval_types に新設する（同じキー名を流用してもテーブルが違うため競合しない）。

ALTER TABLE votes ADD COLUMN voter_scope TEXT NOT NULL DEFAULT 'unei';    -- unei（従来の/modvote）| participant（新設の/vote）

-- プレースホルダとして空オブジェクトを入れ、実値は settings.yaml から npm run settings:seed で投入する
-- （settings.approval_types と同じ方針・0007_phase4.sql参照）。
INSERT INTO settings (key, value, description) VALUES
  ('participant_approval_types', '{}',
   '参加者投票（/vote）の承認事項の分類表。quorum_type/threshold。npm run settings:seed で投入');

-- 参加者投票の投稿先チャンネル。デバッグのため当面は運営投票（modvote）と同じチャンネルを指す
-- （decisions.md参照。準備が整い次第 settings.yaml の channels.participant_vote_hall を専用チャンネルへ変更する）。
-- json_set は既存キーがあれば変更しない（settings.yamlで既にカスタマイズ済みの値を壊さないため・0007_phase4.sqlと同じ方針）。
UPDATE settings
SET value = json_set(value, '$.participant_vote_hall', json_extract(value, '$.vote_hall')),
    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
WHERE key = 'channels' AND json_extract(value, '$.participant_vote_hall') IS NULL;
