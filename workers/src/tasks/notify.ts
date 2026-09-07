// 運営専用チャンネル向けタスク起票通知の「1タスク1メッセージ」窓口（2026-09-06追加）。
// 起票時に1通投稿し、以後の状態変化（割当・辞退・保留・完了・期限超過等）は同一メッセージを
// PATCHで書き換える。呼び出し側はDB更新後にこの関数を呼ぶだけでよい（表示ロジックはtemplates.tsに集約）。

import type { Env } from "../env";
import { getChannels, getGuildId } from "../settings";
import { editChannelMessage, sendChannelMessage, sendChannelMessageWithComponents } from "../discord/rest";
import { getTask, setTaskNotifyMessage, updateTaskNotifyStatus, type TaskRow } from "./repo";
import { buildTaskChannelMessage, computeTaskDisplayStatus, type TaskChannelMessageExtra } from "./templates";

export async function syncTaskMessage(env: Env, taskId: number, extra?: TaskChannelMessageExtra): Promise<void> {
  const task = await getTask(env, taskId);
  if (!task) return;
  const { content, embed, displayStatus } = buildTaskChannelMessage(task, extra);

  if (task.notify_channel_id && task.notify_message_id) {
    await editChannelMessage(env.DISCORD_BOT_TOKEN, task.notify_channel_id, task.notify_message_id, { content, embeds: [embed] });
    await updateTaskNotifyStatus(env, taskId, displayStatus);
    return;
  }

  const channels = await getChannels(env);
  if (!channels.unei_only) {
    console.error("settings.channels.unei_only が未設定のためタスクメッセージを投稿できません");
    return;
  }
  const messageId = await sendChannelMessageWithComponents(env.DISCORD_BOT_TOKEN, channels.unei_only, content, [], [embed]);
  await setTaskNotifyMessage(env, taskId, channels.unei_only, messageId, displayStatus);
}

/**
 * ダッシュボード更新Cron（10分毎）と同時に行う期限超過判定専用（decisions.md参照）。
 * 既に「期限超過」表示済みのタスクへ毎回再編集を繰り返さないよう、直近の表示状態
 * （notify_last_status）を見て遷移時のみ編集する。
 */
export async function syncOverdueTaskMessageIfNeeded(env: Env, task: TaskRow, nowIso: string): Promise<void> {
  if (computeTaskDisplayStatus(task, nowIso) !== "overdue") return;
  if (task.notify_last_status === "overdue") return;
  await syncTaskMessage(env, task.id);
}

/**
 * タスクメッセージの編集だけでは見逃されうる「要対応」案件（自動割当失敗・Lv4自動再割当不能等）向けの
 * 短いプッシュ通知（編集は無音のため・2026-09-06決定）。タスクメッセージへのジャンプリンクを添える。
 */
export async function postTaskAttentionPush(env: Env, task: TaskRow, note: string): Promise<void> {
  const channels = await getChannels(env);
  if (!channels.unei_only) return;
  const guildId = await getGuildId(env).catch(() => null);
  const link =
    guildId && task.notify_channel_id && task.notify_message_id
      ? `https://discord.com/channels/${guildId}/${task.notify_channel_id}/${task.notify_message_id}`
      : null;
  const content = `【要対応】タスク #${task.id}「${task.title}」：${note}${link ? `\n${link}` : ""}`;
  await sendChannelMessage(env.DISCORD_BOT_TOKEN, channels.unei_only, content).catch((e) => console.error("要対応プッシュ通知の送信に失敗", e));
}
