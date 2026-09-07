-- Phase 7：LLM検出の本稼働（§7・§4.5）
--
-- 方針：
--   * Phase 6のシャドーモード用の検出ロジック（llm_shadow_detections・detectionCompletion.ts）を
--     そのまま流用し、settings.llm.shadow_mode が false のときだけ実際の tasks テーブルへ書き込み、
--     実担当者へ通知する経路を追加する（Phase 6チェックリストで「Phase 6の範囲外」としていた部分）。
--   * shadow_mode を true→false に切り替える操作、および confidence_threshold・assignment_weights の
--     チューニングだけで本稼働へ移行できるようにする（コード変更・再デプロイ不要）。
--   * confidenceが閾値未満の検出は自動タスク化せず「候補」として運営専用チャンネルに提示し、
--     運営が採用／却下ボタンで採否を決める（§7.3・C-3：Botは採否の判断を代行しない）。

-- 既存の llm 設定に shadow_mode を追加する。json_set は既存キーがあれば変更しない
-- （0007と同じパターン。settings.yaml で既にカスタマイズ済みの値を壊さないため）。
-- 既定値は true（＝現状のシャドーモードのまま）。false にするまで挙動は一切変わらない。
UPDATE settings
SET value = json_set(value, '$.shadow_mode', json('true')), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
WHERE key = 'llm' AND json_extract(value, '$.shadow_mode') IS NULL;

-- 実タスク化の冪等性・監査用の紐づけ（§9）と、confidence閾値未満の「候補」採否フロー用のカラム。
ALTER TABLE llm_shadow_detections ADD COLUMN source_channel_id TEXT;
ALTER TABLE llm_shadow_detections ADD COLUMN requester_discord_id TEXT;
ALTER TABLE llm_shadow_detections ADD COLUMN task_id INTEGER REFERENCES tasks(id);
ALTER TABLE llm_shadow_detections ADD COLUMN decided_by TEXT;
ALTER TABLE llm_shadow_detections ADD COLUMN decided_at TEXT;
ALTER TABLE llm_shadow_detections ADD COLUMN review_channel_id TEXT;
ALTER TABLE llm_shadow_detections ADD COLUMN review_message_id TEXT;

-- status は従来の pending_assignment|pending_tiebreak|resolved に加え、
-- 本稼働（shadow_mode=false）時のみ candidate_pending|candidate_rejected を使う
-- （candidate_pendingは採用されるとresolvedに遷移しtask_idが入る）。CHECK制約は既存方針どおり付けない。
