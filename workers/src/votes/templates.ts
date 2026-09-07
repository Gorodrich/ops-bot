// /vote の通知文面・ボタン定義（§11-6：文面のみで調整できるよう1ファイルに集約）。

import type { TallyResult } from "./domain";

export const VOTE_YES_BUTTON_PREFIX = "vote:yes:";
export const VOTE_NO_BUTTON_PREFIX = "vote:no:";
export const VOTE_ABSTAIN_BUTTON_PREFIX = "vote:abstain:";

export function buildVoteButtonRow(voteId: number): unknown[] {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 3, label: "賛成", custom_id: `${VOTE_YES_BUTTON_PREFIX}${voteId}` },
        { type: 2, style: 4, label: "反対", custom_id: `${VOTE_NO_BUTTON_PREFIX}${voteId}` },
        { type: 2, style: 2, label: "棄権", custom_id: `${VOTE_ABSTAIN_BUTTON_PREFIX}${voteId}` },
      ],
    },
  ];
}

const METHOD_LABEL: Record<string, string> = {
  secret: "秘密投票（類型A・基本ルール第2条）",
  quick: "短縮投票（基本ルール第2条の2）",
};

const METHOD_COLOR: Record<string, number> = {
  secret: 0x5865f2,
  quick: 0xe67e22,
};

/** 投票開始の投稿本文（embed）。targetMention はメンション通知を残すため content 側に別出しする。 */
export function buildVoteOpenedEmbed(args: {
  voteId: number;
  label: string;
  subject: string;
  method: "secret" | "quick";
  methodLabel?: string; // 省略時はMETHOD_LABEL[method]（参加者投票等、既定と異なる文言にしたい場合に指定）
  eligibleCount: number;
  eligibleCountNote?: string; // 省略時「母数（休暇者除外後）」（参加者投票には休暇制度がないため文言を変える）
  closesAtDiscordTimestamp: string;
  targetMention?: string | null;
  participantVoteRequired?: boolean;
}): { content: string; embed: Record<string, unknown> } {
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
  if (args.targetMention) {
    fields.push({ name: "対象", value: `${args.targetMention}（本人は母数・投票権から除外されます）` });
  }
  fields.push({ name: args.eligibleCountNote ?? "母数（休暇者除外後）", value: `${args.eligibleCount}人`, inline: true });
  fields.push({ name: "締切", value: args.closesAtDiscordTimestamp, inline: true });
  if (args.participantVoteRequired) {
    fields.push({
      name: "注記",
      value: "この事項は運営の承認に加えて参加者側の承認も別途必要です（本Botでは運営側の手続のみ扱います）。",
    });
  }
  return {
    content: args.targetMention ? args.targetMention : "",
    embed: {
      title: `【${args.methodLabel ?? METHOD_LABEL[args.method]}】投票 #${args.voteId}：${args.label}`,
      description: `件名：${args.subject}\n\n下のボタンから投票してください。押下結果は本人にのみ表示され、他の運営者からは見えません（秘密投票）。締切までに投票しない場合は棄権とみなします。`,
      color: METHOD_COLOR[args.method],
      fields,
    },
  };
}

export function buildBallotAckMessage(choice: "yes" | "no" | "abstain"): string {
  const label = choice === "yes" ? "賛成" : choice === "no" ? "反対" : "棄権";
  return `投票を受け付けました（${label}）。締切までは再度投票し直すことができます。`;
}

const CHOICE_LABEL: Record<string, string> = { yes: "賛成", no: "反対", abstain: "棄権" };

export function buildVoteResultEmbed(args: {
  voteId: number;
  label: string;
  subject: string;
  result: TallyResult;
  endedEarlyBy?: string | null;
}): Record<string, unknown> {
  const { result } = args;
  const fields = [
    { name: "賛成", value: `${result.yes}`, inline: true },
    { name: "反対", value: `${result.no}`, inline: true },
    { name: "棄権", value: `${result.abstain}`, inline: true },
  ];
  const note = args.endedEarlyBy ? `\n\n※<@${args.endedEarlyBy}>により締切前に終了されました（/vote end）。` : "";
  return {
    title: `【投票結果】投票 #${args.voteId}：${args.label}`,
    description: `件名：${args.subject}\n\n→ ${result.passed ? "可決" : "否決"}しました。${note}`,
    color: result.passed ? 0x57f287 : 0xed4245,
    fields,
  };
}

export function buildVoteStatusLine(args: {
  voteId: number;
  label: string;
  subject: string;
  method: "secret" | "quick";
  methodLabel?: string;
  closesAtDiscordTimestamp: string;
  status: "open" | "closed";
  result?: TallyResult | null;
}): string {
  const methodLabel = args.methodLabel ?? METHOD_LABEL[args.method];
  if (args.status === "open") {
    return `#${args.voteId}（${methodLabel}）：${args.label} — ${args.subject} ／ 締切 ${args.closesAtDiscordTimestamp}`;
  }
  const r = args.result;
  const outcome = r ? (r.passed ? "可決" : "否決") : "結果不明";
  return `#${args.voteId}（${methodLabel}）：${args.label} — ${args.subject} ／ ${outcome}（締切済み）`;
}

export const VOTE_MESSAGES = {
  noEligibleVoters: "現在「運営」ロールを持つ休暇中でない運営者がいないため、投票を開始できません。",
  unknownApprovalKey: "指定された事項は承認事項の分類表（settings.approval_types）に登録されていません。",
  methodBMismatch: "この事項は記名許可（類型B）です。/vote ではなく /kyoka を使用してください。",
  targetRequired: "この事項は対象者の指定（target）が必須です（本人除外・§5.5）。",
  alreadyClosed: "この投票は既に締め切られています。",
  notEligible: "あなたは現在この投票の母数に含まれていません（休暇中、または対象者本人のため）。",
  noOpenVotes: "現在進行中の投票はありません。",
  // 参加者投票（/vote）専用の文面（2026-09-06決定：参加者投票の新設）。
  noEligibleVotersParticipant: "現在「人民」ロールを持つ者がいないため、投票を開始できません。",
  unknownParticipantApprovalKey: "指定された事項は参加者投票の承認事項の分類表（settings.participant_approval_types）に登録されていません。",
  notEligibleParticipant: "あなたは現在「人民」ロールを持っていないため、この投票の対象ではありません。",
} as const;
