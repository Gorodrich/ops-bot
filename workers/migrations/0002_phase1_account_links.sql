-- Phase 1：アカウント紐づけ機能で追加する設定キー
-- 既存テーブル（account_links / job_queue / audit_log / tasks）はそのまま使う。
-- 値は settings.yaml から `npm run settings:seed` で投入する（ルールc：ハードコード禁止）。

INSERT INTO settings (key, value, description) VALUES
  (
    'roles',
    '{"hito":"","kari_sanka":"","sub_aka":"","unei":""}',
    '/authorise 実行資格判定（人民・仮参加者ロールを持ち、サブ垢ロールのみの者は対象外・§6.4.1）と /modauth 実行資格（運営ロール）に使うロールID。未確定#4関連'
  ),
  (
    'job_retry',
    '{"crafty_max_attempts":5,"crafty_retry_backoff_sec":60,"crafty_audit_report_hour_utc":9}',
    'Crafty操作ジョブの再試行上限・バックオフと、日次ホワイトリスト突き合わせレポートの投稿時刻（UTC時。§6.4.4）'
  );
