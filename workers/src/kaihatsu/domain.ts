// /kaihatsu set・delete の純粋ロジック（§5.7・§6.3）。
// D1・Discord・CTへの依存を持たない（テスト容易性のため。accountLinks/domain.ts と同じ方針）。

/** 宣言型モデルの分解（§5.7.1・§6.1：設定／変更／一部削除の別を明記する）。 */
export type DecompositionLabel = "setting" | "change" | "partial_delete";

export const DECOMPOSITION_LABELS: Record<DecompositionLabel, string> = {
  setting: "設定（令和8年ルール第3号第2条）",
  change: "変更（同第6条）",
  partial_delete: "一部削除（同第7条）",
};

export function decomposeApplication(input: {
  hadPreviousClaim: boolean;
  addedPixels: number;
  removedPixels: number;
}): DecompositionLabel[] {
  const labels: DecompositionLabel[] = [];
  if (!input.hadPreviousClaim) {
    labels.push("setting");
    return labels;
  }
  if (input.addedPixels > 0) labels.push("change");
  if (input.removedPixels > 0) labels.push("partial_delete");
  // 従前と完全に同一の範囲を再宣言した場合（addedもremovedも0）は「変更」として記録する
  // （宣言そのものは行われているため、分解ラベルなしにはしない）。
  if (labels.length === 0) labels.push("change");
  return labels;
}

/**
 * bboxの交差有無だけで重複の有無を判定してはならない（§6.3.1・決定#5）が、
 * 「交差しないなら重複しえない」という必要条件での足切りには使える。
 * Workers側でCTに渡す既存claimsの候補を絞り込むために使う（性能目的のみ）。
 */
export interface WorldBBox {
  x1: number;
  z1: number;
  x2: number; // exclusive
  z2: number; // exclusive
}

export function bboxMayOverlap(a: WorldBBox, b: WorldBBox): boolean {
  return a.x1 < b.x2 && b.x1 < a.x2 && a.z1 < b.z2 && b.z1 < a.z2;
}

/** claims.bbox_loc1/bbox_loc2（JSON文字列 {x,y,z}）から WorldBBox を復元する。壊れていればnull。 */
export function worldBBoxFromLocJson(loc1Json: string | null, loc2Json: string | null): WorldBBox | null {
  if (!loc1Json || !loc2Json) return null;
  try {
    const loc1 = JSON.parse(loc1Json) as { x: number; z: number };
    const loc2 = JSON.parse(loc2Json) as { x: number; z: number };
    return { x1: loc1.x, z1: loc1.z, x2: loc2.x, z2: loc2.z };
  } catch {
    return null;
  }
}

// ゾーン番号→ワールド座標の対応（別紙3章）。実際のピクセル判定はCT側（opsbot_ct.image）が
// 全面的に担う（§11-9：既存ツールの流用対象）。ここでは「既存claimsを渡す候補を粗く絞り込む」
// という性能目的のみに、ゾーン単位の矩形を用いる（ピクセル単位の重複判定そのものではない）。
const ZONE_SIZE = 5000;
const ZONE_COLS: Record<number, number> = { 1: -10000, 2: -5000, 3: 0, 4: 5000 };
const ZONE_ROWS: Record<number, number> = { 1: -10000, 2: -5000, 3: 0, 4: 5000 };

function zoneWorldBBox(zoneNo: string): WorldBBox | null {
  const n = Number(zoneNo);
  if (!Number.isInteger(n) || n < 1 || n > 16) return null;
  const row = Math.floor((n - 1) / 4) + 1;
  const col = ((n - 1) % 4) + 1;
  const x1 = ZONE_COLS[col] ?? 0;
  const z1 = ZONE_ROWS[row] ?? 0;
  return { x1, z1, x2: x1 + ZONE_SIZE, z2: z1 + ZONE_SIZE };
}

// ── Phase 3：期限計算・グループの原子性（§5.7.2〜§5.7.5・§4.6・§9締切精度） ──────

