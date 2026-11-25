-- ルール施行令・ディープステート国内法の制定・改正の運営投票（decisions.md #69）。
-- 施行令・国内法は運営の多数決（投票者の過半数）で決まり、参加者協議・参加者投票を経ない。
-- rule-builder の改正案は改正ルール番号の種類（rule_proposals.provisional_number）で承認事項を選ぶため、表の列は増やさない。
--
-- 承認事項の分類表（settings.approval_types）に2件を足す（既存キーがあれば変更しない・0013 と同じ方針）。
-- settings.yaml にも同じ値を書いてあるので、npm run settings:seed で入れ直しても変わらない。
UPDATE settings
SET value = json_set(value, '$.decree_enactment', json('{"label":"ルール施行令の制定・改正","method":"A","quorum_type":"voters_majority","exclude_self":false}')),
    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
WHERE key = 'approval_types' AND json_extract(value, '$.decree_enactment') IS NULL;

UPDATE settings
SET value = json_set(value, '$.domestic_law_enactment', json('{"label":"ディープステート国内法の制定・改正","method":"A","quorum_type":"voters_majority","exclude_self":false}')),
    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
WHERE key = 'approval_types' AND json_extract(value, '$.domestic_law_enactment') IS NULL;
