// タスク関連の通知文面（§11-6：文面のみで調整できるよう1ファイルに集約）。
// 督促文面は固定テンプレート（LLM不使用・§4.7）。皮肉・煽り表現を含めない。

import type { TaskRow } from "./repo";

export function discordTimestamp(iso: string): string {
  const sec = Math.floor(new Date(iso).getTime() / 1000);
  return `<t:${sec}:f>`;
}

export const BOT_DEFAULT_DUE_NOTE = "（この期限はルール上の義務ではなく、Bot既定の「目標」です）";

export function manualReviewReasonText(reason: "no_eligible" | "tie_or_below_threshold"): string {
  return reason === "no_eligible"
    ? "ハード条件（休暇中・技術者要件・実行権限レベル・上限稼働数等）を満たす候補者がいません"
    : "候補者のスコアが同点、またはタグ一致度が閾値未満です（LLMフォールバックはPhase 6以降）";
}

const PRIORITY_LABEL: Record<string, string> = { high: "高", medium: "中", low: "低" };

/**
 * 運営専用チャンネル向けタスク起票通知の表示状態（2026-09-06：起票時のみだった都度投稿を
 * 「1タスク1メッセージ」に統合。以後の状態変化は同一メッセージの編集で反映する）。
 * co_sign_pending は独立の6番目の状態として扱う。on_hold・co_sign_pendingは、たとえ本来の
 * 期限（due_at）を過ぎていても「期限超過」より優先して表示する（運営側の意図的な一時停止・
 * 相手待ちの状態であることを明示するため）。
 */
export type TaskDisplayStatus = "assigned" | "unassigned" | "on_hold" | "co_sign_pending" | "overdue" | "done";

const STATUS_DISPLAY: Record<TaskDisplayStatus, { label: string; color: number }> = {
  assigned: { label: "割り当て済み", color: 0x57f287 },
  unassigned: { label: "未割り当て", color: 0xfee75c },
  on_hold: { label: "保留", color: 0xfee75c },
  co_sign_pending: { label: "共同確認待ち", color: 0xfee75c },
  overdue: { label: "期限超過", color: 0xed4245 },
  done: { label: "完了", color: 0x99aab5 },
};

const STATUS_CONTENT: Record<TaskDisplayStatus, string> = {
  assigned: "タスクが割り当てられました。",
  unassigned: "タスクは未割り当てです。",
  on_hold: "タスクは保留中です。",
  co_sign_pending: "共同確認待ちです。",
  overdue: "タスクの期限を超過しています。",
  done: "タスクが完了しました。",
};

export function computeTaskDisplayStatus(task: Pick<TaskRow, "status" | "due_at">, nowIso: string): TaskDisplayStatus {
  if (task.status === "done") return "done";
  if (task.status === "on_hold") return "on_hold";
  if (task.status === "co_sign_pending") return "co_sign_pending";
  if (task.status === "unassigned") return "unassigned";
  if (task.due_at && task.due_at <= nowIso) return "overdue";
  return "assigned";
}

function taskAssigneeFieldValue(task: TaskRow, displayStatus: TaskDisplayStatus): string {
  if (!task.assignee) return "未割当";
  let value = `<@${task.assignee}>`;
  if (task.co_signer) {
    const waitingNote =
      displayStatus === "co_sign_pending"
        ? task.co_sign_status === "primary_done"
          ? "（担当者完了済み・共同確認者の完了待ち）"
          : task.co_sign_status === "cosigner_done"
            ? "（共同確認者完了済み・担当者の完了待ち）"
            : ""
        : "";
    value += `\n共同確認：<@${task.co_signer}>${waitingNote}`;
  }
  return value;
}

function taskDueFieldValue(task: TaskRow, displayStatus: TaskDisplayStatus): string {
  if (displayStatus === "on_hold" && task.resume_at) return `再開予定：${discordTimestamp(task.resume_at)}`;
  if (!task.due_at) return "未設定";
  return discordTimestamp(task.due_at);
}

export interface TaskChannelMessageExtra {
  confidence?: number;
  sourceMessageUrl?: string;
  /** 「要対応」欄に表示する理由（整形済みテキスト）。値がある間は displayStatus === "unassigned" の場合のみ表示する。 */
  manualReviewNote?: string | null;
}

