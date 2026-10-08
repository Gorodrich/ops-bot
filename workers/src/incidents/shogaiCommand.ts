// /shogai start・update・resolve（障害お知らせ・decisions.md #66）。
// 監視・自動通知はGrafana／UptimeRobotが担うため、ここでは運営者が手で打つ告知文を定型のEmbedに整えて
// 「サーバーお知らせ」チャンネル（settings.channels.server_notice）へ投稿するだけにする（C-1：LLMは使わない）。
//
// 入力は2段階：スラッシュコマンドの短いオプション（件名・状態・時刻等）を draft として保存し、
// 長文の各項目はモーダルで入力させる（モーダルのテキスト入力は5個まで）。続報・復旧報のモーダルには
// 直前の報の内容を初期値として入れておき、変わった箇所だけ直せばよいようにする。

import type { Env } from "../env";
import { type CommandOption, type Interaction, InteractionResponseType, modalFieldValue, optionValue } from "../discord/types";
import { EPHEMERAL_FLAG, sendAnnouncementMessage, sendChannelMessageWithComponents, sendFollowupMessage } from "../discord/rest";
import type { DeferredResult } from "../accountLinks/authoriseCommand";
import { resolveUneiActor } from "../staff/subaccountEligibility";
import { getChannels, getGuildId, getIncidentNoticeSetting } from "../settings";
import { writeAuditLog } from "../auditLog";
import {
  buildGeneralFirstMessage,
  buildGeneralResolvedMessage,
  buildIncidentEmbed,
  defaultFirstImpact,
  defaultFirstLead,
  defaultResolvedDataImpact,
  defaultTimeline,
  DEFAULT_UPDATE_LEAD,
  formatJstShort,
  formatNextNotice,
  formatResumeEta,
  markImpactRecovered,
  parseJstDateTime,
  resolvedLead,
  type ReportKind,
} from "./domain";
import {
  type AnnounceInput,
  deleteIncident,
  fillDraftReport,
  getIncident,
  getLatestPostedReport,
  getReport,
  insertDraftReport,
  insertIncident,
  listOpenIncidents,
  markIncidentResolved,
  markReportPosted,
  nextReportNo,
  releaseReportNo,
  reopenIncident,
  reserveReportNo,
  setAnnounceMessageId,
  type IncidentReportRow,
  type IncidentRow,
} from "./repo";

export const SHOGAI_MODAL_CUSTOM_ID_PREFIX = "shogai:modal:";

// モーダルの各項目は Embed のフィールド（1024文字上限）にそのまま入るため、少し余裕を持たせて抑える。
const FIELD_MAX = 1000;
const LEAD_MAX = 1500;
const OPTION_MAX = 100;

const FIELD = {
  lead: "lead",
  impact: "impact",
  cause: "cause",
  eta: "eta",
  dataImpact: "data_impact",
  timeline: "timeline",
  prevention: "prevention",
} as const;

function immediate(content: string): DeferredResult {
  return {
    ack: { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content, flags: EPHEMERAL_FLAG } },
    followUp: async () => {},
  };
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function serverNoticeChannel(env: Env): Promise<string | null> {
  const channels = await getChannels(env);
  return channels.server_notice ?? null;
}

async function generalNoticeChannel(env: Env): Promise<string | null> {
  const channels = await getChannels(env);
  return channels.general_notice ?? null;
}

const GENERAL_CHANNEL_MISSING =
  "全般用お知らせの投稿先（settings.channels.general_notice）が未設定です。全般用お知らせを出さない場合は `announce:False` を指定してください。";

/** BOOLEAN オプション。未指定なら既定値。 */
function boolOption(options: CommandOption[], name: string, fallback: boolean): boolean {
  const v = optionValue(options, name);
  return v === undefined ? fallback : v === "true";
}

function textInput(customId: string, label: string, value: string, maxLength: number) {
  return {
    type: 1,
    components: [
      {
        type: 4,
        custom_id: customId,
        style: 2,
        label,
        required: true,
        max_length: maxLength,
        value: value.slice(0, maxLength),
      },
    ],
  };
}

