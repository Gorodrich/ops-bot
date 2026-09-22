-- 管理者/開発者専用タスク区分の新設（2026-09-21決定・docs/decisions.md #64）。
-- 「技術者（OP保持者。is_technician）」とは別に、サーバーインフラ管理・Bot設定変更など
-- 物理的に開発者本人しか担当できない業務を区別するための属性を追加する。
--
-- is_developer: staff側の属性。この属性を持つ運営者は、requires_developer タスクの
-- 強制割当先として max_concurrent の上限判定を無視して選ばれる（§4.5.2）。
-- requires_developer: tasks側の属性。true の場合、割当は is_developer 保持者に固定され、
-- 共同確認（cosign）の仕組みもスキップされる。

ALTER TABLE staff ADD COLUMN is_developer INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN requires_developer INTEGER NOT NULL DEFAULT 0;