/**
 * 運営専用チャンネル向けの「1タスク1メッセージ」本体（`tasks/notify.ts`が投稿・編集の窓口）。
 * 手動追加（`/task add`）・LLM自動検出タスクの両方をこの1関数で統一する（2026-09-06決定）。
 */
export function buildTaskChannelMessage(
  task: TaskRow,
  extra?: TaskChannelMessageExtra,
): { content: string; embed: Record<string, unknown>; displayStatus: TaskDisplayStatus } {
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const displayStatus = computeTaskDisplayStatus(task, nowIso);
  const { label, color } = STATUS_DISPLAY[displayStatus];

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: "内容", value: task.summary && task.summary.trim() ? task.summary : "（詳細説明なし）" },
    { name: "状態", value: label, inline: true },
    { name: "優先度", value: PRIORITY_LABEL[task.priority] ?? task.priority, inline: true },
    { name: "担当", value: taskAssigneeFieldValue(task, displayStatus), inline: true },
    { name: "期限", value: taskDueFieldValue(task, displayStatus), inline: true },
  ];
  if (extra?.confidence !== undefined) fields.push({ name: "確信度（LLM自動検出）", value: extra.confidence.toFixed(2), inline: true });
  if (extra?.sourceMessageUrl) fields.push({ name: "元メッセージ", value: extra.sourceMessageUrl });
  if (displayStatus === "unassigned" && extra?.manualReviewNote) {
    fields.push({ name: "要対応", value: `${extra.manualReviewNote}。\`/task add\` の再編集または手動で担当者を指定してください。` });
  }

  return {
    content: STATUS_CONTENT[displayStatus],
    embed: { title: `${task.title}（#${task.id}）`, color, fields },
    displayStatus,
  };
}

const STATUS_LABEL: Record<string, string> = {
  assigned: "割当済",
  in_progress: "対応中",
  on_hold: "保留中",
  co_sign_pending: "共同確認待ち",
};

/** `/task list`向け：本人（Ephemeral）が残っているタスクと期限を確認するためのembed（2026-09-06追加）。 */
export function buildOwnTaskListEmbed(userId: string, tasks: TaskRow[]): Record<string, unknown> {
  if (tasks.length === 0) {
    return {
      title: "あなたの残タスク",
      description: "現在、あなたに割り当てられている未完了タスクはありません。",
      color: 0x5865f2,
    };
  }
  const fields = tasks.slice(0, 25).map((t) => {
    const role = t.co_signer === userId && t.assignee !== userId ? "（共同確認者）" : "";
    const status = STATUS_LABEL[t.status] ?? t.status;
    const due = t.status === "on_hold" && t.resume_at ? `再開予定：${discordTimestamp(t.resume_at)}` : t.due_at ? `期限：${discordTimestamp(t.due_at)}` : "期限：未設定";
    return {
      name: `#${t.id} ${t.title}${role}`,
      value: `状態：${status}・${due}`,
    };
  });
  return {
    title: `あなたの残タスク（${tasks.length}件）`,
    color: 0x5865f2,
    fields,
  };
}

export function buildCoSignUnavailableNote(args: { taskId: number; title: string }): string {
  return `タスク #${args.taskId}「${args.title}」は論争性の高いタスクとして共同確認者を割り当てる方針ですが、次点候補者がいなかったため共同確認者は未割当です（§4.5.1）。運営内で手動対応を検討してください。`;
}

export function buildAssignedNotice(args: { taskId: number; title: string; assigneeMention: string; coSignerMention?: string | null; dueAt?: string | null }): string {
  const due = args.dueAt ? `\n期限：${discordTimestamp(args.dueAt)}` : "";
  const cosign = args.coSignerMention ? `\n共同確認者：${args.coSignerMention}（§4.5.1：両者の完了操作で完了になります）` : "";
  return `タスク #${args.taskId}「${args.title}」が割り当てられました（担当：${args.assigneeMention}）。${due}${cosign}`;
}

/** 担当者・共同確認者へのDM通知用embed（2026-09-06：本文のみだった通知をembed化）。 */
export function buildAssignedNoticeEmbed(args: { taskId: number; title: string; assigneeMention: string; coSignerMention?: string | null; dueAt?: string | null }): Record<string, unknown> {
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [{ name: "担当", value: args.assigneeMention, inline: true }];
  if (args.coSignerMention) {
    fields.push({ name: "共同確認者", value: `${args.coSignerMention}（§4.5.1：両者の完了操作で完了になります）`, inline: true });
  }
  if (args.dueAt) fields.push({ name: "期限", value: discordTimestamp(args.dueAt), inline: true });
  return {
    title: `タスク #${args.taskId} が割り当てられました`,
    description: args.title,
    color: 0x5865f2,
    fields,
  };
}