function modal(draftId: number, title: string, rows: unknown[]): DeferredResult {
  return {
    ack: { type: InteractionResponseType.MODAL, data: { custom_id: `${SHOGAI_MODAL_CUSTOM_ID_PREFIX}${draftId}`, title, components: rows } },
    followUp: async () => {},
  };
}

function trimmed(options: CommandOption[], name: string): string | undefined {
  const v = optionValue(options, name)?.trim();
  return v ? v.slice(0, OPTION_MAX) : undefined;
}

/**
 * 対象の障害を決める。incident オプション（autocomplete）が無ければ、継続中の障害がちょうど1件のときだけそれを使う。
 */
async function resolveTargetIncident(env: Env, options: CommandOption[]): Promise<{ ok: true; incident: IncidentRow } | { ok: false; message: string }> {
  const raw = optionValue(options, "incident");
  if (raw) {
    const incident = /^\d+$/.test(raw) ? await getIncident(env, Number(raw)) : null;
    if (!incident) return { ok: false, message: "指定された障害が見つかりません。候補から選択してください。" };
    if (incident.status !== "open") return { ok: false, message: `障害 #${incident.id} は既に復旧報を出しています。` };
    return { ok: true, incident };
  }
  const open = await listOpenIncidents(env);
  if (open.length === 0) return { ok: false, message: "継続中の障害がありません。新しい障害は `/shogai start` で第1報を出してください。" };
  const [only, ...rest] = open;
  if (!only || rest.length > 0) return { ok: false, message: "継続中の障害が複数あります。`incident` オプションで対象を選択してください。" };
  return { ok: true, incident: only };
}

/** /shogai start：第1報。 */
export async function handleShogaiStart(env: Env, interaction: Interaction, options: CommandOption[]): Promise<DeferredResult> {
  const resolved = await resolveUneiActor(env, interaction.member);
  if (!resolved.ok) return immediate(resolved.message);
  if (!(await serverNoticeChannel(env))) return immediate("投稿先チャンネル（settings.channels.server_notice）が未設定です。");

  const subject = trimmed(options, "subject");
  const headline = trimmed(options, "status");
  if (!subject || !headline) return immediate("`subject`（何が）と `status`（今の状態）を入力してください。");

  const now = nowIso();
  const startedRaw = trimmed(options, "started_at");
  const startedAt = startedRaw ? parseJstDateTime(startedRaw, now) : now;
  if (!startedAt) return immediate("`started_at` は「14:05」「10/8 14:05」のような形式で、現在以前の日時を入力してください。");

  const minecraftDown = boolOption(options, "minecraft_down", false);
  const announceEnabled = boolOption(options, "announce", true);
  if (announceEnabled && !(await generalNoticeChannel(env))) return immediate(GENERAL_CHANNEL_MISSING);
  const resumeEtaRaw = trimmed(options, "resume_eta");
  const announce: AnnounceInput | null = announceEnabled
    ? {
        causeShort: trimmed(options, "cause_short") ?? null,
        resumeEta: resumeEtaRaw ? formatResumeEta(resumeEtaRaw, now) : null,
        worldDataSafe: optionValue(options, "world_data") === "safe",
      }
    : null;

  const draftId = await insertDraftReport(env, {
    incidentId: null,
    kind: "first",
    subject,
    eventAt: startedAt,
    headline,
    nextNotice: trimmed(options, "next") ?? null,
    compensation: null,
    minecraftDown,
    announce,
    createdBy: resolved.actorId,
  });

  const { services } = await getIncidentNoticeSetting(env);
  return modal(draftId, "第1報の入力", [
    textInput(FIELD.lead, "冒頭文", defaultFirstLead(subject), LEAD_MAX),
    textInput(FIELD.impact, "影響範囲（「- サービス：状態」の箇条書き）", defaultFirstImpact(services), FIELD_MAX),
    textInput(FIELD.cause, "原因", "調査中です。", FIELD_MAX),
    textInput(FIELD.eta, "復旧見込み", "未定です。", FIELD_MAX),
    textInput(FIELD.dataImpact, "データへの影響", "調査中です。", FIELD_MAX),
  ]);
}

