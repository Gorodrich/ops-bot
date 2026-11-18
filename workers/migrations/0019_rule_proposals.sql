-- rule-builder の発議・採決の手続の記録（decisions.md #68）。
-- rule-builder（ds-craft/rule-builder）から RPC（RuleBuilderRpc）で発議・投票の開始などを受け付け、
-- 手続の記録（状態・投票 ID・時刻・固定した内容のハッシュ）はこの表を正とする。
-- rule-builder は一覧の表示用に写しを持ち、投票中は getProposalStatus で結果を問い合わせる。
--
-- state:
--   unei_discussion          発議済み・運営内協議中（rule-builder で編集できる）
--   mod_vote                 運営投票中（内容は固定）
--   participant_discussion   運営投票の可決後・参加者協議（participant_discussion_started_at が NULL なら開始の記録前）
--   participant_vote         参加者投票中
--   passed                   参加者投票の可決（施行前）
--   enacted                  ds-craft/rules への反映済み
--   rejected                 運営投票または参加者投票の否決
--   withdrawn                取り下げ（rule-builder では下書きに戻る。発議し直すと同じ行を使い直す）
CREATE TABLE rule_proposals (
  id                                TEXT PRIMARY KEY,   -- rule-builder の改正案 ID（UUID）
  title                             TEXT NOT NULL,      -- 題名（件名）
  provisional_number                TEXT NOT NULL,      -- 仮の改正ルール番号（令和8年ルール第4号）
  final_number                      TEXT,               -- 可決後に確定した改正ルール番号
  state                             TEXT NOT NULL,
  proposed_by                       TEXT NOT NULL,      -- 発議者（Discord ユーザー ID。サブ垢はメイン垢）
  proposed_at                       TEXT NOT NULL,
  public_url                        TEXT NOT NULL,      -- 公開リンク（ログイン不要の閲覧画面）
  content_hash                      TEXT,               -- 運営投票の開始時に固定した内容のハッシュ（sha256:…）
  mod_vote_id                       INTEGER REFERENCES votes(id),
  mod_vote_started_by               TEXT,
  participant_discussion_started_at TEXT,
  participant_discussion_started_by TEXT,
  participant_vote_id               INTEGER REFERENCES votes(id),
  participant_vote_started_by       TEXT,
  decided_at                        TEXT,               -- 可決・否決の確定
  enacted_at                        TEXT,
  portal_url                        TEXT,               -- 反映後のポータルのページ
  withdrawn_at                      TEXT,
  withdrawn_by                      TEXT,
  updated_at                        TEXT NOT NULL
);
CREATE INDEX rule_proposals_state ON rule_proposals (state);

-- 改正案に紐づく投票（集計のときに rule_proposals の状態を進めるため）
ALTER TABLE votes ADD COLUMN rule_proposal_id TEXT;
