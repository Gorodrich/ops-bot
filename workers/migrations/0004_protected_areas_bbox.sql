-- Phase 2 動作確認（G-3）で判明：0001_init.sql の protected_areas に bbox_loc1/bbox_loc2 列が
-- 存在せず、listProtectedAreas（kaihatsu/repo.ts）が SELECT で bbox_loc1 を参照して
-- D1_ERROR: no such column: bbox_loc1 を起こしていた。
--
-- claims 同様、bbox はDynmap表示用にすぎない（§6.3.1／決定#5）が、E-2で運営が
-- protected_areas へINSERTする際に必要な列（name・mask_ref・bbox_loc1・bbox_loc2）として
-- checklist（phase-2-checklist.md E-2）にも明記されている。現状 protected_areas は
-- 0件運用（decisions.md #50）のためデータ移行は不要。

ALTER TABLE protected_areas ADD COLUMN bbox_loc1 TEXT;
ALTER TABLE protected_areas ADD COLUMN bbox_loc2 TEXT;