/** /shogai update：第N報（続報）。直前の報の内容を初期値にする。 */
export async function handleShogaiUpdate(env: Env, interaction: Interaction, options: CommandOption[]): Promise<DeferredResult> {
  const resolved = await resolveUneiActor(env, interaction.member);
  if (!resolved.ok) return immediate(resolved.message);
  if (!(await serverNoticeChannel(env))) return immediate("投稿先チャンネル（settings.channels.server_notice）が未設定です。");

  const target = await resolveTargetIncident(env, options);
  if (!target.ok) return immediate(target.message);
  const incident = target.incident;
  const latest = await getLatestPostedReport(env, incident.id);

  const draftId = await insertDraftReport(env, {
    incidentId: incident.id,
    kind: "update",
    subject: null,
    eventAt: null,
    headline: trimmed(options, "status") ?? latest?.headline ?? "対応中",
    nextNotice: trimmed(options, "next") ?? null,
    compensation: null,
    minecraftDown: null,
    announce: null, // 全般用お知らせは第1報・復旧報のときだけ
    createdBy: resolved.actorId,
  });

  const no = await nextReportNo(env, incident.id);
  return modal(draftId, `第${no}報の入力（${incident.subject}）`.slice(0, 45), [
    textInput(FIELD.lead, "冒頭文", DEFAULT_UPDATE_LEAD, LEAD_MAX),
    textInput(FIELD.impact, "影響範囲（「- サービス：状態」の箇条書き）", latest?.impact ?? "", FIELD_MAX),
    textInput(FIELD.cause, "原因", latest?.cause ?? "調査中です。", FIELD_MAX),
    textInput(FIELD.eta, "復旧見込み", latest?.eta ?? "未定です。", FIELD_MAX),
    textInput(FIELD.dataImpact, "データへの影響", latest?.data_impact ?? "調査中です。", FIELD_MAX),
  ]);
}

/** /shogai resolve：復旧報。 */
export async function handleShogaiResolve(env: Env, interaction: Interaction, options: CommandOption[]): Promise<DeferredResult> {
  const resolved = await resolveUneiActor(env, interaction.member);
  if (!resolved.ok) return immediate(resolved.message);
  if (!(await serverNoticeChannel(env))) return immediate("投稿先チャンネル（settings.channels.server_notice）が未設定です。");

  const target = await resolveTargetIncident(env, options);
  if (!target.ok) return immediate(target.message);
  const incident = target.incident;

  const now = nowIso();
  const resolvedRaw = trimmed(options, "resolved_at");
  const resolvedAt = resolvedRaw ? parseJstDateTime(resolvedRaw, now) : now;
  if (!resolvedAt) return immediate("`resolved_at` は「14:05」「10/8 14:05」のような形式で、現在以前の日時を入力してください。");
  if (Date.parse(resolvedAt) < Date.parse(incident.started_at)) {
    return immediate(`復旧日時が発生日時（${formatJstShort(incident.started_at)}）より前になっています。`);
  }

  const rollbackRaw = trimmed(options, "rollback_to");
  const rollbackTo = rollbackRaw ? parseJstDateTime(rollbackRaw, now) : null;
  if (rollbackRaw && !rollbackTo) return immediate("`rollback_to` は「3:00」「10/8 3:00」のような形式で、現在以前の日時を入力してください。");

  const announceEnabled = boolOption(options, "announce", true);
  if (announceEnabled && !(await generalNoticeChannel(env))) return immediate(GENERAL_CHANNEL_MISSING);

  const latest = await getLatestPostedReport(env, incident.id);
  const draftId = await insertDraftReport(env, {
    incidentId: incident.id,
    kind: "resolved",
    subject: null,
    eventAt: resolvedAt,
    headline: trimmed(options, "status") ?? "全サービス復旧",
    nextNotice: null,
    compensation: trimmed(options, "compensation") ?? "なし",
    minecraftDown: null,
    announce: announceEnabled ? { rollbackTo } : null,
    createdBy: resolved.actorId,
  });

  return modal(draftId, `復旧報の入力（${incident.subject}）`.slice(0, 45), [
    textInput(FIELD.impact, "影響範囲", markImpactRecovered(latest?.impact ?? ""), FIELD_MAX),
    textInput(FIELD.cause, "原因（何が起き、なぜ波及したかを2〜3文で）", latest?.cause ?? "", FIELD_MAX),
    textInput(FIELD.timeline, "復旧までの経緯", defaultTimeline(incident.started_at, resolvedAt), FIELD_MAX),
    textInput(FIELD.dataImpact, "データへの影響", defaultResolvedDataImpact(rollbackTo), FIELD_MAX),
    textInput(FIELD.prevention, "再発防止策", "- ", FIELD_MAX),
  ]);
}