/** 絶対時刻（UTC ISO8601）にN時間を加算する。締切はCron発火間隔に依存しない絶対時刻で持つ（§9）。 */
export function addHoursIso(nowIso: string, hours: number): string {
  return new Date(new Date(nowIso).getTime() + hours * 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** deadlineIso（絶対時刻）を過ぎているか。null は「期限なし」として false を返す。 */
export function isPastDeadline(nowIso: string, deadlineIso: string | null): boolean {
  if (!deadlineIso) return false;
  return new Date(nowIso).getTime() >= new Date(deadlineIso).getTime();
}

export type GroupMemberStatus = "collecting" | "provisional" | "confirmed" | "rejected" | "withdrawn" | "expired";

export interface GroupMemberState {
  status: GroupMemberStatus;
}

export type GroupResolution = "waiting" | "approved" | "rejected";

/**
 * 同時処理グループの原子性（§5.7.4）：メンバー全員が72時間以内に本人確認を終えたときに限り成立する。
 * 1人でも取り下げ・期限切れ・形式要件不合格（rejected）があれば、その時点でグループ全体を却下する
 * （部分成立させない。通常の一括申請§5.7.3が参加者ごとに独立して成否を決めるのと異なる点）。
 */
export function resolveGroup(members: GroupMemberState[]): GroupResolution {
  if (members.length === 0) return "waiting";
  if (members.some((m) => m.status === "rejected" || m.status === "withdrawn" || m.status === "expired")) {
    return "rejected";
  }
  if (members.every((m) => m.status === "confirmed")) {
    return "approved";
  }
  return "waiting";
}

/**
 * グループ内の評価順序（§5.7.4）：delete（および宣言型setによる縮小）を先に仮適用し、
 * その結果空いた領域に対してset（拡大）を判定する。安定ソートのため同一opの相対順序は保つ。
 */
export function orderGroupMembersForEvaluation<T extends { op: "set" | "delete" }>(members: T[]): T[] {
  return [...members].sort((a, b) => {
    if (a.op === b.op) return 0;
    return a.op === "delete" ? -1 : 1;
  });
}

/**
 * ファイル名（別紙7章：`{ゾーン番号2桁}_{プレイヤー名}.png`）からプレイヤー名を取り出す。
 * 最初のアンダースコアのみで分割する（プレイヤー名自体にアンダースコアを含む場合があるため）。
 * Workers側は「代表者一括申請（§5.7.3）でファイルをプレイヤーごとにグルーピングする」目的にのみ
 * これを使う。①②③等の中身の検証・厳密なゾーン範囲チェックはCT側の責務（§6.3.2）のまま。
 */
export function playerNameFromFilename(filename: string): string | null {
  if (!/\.png$/i.test(filename)) return null;
  const stem = filename.slice(0, -4);
  const idx = stem.indexOf("_");
  if (idx <= 0) return null;
  const zonePart = stem.slice(0, idx);
  const playerPart = stem.slice(idx + 1);
  if (!/^\d{2}$/.test(zonePart) || !playerPart) return null;
  return playerPart;
}

/** ファイル名（{2桁ゾーン番号}_...）の先頭2桁からゾーン集合のワールドbboxの和を求める。
 * 解析できないファイル名は無視する（そのようなファイルはどのみちCT側で条件不合格となる）。
 */
export function unionZoneBBoxFromFilenames(filenames: string[]): WorldBBox | null {
  let out: WorldBBox | null = null;
  for (const filename of filenames) {
    const m = /^(\d{2})_/.exec(filename);
    const zoneNo = m?.[1];
    if (!zoneNo) continue;
    const bbox = zoneWorldBBox(zoneNo);
    if (!bbox) continue;
    out = out
      ? { x1: Math.min(out.x1, bbox.x1), z1: Math.min(out.z1, bbox.z1), x2: Math.max(out.x2, bbox.x2), z2: Math.max(out.z2, bbox.z2) }
      : bbox;
  }
  return out;
}