/** LLM検出タスク（T-B・T-C）の割当通知DM（Phase 7）。手動追加と区別できるよう検出元であることを明示する（§10-8）。 */
export function buildLlmDetectedAssignedNoticeEmbed(args: {
  taskId: number;
  title: string;
  assigneeMention: string;
  coSignerMention?: string | null;
  dueAt: string | null;
  confidence: number;
  positiveNote?: string | null;
}): Record<string, unknown> {
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: "担当", value: args.assigneeMention, inline: true },
    { name: "確信度", value: args.confidence.toFixed(2), inline: true },
  ];
  if (args.coSignerMention) {
    fields.push({ name: "共同確認者", value: `${args.coSignerMention}（§4.5.1：両者の完了操作で完了になります）`, inline: true });
  }
  if (args.dueAt) fields.push({ name: "期限", value: discordTimestamp(args.dueAt), inline: true });
  if (args.positiveNote) fields.push({ name: "AI補足", value: args.positiveNote });
  return {
    title: `【LLM自動検出】タスク #${args.taskId} が割り当てられました`,
    description: `${args.title}\nこれはLLMによる自動検出・自動割当です。内容に誤りがあれば運営内で調整してください。`,
    color: 0x5865f2,
    fields,
  };
}

export function buildReassignNotice(args: { taskId: number; title: string; fromMention: string; toMention: string | null }): string {
  if (!args.toMention) {
    return `タスク #${args.taskId}「${args.title}」の担当（${args.fromMention}）が外れましたが、次の割当候補が見つかりませんでした。未割当のまま運営の手動対応が必要です。`;
  }
  return `タスク #${args.taskId}「${args.title}」の担当が ${args.fromMention} から ${args.toMention} へ引き継がれました。`;
}

const NUDGE_LEVEL_LABEL: Record<number, string> = {
  1: "Lv1（本人へのお知らせ）",
  2: "Lv2（担当者への呼びかけ）",
  3: "Lv3（運営全体への共有）",
  4: "Lv4（自動再割当）",
};

export function buildNudgeDmMessage(args: { taskId: number; title: string; dueAt: string }): string {
  return `【督促 ${NUDGE_LEVEL_LABEL[1]}】タスク #${args.taskId}「${args.title}」の期限（${discordTimestamp(args.dueAt)}）が経過しています。ご対応をお願いします（対応済みの場合は \`/task done\` で完了報告をお願いします）。`;
}

export function buildNudgeMentionMessage(args: { taskId: number; title: string; assigneeMention: string; dueAt: string }): string {
  return `【督促 ${NUDGE_LEVEL_LABEL[2]}】${args.assigneeMention} タスク #${args.taskId}「${args.title}」の期限（${discordTimestamp(args.dueAt)}）が経過しています。状況の共有をお願いします。`;
}

export function buildNudgeBroadcastMessage(args: { taskId: number; title: string; assigneeMention: string; dueAt: string }): string {
  return `【督促 ${NUDGE_LEVEL_LABEL[3]}】タスク #${args.taskId}「${args.title}」（担当：${args.assigneeMention}）の期限（${discordTimestamp(args.dueAt)}）が大幅に経過しています。運営全体でフォローをお願いします。`;
}

export function buildNudgeReassignBroadcastMessage(args: { taskId: number; title: string; fromMention: string; toMention: string | null }): string {
  return `【督促 ${NUDGE_LEVEL_LABEL[4]}】${buildReassignNotice({ taskId: args.taskId, title: args.title, fromMention: args.fromMention, toMention: args.toMention })}`;
}

export function buildHoldResumeNotice(args: { taskId: number; title: string; assigneeMention: string }): string {
  return `タスク #${args.taskId}「${args.title}」の保留期間が終了し、${args.assigneeMention} の担当として自動的に再開（割当済）に戻りました。`;
}

export function buildVoteReminderDm(args: { voteId: number; subject: string; closesAt: string }): string {
  return `【投票リマインド】投票 #${args.voteId}「${args.subject}」の締切（${discordTimestamp(args.closesAt)}）まで残り3時間です。未投票の場合は締切までに投票してください（締切後は棄権扱いになります）。`;
}
