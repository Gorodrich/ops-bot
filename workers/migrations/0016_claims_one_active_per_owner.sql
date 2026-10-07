-- 1所有者（Minecraft UUID）あたりアクティブな個人開発領（claims.status='active'）は1件まで、を
-- DBの一意制約でも保証する（監査指摘・2026-10-07：本人確認ボタンの同時押下でclaimが二重登録され、
-- 運営による撤回後も片方が active のまま残る問題）。アプリ側は状態遷移の compare-and-set で防いでいるが、
-- 不変条件をデータ層でも強制しておく。
--
-- 注意：既に同一 owner_uuid の active が2件以上ある場合、このマイグレーションは失敗する。
-- 適用前に次のクエリで0件であることを確認し、該当があれば手動で整理してから適用すること。
--   SELECT owner_uuid, COUNT(*) AS n FROM claims WHERE status = 'active' GROUP BY owner_uuid HAVING n > 1;

CREATE UNIQUE INDEX idx_claims_owner_active ON claims(owner_uuid) WHERE status = 'active';
