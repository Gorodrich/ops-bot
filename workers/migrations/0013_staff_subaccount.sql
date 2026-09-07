-- 運営者サブ垢連携（2026-09-07決定）。
-- サブ垢（「運営サブ垢」ロール保有アカウント）をメイン垢に連携し、以後サブ垢から実行された
-- 運営コマンドはメイン垢が行ったものとして扱う（投票の一票・記名許可の署名を含む）。
-- 参加者向け投票（voter_scope='participant'）の一票行使は対象外（人民ロールで別途判定される）。
--
-- sub_discord_id を主キーとし、1サブ垢は常に1メイン垢にのみ連携できる（1メイン垢は複数サブ垢を持てる）。
-- status='pending' は本人確認DM送信後・ボタン未操作の状態。confirmed になるまでは実行資格の解決には使わない。

CREATE TABLE IF NOT EXISTS staff_subaccounts (
  sub_discord_id  TEXT PRIMARY KEY,
  main_discord_id TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed
  requested_at    TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  confirmed_at    TEXT,
  created_by      TEXT NOT NULL, -- /subaccount link 実行者のdiscord_id（監査用。通常はmain_discord_idと同一）
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_staff_subaccounts_main ON staff_subaccounts(main_discord_id);

-- ロール設定に運営サブ垢ロールIDを追加（既存キーがあれば変更しない・0007_phase4.sqlと同じ方針）。
UPDATE settings
SET value = json_set(value, '$.unei_sub', ''),
    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
WHERE key = 'roles' AND json_extract(value, '$.unei_sub') IS NULL;

-- 本人確認DMの回答期限（時間）。settings.yaml から npm run settings:seed で実値を投入する。
UPDATE settings
SET value = json_set(value, '$.subaccount_confirm_hours', 24),
    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
WHERE key = 'deadlines' AND json_extract(value, '$.subaccount_confirm_hours') IS NULL;