/** モーダル送信 → 投稿。投稿（Discord REST）に時間がかかりうるため deferred で応答する。 */
export async function handleShogaiModalSubmit(env: Env, interaction: Interaction): Promise<DeferredResult> {
  const resolved = await resolveUneiActor(env, interaction.member);
  if (!resolved.ok) return immediate(resolved.message);
  const actorId = resolved.actorId;

  const draftId = Number((interaction.data?.custom_id ?? "").slice(SHOGAI_MODAL_CUSTOM_ID_PREFIX.length));
  const draft = Number.isInteger(draftId) ? await getReport(env, draftId) : null;
  if (!draft || draft.status !== "draft") return immediate("この入力は既に投稿済み、または無効です。");

  const v = (id: string) => modalFieldValue(interaction, id)?.trim() || null;
  await fillDraftReport(env, draft.id, {
    lead: v(FIELD.lead),
    impact: v(FIELD.impact) ?? "",
    cause: v(FIELD.cause) ?? "",
    eta: v(FIELD.eta),
    dataImpact: v(FIELD.dataImpact) ?? "",
    timeline: v(FIELD.timeline),
    prevention: v(FIELD.prevention),
  });

  return {
    ack: { type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: EPHEMERAL_FLAG } },
    followUp: async () => {
      let content: string;
      try {
        content = await postReport(env, draft.id, actorId);
      } catch (e) {
        console.error("shogai: post failed", e);
        content = "投稿に失敗しました。時間をおいてもう一度コマンドを実行してください。";
      }
      await sendFollowupMessage(env.DISCORD_APP_ID, interaction.token, { content, flags: EPHEMERAL_FLAG });
    },
  };
}

/**
 * draft を投稿する。番号の確保 → （第1報なら障害作成／復旧報なら障害を復旧済みに）→ 投稿 → posted の順に行い、
 * 投稿に失敗したら確保した番号・障害の状態を元に戻す。戻り値は実行者への完了メッセージ。
 */
