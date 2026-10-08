// 障害お知らせ（/shogai・decisions.md #66）の純粋ロジック：日時の解釈・整形、入力欄の初期値、Embedの組み立て。
// 障害の検知・状態判定は行わない（Grafana／UptimeRobotの担当）。ここは運営者の入力を定型の告知に整えるだけ。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
// 「H:MM」だけ入力された時刻が現在より先なら前日とみなす際の許容幅（時計のずれ・入力の手間で数分先になる程度は当日扱い）。
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

// Embedの上限（Discord API）。入力欄側でも max_length で抑えるが、組み立て時にも念のため切り詰める。
const EMBED_TITLE_MAX = 256;
const EMBED_DESCRIPTION_MAX = 4096;
const EMBED_FIELD_VALUE_MAX = 1024;

export const EMBED_COLOR = { first: 0xe74c3c, update: 0xe67e22, resolved: 0x2ecc71 } as const;

export type ReportKind = "first" | "update" | "resolved";

function toIso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** JSTの年月日時分（UTC表現のDateで持つ）。 */
function jstParts(iso: string): { y: number; mo: number; d: number; h: number; mi: number } {
  const t = new Date(Date.parse(iso) + JST_OFFSET_MS);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes() };
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 例：2026年10月8日 14:05 */
export function formatJstLong(iso: string): string {
  const p = jstParts(iso);
  return `${p.y}年${p.mo}月${p.d}日 ${p.h}:${pad2(p.mi)}`;
}

/** 例：10月8日 14:05（全般用お知らせ用） */
export function formatJstMonthDay(iso: string): string {
  const p = jstParts(iso);
  return `${p.mo}月${p.d}日 ${p.h}:${pad2(p.mi)}`;
}

/** 例：10/8 14:05（経緯の箇条書き・候補表示用） */
export function formatJstShort(iso: string): string {
  const p = jstParts(iso);
  return `${p.mo}/${p.d} ${p.h}:${pad2(p.mi)}`;
}

function sameJstDate(a: string, b: string): boolean {
  const x = jstParts(a);
  const y = jstParts(b);
  return x.y === y.y && x.mo === y.mo && x.d === y.d;
}

/** 全角数字・全角記号を半角へ寄せる（スマホからの入力対策）。 */
function normalizeInput(s: string): string {
  return s
    .trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[：]/g, ":")
    .replace(/[／]/g, "/")
    .replace(/[　]/g, " ")
    .replace(/\s+/g, " ");
}

/**
 * 発生日時・復旧日時の入力（JST）を解釈して UTC ISO8601 を返す。解釈できない・未来の日時なら null。
 * 受け付ける形式：「H:MM」「M/D H:MM」「YYYY/M/D H:MM」（全角可）。
 * 日付を省略した場合は今日（JST）とし、それが現在より先なら前日とみなす（深夜0時をまたいだ障害の入力を想定）。
 */
