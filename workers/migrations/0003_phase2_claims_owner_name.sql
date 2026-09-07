-- Phase 2：claims にプレイヤー名を非正規化して保持する（§6.3.3条件⑥の重複相手表示・decisions.md #52）。
--
-- 理由：listActiveClaimsExcludingOwner は重複判定の相手候補として既存claimsをCTへ渡す際、
-- 開示する「重複相手の名前」（open-items #36）を必要とする。account_linksへのJOINだけに
-- 依存すると、移行データ（tools/migrate_claims.py・decisions.md #51）で投入した既存の
-- 個人開発領のうち、所有者がまだ /authorise でDiscordアカウントを紐づけていないものが
-- 重複判定の対象から漏れてしまう（INNER JOINで消える）。claims側にMinecraft名を
-- 直接持たせることで、account_linksの紐づけ状況に関わらず正しく機能させる。

ALTER TABLE claims ADD COLUMN owner_mc_name TEXT;
