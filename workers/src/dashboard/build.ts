// ダッシュボード表示内容の組み立て（§4.8）。DB読み出しから分離した純粋関数（テスト容易性のため）。

import { discordTimestamp } from "../tasks/templates";

export interface DashboardTaskSummary {
  id: number;
  title: string;
  assignee: string | null;
  dueAt: string | null;
  status: string;
}

export interface DashboardOpenItemSummary {
  id: number;
  label: string;
  subject: string;
  closesAtOrDeadline: string | null;
}

export interface OpsDashboardData {
  unassigned: DashboardTaskSummary[];
  incompleteByAssignee: DashboardTaskSummary[];
  overdue: DashboardTaskSummary[];
  openVotes: DashboardOpenItemSummary[];
  openPermissionRequests: DashboardOpenItemSummary[];
  completedLast7Days: number;
  generatedAt: string;
}

function groupByAssignee(tasks: DashboardTaskSummary[]): Map<string, DashboardTaskSummary[]> {
  const map = new Map<string, DashboardTaskSummary[]>();
  for (const t of tasks) {
    const key = t.assignee ?? "unknown";
    const list = map.get(key) ?? [];
    list.push(t);
    map.set(key, list);
  }
  return map;
}

export function buildOpsDashboardEmbed(data: OpsDashboardData): Record<string, unknown> {
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];

  fields.push({
    name: `未割当タスク（${data.unassigned.length}件）`,
    value: data.unassigned.length === 0 ? "なし" : data.unassigned.slice(0, 10).map((t) => `#${t.id} ${t.title}`).join("\n"),
  });

  const byAssignee = groupByAssignee(data.incompleteByAssignee);
  const assigneeLines: string[] = [];
  for (const [assignee, tasks] of byAssignee) {
    const mention = assignee === "unknown" ? "（担当者不明）" : `<@${assignee}>`;
    assigneeLines.push(`${mention}：${tasks.length}件（${tasks.map((t) => `#${t.id}`).join(", ")}）`);
  }
  fields.push({
    name: `担当者別 未完了タスク（${data.incompleteByAssignee.length}件）`,
    value: assigneeLines.length === 0 ? "なし" : assigneeLines.slice(0, 10).join("\n"),
  });

  fields.push({
    name: `期限超過タスク（${data.overdue.length}件）`,
    value:
      data.overdue.length === 0
        ? "なし"
        : data.overdue
            .slice(0, 10)
            .map((t) => `#${t.id} ${t.title}（担当：${t.assignee ? `<@${t.assignee}>` : "未割当"}・期限：${t.dueAt ? discordTimestamp(t.dueAt) : "未設定"}）`)
            .join("\n"),
  });

  const voteLines = data.openVotes.map((v) => `#${v.id} ${v.label}：${v.subject}${v.closesAtOrDeadline ? `（締切 ${discordTimestamp(v.closesAtOrDeadline)}）` : ""}`);
  const permLines = data.openPermissionRequests.map((p) => `#${p.id} ${p.label}：${p.subject}`);
  fields.push({
    name: `進行中の投票・許可要請（${data.openVotes.length + data.openPermissionRequests.length}件）`,
    value: [...voteLines, ...permLines].length === 0 ? "なし" : [...voteLines, ...permLines].slice(0, 10).join("\n"),
  });

  fields.push({ name: "直近7日の完了件数", value: `${data.completedLast7Days}件`, inline: true });

  return {
    title: "運営タスク・ダッシュボード",
    description: `最終更新：${discordTimestamp(data.generatedAt)}`,
    color: 0x5865f2,
    fields,
  };
}

export interface ApplicationStatusData {
  processingCount: number;
  provisionalCount: number;
  confirmedLast7Days: number;
  generatedAt: string;
}

/** 参加者向け：申請の受付状況のみを表示する（運営者名・内部メモ等は含めない・§4.8）。 */
export function buildApplicationStatusEmbed(data: ApplicationStatusData): Record<string, unknown> {
  return {
    title: "個人開発領：申請受付状況",
    description: `最終更新：${discordTimestamp(data.generatedAt)}`,
    color: 0x57f287,
    fields: [
      { name: "審査中の届出", value: `${data.processingCount}件`, inline: true },
      { name: "本人確認待ち（仮承認中）", value: `${data.provisionalCount}件`, inline: true },
      { name: "直近7日の正式承認", value: `${data.confirmedLast7Days}件`, inline: true },
    ],
  };
}