export function parseJstDateTime(input: string, nowIso: string): string | null {
  const s = normalizeInput(input);
  const m = s.match(/^(?:(?:(\d{4})\/)?(\d{1,2})\/(\d{1,2}) )?(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [, yRaw, moRaw, dRaw, hRaw, miRaw] = m;
  const h = Number(hRaw);
  const mi = Number(miRaw);
  if (h > 23 || mi > 59) return null;

  const nowMs = Date.parse(nowIso);
  const today = jstParts(nowIso);
  const hasDate = moRaw !== undefined;
  const y = yRaw !== undefined ? Number(yRaw) : today.y;
  const mo = hasDate ? Number(moRaw) : today.mo;
  const d = hasDate ? Number(dRaw) : today.d;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;

  let ms = Date.UTC(y, mo - 1, d, h, mi) - JST_OFFSET_MS;
  // 2/30 のような存在しない日付は Date.UTC が翌月へ繰り上げるため、往復して一致を確認する。
  const back = jstParts(toIso(ms));
  if (back.mo !== mo || back.d !== d) return null;

  if (!hasDate && ms > nowMs + FUTURE_TOLERANCE_MS) ms -= 24 * 60 * 60 * 1000;
  if (ms > nowMs + FUTURE_TOLERANCE_MS) return null;
  return toIso(ms);
}

/** 例：約3時間20分／約45分 */
export function formatDuration(startIso: string, endIso: string): string {
  const minutes = Math.max(0, Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60000));
  const h = Math.floor(minutes / 60);
  const mi = minutes % 60;
  if (h === 0) return `約${mi}分`;
  return mi === 0 ? `約${h}時間` : `約${h}時間${mi}分`;
}

/** 「1. 発生日時」欄。復旧前は継続中、復旧後は期間を併記する。 */
export function formatOccurrence(startedAt: string, resolvedAt: string | null): string {
  const start = `${formatJstLong(startedAt)}頃`;
  if (!resolvedAt) return `${start} 〜（継続中）`;
  const end = sameJstDate(startedAt, resolvedAt) ? formatJstLong(resolvedAt).split(" ")[1] : formatJstLong(resolvedAt);
  return `${start} 〜 ${end}（${formatDuration(startedAt, resolvedAt)}）`;
}

/**
 * 「次回のお知らせ」欄。時刻（H:MM）だけが入力された場合は定型文に展開し、それ以外は入力をそのまま使う。
 * 未入力なら状況変化時に知らせる旨の定型文にする。
 */
export function formatNextNotice(input: string | undefined, nextReportNo: number): string {
  const s = input?.trim();
  if (!s) return "状況に変化があり次第お知らせします。";
  const t = normalizeInput(s);
  if (/^\d{1,2}:\d{2}$/.test(t)) {
    return `${t}までに第${nextReportNo}報を出します（それまでに復旧した場合は復旧時にお知らせします）。`;
  }
  return s;
}

/** 第1報の冒頭文の初期値。 */
export function defaultFirstLead(subject: string): string {
  return `現在、${subject}をご利用いただけない状態です。ご迷惑をおかけし申し訳ございません。`;
}

export const DEFAULT_UPDATE_LEAD = "ご迷惑をおかけしており申し訳ございません。";

// 「長時間にわたり」等のお詫びの言い回しを付ける障害の長さ（短時間の障害で大げさな文面にならないようにする）。
const LONG_OUTAGE_MS = 3 * 60 * 60 * 1000;

function isLongOutage(startedAt: string, resolvedAt: string): boolean {
  return Date.parse(resolvedAt) - Date.parse(startedAt) >= LONG_OUTAGE_MS;
}

/** 復旧報の冒頭文（固定文）。 */
export function resolvedLead(startedAt: string, resolvedAt: string): string {
  const apology = isLongOutage(startedAt, resolvedAt) ? "長時間ご迷惑をおかけしました" : "ご迷惑をおかけしました";
  return `${formatJstLong(resolvedAt)}に全サービスの復旧を確認しました。${apology}ことをお詫び申し上げます。`;
}

/** 第1報の影響範囲の初期値（settings.incident_notice.services の各サービスを箇条書きにする）。 */
export function defaultFirstImpact(services: string[]): string {
  if (services.length === 0) return "- （サービス名）：停止中";
  return services.map((s) => `- ${s}：通常どおり`).join("\n");
}

/**
 * 復旧報の影響範囲の初期値：前報の箇条書きのうち「通常どおり」以外の行を「**復旧済み**」に書き換える。
 * 箇条書き（「- 名前：状態」）でない行はそのまま残す。
 */
export function markImpactRecovered(impact: string): string {
  return impact
    .split("\n")
    .map((line) => {
      const m = line.match(/^(\s*[-・*]\s*[^：:]+[：:])\s*(.*)$/);
      if (!m) return line;
      if (/通常どおり|通常通り|影響なし/.test(m[2] ?? "")) return line;
      return `${m[1]}**復旧済み**`;
    })
    .join("\n");
}

/** 復旧報の経緯の初期値。発生と復旧の2行だけを置き、途中の経過は運営者が書き足す。 */
export function defaultTimeline(startedAt: string, resolvedAt: string): string {
  return `- ${formatJstShort(startedAt)} 発生\n- ${formatJstShort(resolvedAt)} 復旧確認`;
}

/** 復旧報の「データへの影響」の初期値。巻き戻した時点（rollback_to）が指定されていればその旨を入れる。 */
export function defaultResolvedDataImpact(rollbackTo: string | null): string {
  return [
    rollbackTo ? `- 巻き戻し：あり（${formatJstMonthDay(rollbackTo)}時点に戻しました）` : "- 巻き戻し：なし",
    "- 失われたもの：なし",
    "- 運営側で見つけられていない異常があるかもしれません。参加時にご確認いただき、異常があればチケットでお知らせください。",
  ].join("\n");
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function field(name: string, value: string | null | undefined): { name: string; value: string } {
  const v = value?.trim();
  return { name, value: clip(v ? v : "—", EMBED_FIELD_VALUE_MAX) };
}

export interface IncidentEmbedInput {
  kind: ReportKind;
  incidentId: number;
  reportNo: number;
  subject: string;
  headline: string;
  postedAt: string;
  startedAt: string;
  resolvedAt: string | null;
  lead: string;
  impact: string;
  cause: string;
  eta?: string | null;
  dataImpact: string;
  nextNotice?: string | null;
  timeline?: string | null;
  prevention?: string | null;
  compensation?: string | null;
}

export function buildIncidentEmbed(r: IncidentEmbedInput): Record<string, unknown> {
  const label = r.kind === "resolved" ? "復旧報" : `第${r.reportNo}報`;
  const title = clip(`【${label}】${r.subject}障害（${r.headline}）`, EMBED_TITLE_MAX);
  const asOf = r.kind === "resolved" ? formatJstLong(r.postedAt) : `${formatJstLong(r.postedAt)} 現在`;
  const description = clip(`${asOf}\n\n${r.lead}`, EMBED_DESCRIPTION_MAX);

  const fields =
    r.kind === "resolved"
      ? [
          field("1. 発生日時", formatOccurrence(r.startedAt, r.resolvedAt)),
          field("2. 影響範囲", r.impact),
          field("3. 原因", r.cause),
          field("4. 復旧までの経緯", r.timeline),
          field("5. データへの影響", r.dataImpact),
          field("6. 再発防止策", r.prevention),
          field("補填", r.compensation),
        ]
      : [
          field("1. 発生日時", formatOccurrence(r.startedAt, null)),
          field("2. 影響範囲", r.impact),
          field("3. 原因", r.cause),
          field("4. 復旧見込み", r.eta),
          field("5. データへの影響", r.dataImpact),
          field("次回のお知らせ", r.nextNotice),
        ];

  return {
    title,
    description,
    color: EMBED_COLOR[r.kind],
    fields,
    footer: { text: `障害 #${r.incidentId}・${label}` },
    timestamp: r.postedAt,
  };
}

// ── 全般用お知らせ（settings.channels.general_notice）─────────────
// 詳細報（Embed）とは別に、第1報・復旧報のときだけ短いアナウンスを本文（content）で投稿する。
// マイクラ鯖に入れない障害（minecraftDown）は【重要】版の文面で @everyone 付き、それ以外はメンションなし。

/**
 * 再開見込みの入力を文面用に整える。「H:MM」「M/D H:MM」なら「M月D日 H:MMごろ」に展開し
 * （日付を省いて現在より前の時刻なら翌日とみなす）、それ以外（「10月9日以降」等）は入力をそのまま使う。
 */
export function formatResumeEta(input: string, nowIso: string): string {
  const s = normalizeInput(input);
  const m = s.match(/^(?:(\d{1,2})\/(\d{1,2}) )?(\d{1,2}):(\d{2})$/);
  if (!m) return input.trim();
  const [, moRaw, dRaw, hRaw, miRaw] = m;
  const h = Number(hRaw);
  const mi = Number(miRaw);
  if (h > 23 || mi > 59) return input.trim();
  if (moRaw !== undefined) return `${Number(moRaw)}月${Number(dRaw)}日 ${h}:${pad2(mi)}ごろ`;
  const today = jstParts(nowIso);
  let ms = Date.UTC(today.y, today.mo - 1, today.d, h, mi) - JST_OFFSET_MS;
  if (ms < Date.parse(nowIso)) ms += 24 * 60 * 60 * 1000;
  return `${formatJstMonthDay(toIso(ms))}ごろ`;
}

export interface GeneralFirstInput {
  minecraftDown: boolean;
  subject: string;
  startedAt: string;
  causeShort: string | null;
  resumeEta: string | null;
  worldDataSafe: boolean;
  detailChannelId: string;
}

export function buildGeneralFirstMessage(a: GeneralFirstInput): string {
  const since = `${formatJstMonthDay(a.startedAt)}ごろから`;
  const detail = `詳細は <#${a.detailChannelId}> をご確認ください。`;
  if (!a.minecraftDown) {
    return [
      `# ${a.subject}障害のお知らせ`,
      `${since}${a.subject}に障害が発生しているため、一時的に停止しています。マイクラサーバーなどその他のサービスは通常どおり利用できます。`,
      `ご迷惑をおかけし申し訳ございません。${detail}`,
    ].join("\n");
  }
  const cause = a.causeShort ?? "原因を調査中の障害";
  const eta = a.resumeEta
    ? `再開は${a.resumeEta}の見込みです（見込みが変わればお知らせします）。`
    : "再開の見込みは未定です（見込みが立ち次第お知らせします）。";
  return [
    "@everyone",
    "# 【重要】サーバー障害のお知らせとお詫び",
    `${since}、${cause}により、${a.subject}が停止しています。`,
    `${eta}ワールドデータは${a.worldDataSafe ? "無事を確認済み" : "調査中"}です。`,
    `ご迷惑をおかけし申し訳ございません。${detail}`,
  ].join("\n");
}

export interface GeneralResolvedInput {
  minecraftDown: boolean;
  subject: string;
  startedAt: string;
  resolvedAt: string;
  rollbackTo: string | null;
  detailChannelId: string;
}

export function buildGeneralResolvedMessage(a: GeneralResolvedInput): string {
  const span = `${formatJstMonthDay(a.startedAt)}ごろから発生していた`;
  const rolledBack = a.rollbackTo ? `${formatJstMonthDay(a.rollbackTo)}時点に戻しました` : null;
  if (!a.minecraftDown) {
    const data = rolledBack ? `ワールドデータは${rolledBack}。` : "ワールドデータやバックアップへの影響はありません。";
    return [
      `# ${a.subject}復旧のお知らせ`,
      `${span}${a.subject}の障害は、${formatJstMonthDay(a.resolvedAt)}に復旧しました。${data}`,
      "ご心配・ご迷惑をおかけし申し訳ありませんでした。",
    ].join("\n");
  }
  const apology = isLongOutage(a.startedAt, a.resolvedAt) ? "長期間にわたりご迷惑をおかけし" : "ご迷惑をおかけし";
  return [
    "@everyone",
    "# 【重要】サーバー復旧のお知らせ",
    `${span}障害は、${formatJstMonthDay(a.resolvedAt)}に復旧しました。`,
    `ワールドデータは${rolledBack ?? "影響ありません"}。異常に気づいた方はチケットでお知らせください。`,
    `${apology}、誠に申し訳ありませんでした。詳細は <#${a.detailChannelId}> をご確認ください。`,
  ].join("\n");
}