export async function postReport(env: Env, reportId: number, actorId: string): Promise<string> {
  const report = await getReport(env, reportId);
  if (!report || report.status !== "draft") return "この入力は既に投稿済み、または無効です。";
  const channelId = await serverNoticeChannel(env);
  if (!channelId) return "投稿先チャンネル（settings.channels.server_notice）が未設定です。";

  const kind = report.kind as ReportKind;
  let incident: IncidentRow | null;
  let reportNo: number;

  if (kind === "first") {
    const incidentId = await insertIncident(env, {
      subject: report.subject ?? "",
      startedAt: report.event_at ?? nowIso(),
      minecraftDown: report.minecraft_down === 1,
      createdBy: report.created_by,
    });
    incident = await getIncident(env, incidentId);
    reportNo = 1;
  } else {
    incident = report.incident_id !== null ? await getIncident(env, report.incident_id) : null;
    if (!incident) return "対象の障害が見つかりません。";
    if (incident.status !== "open") return `障害 #${incident.id} は既に復旧報を出しているため投稿しませんでした。`;
    reportNo = await nextReportNo(env, incident.id);
  }
  if (!incident) return "障害の登録に失敗しました。";

  if (!(await reserveReportNo(env, report.id, incident.id, reportNo))) {
    if (kind === "first") await deleteIncident(env, incident.id);
    return "他の運営者がほぼ同時に投稿したため、投稿しませんでした。最新の報を確認のうえ、必要ならもう一度実行してください。";
  }

  if (kind === "resolved") {
    if (!(await markIncidentResolved(env, incident.id, report.event_at ?? nowIso()))) {
      await releaseReportNo(env, report.id, false);
      return `障害 #${incident.id} は既に復旧報を出しているため投稿しませんでした。`;
    }
  }

  const postedAt = nowIso();
  const resolvedAt = kind === "resolved" ? report.event_at ?? postedAt : null;
  const embed = buildIncidentEmbed({
    kind,
    incidentId: incident.id,
    reportNo,
    subject: incident.subject,
    headline: report.headline,
    postedAt,
    startedAt: incident.started_at,
    resolvedAt,
    lead: kind === "resolved" ? resolvedLead(incident.started_at, resolvedAt ?? postedAt) : report.lead ?? "",
    impact: report.impact ?? "",
    cause: report.cause ?? "",
    eta: report.eta,
    dataImpact: report.data_impact ?? "",
    nextNotice: kind === "resolved" ? null : formatNextNotice(report.next_notice ?? undefined, reportNo + 1),
    timeline: report.timeline,
    prevention: report.prevention,
    compensation: report.compensation,
  });

  let messageId: string;
  try {
    messageId = await sendChannelMessageWithComponents(env.DISCORD_BOT_TOKEN, channelId, "", [], [embed]);
  } catch (e) {
    await rollback(env, report, incident.id, kind);
    throw e;
  }

  await markReportPosted(env, report.id, { channelId, messageId, postedAt });
  await writeAuditLog(env, {
    actor: actorId,
    action: `incident_report_${kind}`,
    target: String(incident.id),
    detail: { report_id: report.id, report_no: reportNo, headline: report.headline, message_id: messageId },
  });

  const guildId = await getGuildId(env).catch(() => null);
  const linkTo = (ch: string, msg: string) => (guildId ? `https://discord.com/channels/${guildId}/${ch}/${msg}` : `<#${ch}>`);
  const label = kind === "resolved" ? "復旧報" : `第${reportNo}報`;
  const lines = [`障害 #${incident.id} の${label}を投稿しました：${linkTo(channelId, messageId)}`];

  // 全般用お知らせ（第1報・復旧報のみ）。詳細報は既に出ているため、失敗しても詳細報は巻き戻さず実行者に伝える。
  const announce = report.announce ? (JSON.parse(report.announce) as AnnounceInput) : null;
  if (announce && kind !== "update") {
    const generalId = await generalNoticeChannel(env);
    const minecraftDown = incident.minecraft_down === 1;
    try {
      if (!generalId) throw new Error("settings.channels.general_notice が未設定");
      const content =
        kind === "first"
          ? buildGeneralFirstMessage({
              minecraftDown,
              subject: incident.subject,
              startedAt: incident.started_at,
              causeShort: announce.causeShort ?? null,
              resumeEta: announce.resumeEta ?? null,
              worldDataSafe: announce.worldDataSafe === true,
              detailChannelId: channelId,
            })
          : buildGeneralResolvedMessage({
              minecraftDown,
              subject: incident.subject,
              startedAt: incident.started_at,
              resolvedAt: resolvedAt ?? postedAt,
              rollbackTo: announce.rollbackTo ?? null,
              detailChannelId: channelId,
            });
      const announceId = await sendAnnouncementMessage(env.DISCORD_BOT_TOKEN, generalId, content, minecraftDown);
      await setAnnounceMessageId(env, report.id, announceId);
      lines.push(`全般用お知らせも投稿しました${minecraftDown ? "（@everyone）" : ""}：${linkTo(generalId, announceId)}`);
    } catch (e) {
      console.error("shogai: general announcement failed", e);
      lines.push("⚠ 全般用お知らせの投稿に失敗しました。お手数ですが手動で投稿してください。");
    }
  }
  return lines.join("\n");
}

async function rollback(env: Env, report: IncidentReportRow, incidentId: number, kind: ReportKind): Promise<void> {
  await releaseReportNo(env, report.id, kind === "first");
  if (kind === "first") await deleteIncident(env, incidentId);
  if (kind === "resolved") await reopenIncident(env, incidentId);
}

/** incident オプションの候補（継続中の障害のみ。件名の部分一致）。 */
export async function handleShogaiIncidentAutocomplete(env: Env, query: string): Promise<Array<{ name: string; value: string }>> {
  const q = query.trim();
  return (await listOpenIncidents(env))
    .filter((i) => !q || i.subject.includes(q) || String(i.id) === q)
    .slice(0, 25)
    .map((i) => ({ name: `${i.subject}障害（#${i.id}・${formatJstShort(i.started_at)}〜）`.slice(0, 100), value: String(i.id) }));
}
