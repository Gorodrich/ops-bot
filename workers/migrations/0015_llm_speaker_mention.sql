-- LLMタイブレーク割当プレビューの依頼者偏り是正（docs/decisions.md #65の是正・シャドー運用後の修正）。
-- T-B/T-C検出の発言者・宛先メンションIDを保持する（§4.5：依頼者除外・優先候補ヒント）。
--
-- message_author_discord_id は常に「検出元メッセージの投稿者」を指す。既存の
-- requester_discord_id（T-Bのticket開設者優先のフォールバック値。detectionCompletion.tsの
-- resolveRequesterId）とは意味が異なるため別カラムとする。
--
-- mentioned_staff_ids は本文中の <@ID> メンション先のうちstaffテーブルに実在するIDのみを
-- JSON配列で保持する。自動割当のハード決定には使わず、タイブレーク発生時のLLMプロンプト・
-- 開発者DMプレビューへの「優先候補ヒント（is_mentioned）」としてのみ参照する。

ALTER TABLE llm_shadow_detections ADD COLUMN message_author_discord_id TEXT;
ALTER TABLE llm_shadow_detections ADD COLUMN mentioned_staff_ids TEXT NOT NULL DEFAULT '[]';
