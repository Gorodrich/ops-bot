// ダッシュボードの定期更新（§4.8）。運営チャンネルに固定メッセージを1つ、参加者向け公開チャンネルに
// 申請受付状況のみを表示する固定メッセージを1つ、それぞれ置いて編集し続ける。

import type { Env } from "../env";
import { getApprovalTypes, getChannels } from "../settings";
import { editChannelMessage, sendChannelMessageWithComponents } from "../discord/rest";
import { getDashboardMessage, upsertDashboardMessage } from "../dashboard/repo";
import {
  buildApplicationStatusEmbed,
  buildOpsDashboardEmbed,
  type DashboardOpenItemSummary,
  type DashboardTaskSummary,
} from "../dashboard/build";
import { countCompletedSince, listIncompleteTasksByAssignee, listOverdueTasks, listUnassignedTasks } from "../tasks/repo";
import { syncOverdueTaskMessageIfNeeded } from "../tasks/notify";
import { listOpenVotes } from "../votes/repo";
import { listOpenPermissionRequests } from "../permissions/repo";
import { countConfirmedSince, countProcessingApplications, listAllProvisionalApplications } from "../kaihatsu/repo";

function toTaskSummary(t: { id: number; title: string; assignee: string | null; due_at: string | null; status: string }): DashboardTaskSummary {
  return { id: t.id, title: t.title, assignee: t.assignee, dueAt: t.due_at, status: t.status };
}

async function postOrEditDashboard(env: Env, kind: string, channelId: string, embed: Record<string, unknown>): Promise<void> {
  const existing = await getDashboardMessage(env, kind);
  if (existing && existing.channel_id === channelId) {
    await editChannelMessage(env.DISCORD_BOT_TOKEN, channelId, existing.message_id, { embeds: [embed] });
    return;
  }
  const messageId = await sendChannelMessageWithComponents(env.DISCORD_BOT_TOKEN, channelId, "", [], [embed]);
  await upsertDashboardMessage(env, kind, channelId, messageId);
}

export async function updateDashboards(env: Env): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const sevenDaysAgoIso = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const channels = await getChannels(env);

  const [unassigned, incomplete, overdue, completed7d, openVotes, openPermissions, approvalTypes] = await Promise.all([
    listUnassignedTasks(env),
    listIncompleteTasksByAssignee(env),
    listOverdueTasks(env, nowIso),
    countCompletedSince(env, sevenDaysAgoIso),
    listOpenVotes(env, "unei"),
    listOpenPermissionRequests(env),
    getApprovalTypes(env),
  ]);

  for (const task of overdue) {
    await syncOverdueTaskMessageIfNeeded(env, task, nowIso).catch((e) => console.error(`タスク #${task.id} の期限超過表示更新に失敗`, e));
  }

  const openVoteSummaries: DashboardOpenItemSummary[] = openVotes.map((v) => ({
    id: v.id,
    label: approvalTypes[v.approval_key]?.label ?? v.approval_key,
    subject: v.subject,
    closesAtOrDeadline: v.closes_at,
  }));
  const openPermissionSummaries: DashboardOpenItemSummary[] = openPermissions.map((p) => ({
    id: p.id,
    label: approvalTypes[p.approval_key]?.label ?? p.approval_key,
    subject: p.subject,
    closesAtOrDeadline: null,
  }));

  const opsEmbed = buildOpsDashboardEmbed({
    unassigned: unassigned.map(toTaskSummary),
    incompleteByAssignee: incomplete.map(toTaskSummary),
    overdue: overdue.map(toTaskSummary),
    openVotes: openVoteSummaries,
    openPermissionRequests: openPermissionSummaries,
    completedLast7Days: completed7d,
    generatedAt: nowIso,
  });
  if (channels.unei_only) {
    await postOrEditDashboard(env, "ops", channels.unei_only, opsEmbed).catch((e) => console.error("運営ダッシュボードの更新に失敗", e));
  } else {
    console.error("settings.channels.unei_only が未設定のため運営ダッシュボードを更新できません");
  }

  const [processingCount, provisional, confirmed7d] = await Promise.all([
    countProcessingApplications(env),
    listAllProvisionalApplications(env),
    countConfirmedSince(env, sevenDaysAgoIso),
  ]);
  const applicationEmbed = buildApplicationStatusEmbed({
    processingCount,
    provisionalCount: provisional.length,
    confirmedLast7Days: confirmed7d,
    generatedAt: nowIso,
  });
  if (channels.application_status) {
    await postOrEditDashboard(env, "applications", channels.application_status, applicationEmbed).catch((e) => console.error("参加者向けダッシュボードの更新に失敗", e));
  } else {
    console.error("settings.channels.application_status が未設定のため参加者向けダッシュボードを更新できません");
  }
}
