// /subaccount link・unlink・list（運営サブ垢の連携・2026-09-07決定）。
// サブ垢（「運営サブ垢」ロール保有アカウント）をメイン垢に連携し、以後サブ垢から実行された
// 運営コマンドはメイン垢が行ったものとして扱う（resolveUneiActor経由）。
// 連携にはサブ垢側での本人確認（DMのボタン操作）を要する。

import type { Env } from "../env";
import { type CommandOption, type Interaction, InteractionResponseType, optionValue } from "../discord/types";
import { getDeadlines, getGuildId, getRoles } from "../settings";
import { hasRole } from "../accountLinks/eligibility";
import { getGuildMember, sendDirectMessageWithComponents, sendFollowupMessage, EPHEMERAL_FLAG } from "../discord/rest";
import { addHoursIso } from "../votes/domain";
import { isPastDeadline } from "../kaihatsu/domain";
import { writeAuditLog } from "../auditLog";
import { deleteSubaccountLink, getSubaccountLink, listSubaccountLinksByMain, upsertPendingLink, confirmLink } from "./subaccountRepo";
import type { DeferredResult } from "../accountLinks/authoriseCommand";

const CONFIRM_CUSTOM_ID = "subaccount:confirm";
const REJECT_CUSTOM_ID = "subaccount:reject";

function immediate(content: string): DeferredResult {
  return {
    ack: { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content, flags: EPHEMERAL_FLAG } },
    followUp: async () => {},
  };
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function requireRealUnei(env: Env, interaction: Interaction): Promise<{ operatorId: string } | { error: DeferredResult }> {
  const operator = interaction.member;
  if (!operator) return { error: immediate("このコマンドはサーバー内でのみ実行できます。") };
  const roles = await getRoles(env);
  if (!hasRole(operator.roles, roles.unei)) return { error: immediate("このコマンドは運営者本人（メイン垢）のみ実行できます。") };
  return { operatorId: operator.user.id };
}

export async function handleSubaccountLink(env: Env, interaction: Interaction, options: CommandOption[]): Promise<DeferredResult> {
  const gate = await requireRealUnei(env, interaction);
  if ("error" in gate) return gate.error;
  const operatorId = gate.operatorId;

  const targetUserId = optionValue(options, "user");
  if (!targetUserId) return immediate("user オプションが必要です。");
  if (targetUserId === operatorId) return immediate("自分自身を連携対象にはできません。");

  return {
    ack: { type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: EPHEMERAL_FLAG } },
    followUp: async () => {
      const [roles, guildId] = await Promise.all([getRoles(env), getGuildId(env)]);
      const targetMember = await getGuildMember(env.DISCORD_BOT_TOKEN, guildId, targetUserId).catch(() => null);
      if (!targetMember) {
        await sendFollowupMessage(env.DISCORD_APP_ID, interaction.token, { content: "対象者がこのサーバーに見つかりませんでした。", flags: EPHEMERAL_FLAG });
        return;
      }
      if (!hasRole(targetMember.roles, roles.unei_sub)) {
        await sendFollowupMessage(env.DISCORD_APP_ID, interaction.token, {
          content: "対象は「運営サブ垢」ロールを持っていません。連携できるのは同ロールを付与済みのアカウントのみです。",
          flags: EPHEMERAL_FLAG,
        });
        return;
      }

      const existing = await getSubaccountLink(env, targetUserId);
      if (existing?.status === "confirmed") {
        const content = existing.main_discord_id === operatorId
          ? "このサブ垢は既にあなたのメイン垢と連携済みです。"
          : "このサブ垢は既に他の運営者に連携済みです。";
        await sendFollowupMessage(env.DISCORD_APP_ID, interaction.token, { content, flags: EPHEMERAL_FLAG });
        return;
      }
      if (existing?.status === "pending" && existing.main_discord_id !== operatorId) {
        await sendFollowupMessage(env.DISCORD_APP_ID, interaction.token, {
          content: "このサブ垢は既に別の運営者からの連携リクエストが本人確認待ちです。",
          flags: EPHEMERAL_FLAG,
        });
        return;
      }

      const deadlines = await getDeadlines(env);
      const expiresAt = addHoursIso(nowIso(), deadlines.subaccount_confirm_hours);
      await upsertPendingLink(env, { subDiscordId: targetUserId, mainDiscordId: operatorId, expiresAt, createdBy: operatorId });

      try {
        await sendDirectMessageWithComponents(
          env.DISCORD_BOT_TOKEN,
          targetUserId,
          `<@${operatorId}> からの運営サブ垢連携リクエストです。承認すると、このアカウントで実行した運営コマンド（投票・記名許可等）は ` +
            `<@${operatorId}>（メイン垢）が行ったものとして記録されます。${deadlines.subaccount_confirm_hours}時間以内に回答してください。`,
          [
            {
              type: 1,
              components: [
                { type: 2, style: 3, label: "許可", custom_id: CONFIRM_CUSTOM_ID },
                { type: 2, style: 4, label: "拒否", custom_id: REJECT_CUSTOM_ID },
              ],
            },
          ],
        );
      } catch (e) {
        console.error("subaccount link DM failed", e);
        await sendFollowupMessage(env.DISCORD_APP_ID, interaction.token, {
          content: "対象者へのDM送信に失敗しました（DMを許可していない可能性があります）。",
          flags: EPHEMERAL_FLAG,
        });
        return;
      }

      await writeAuditLog(env, { actor: operatorId, action: "subaccount_link_requested", target: targetUserId });
      await sendFollowupMessage(env.DISCORD_APP_ID, interaction.token, {
        content: `<@${targetUserId}> に連携の本人確認DMを送信しました。回答をお待ちください。`,
        flags: EPHEMERAL_FLAG,
      });
    },
  };
}

export async function handleSubaccountUnlink(env: Env, interaction: Interaction, options: CommandOption[]): Promise<DeferredResult> {
  const gate = await requireRealUnei(env, interaction);
  if ("error" in gate) return gate.error;
  const operatorId = gate.operatorId;

  const targetUserId = optionValue(options, "user");
  if (!targetUserId) return immediate("user オプションが必要です。");

  return {
    ack: { type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: EPHEMERAL_FLAG } },
    followUp: async () => {
      const deleted = await deleteSubaccountLink(env, targetUserId, operatorId);
      if (!deleted) {
        await sendFollowupMessage(env.DISCORD_APP_ID, interaction.token, {
          content: "該当する連携が見つかりませんでした（自分のメイン垢に連携されたサブ垢のみ解除できます）。",
          flags: EPHEMERAL_FLAG,
        });
        return;
      }
      await writeAuditLog(env, { actor: operatorId, action: "subaccount_unlinked", target: targetUserId });
      await sendFollowupMessage(env.DISCORD_APP_ID, interaction.token, { content: `<@${targetUserId}> との連携を解除しました。`, flags: EPHEMERAL_FLAG });
    },
  };
}

export async function handleSubaccountList(env: Env, interaction: Interaction): Promise<DeferredResult> {
  const gate = await requireRealUnei(env, interaction);
  if ("error" in gate) return gate.error;

  const links = await listSubaccountLinksByMain(env, gate.operatorId);
  if (links.length === 0) return immediate("連携済みのサブ垢はありません。");

  const lines = links.map((l) => `<@${l.sub_discord_id}>：${l.status === "confirmed" ? "連携済み" : "本人確認待ち"}`);
  return immediate(["【連携中の運営サブ垢】", ...lines].join("\n"));
}

/** 本人確認DMの許可／拒否ボタン（MESSAGE_COMPONENT・DM上のためinteraction.userで届く）。 */
export async function handleSubaccountConfirmComponent(env: Env, interaction: Interaction): Promise<DeferredResult> {
  const actorId = interaction.user?.id ?? interaction.member?.user.id;
  if (!actorId) return immediate("ユーザー情報を取得できませんでした。");

  const customId = interaction.data?.custom_id ?? "";
  const isConfirm = customId === CONFIRM_CUSTOM_ID;
  const isReject = customId === REJECT_CUSTOM_ID;
  if (!isConfirm && !isReject) return immediate("不明な操作です。");

  const updateMessage = (content: string): DeferredResult => ({
    ack: { type: InteractionResponseType.UPDATE_MESSAGE, data: { content, components: [] } },
    followUp: async () => {},
  });

  const link = await getSubaccountLink(env, actorId);
  if (!link || link.status !== "pending") return updateMessage("この連携リクエストは既に処理済み、または見つかりません。");
  if (isPastDeadline(nowIso(), link.expires_at)) {
    await deleteSubaccountLink(env, actorId, link.main_discord_id);
    return updateMessage("本人確認の期限を過ぎています。メイン垢から /subaccount link を再実行してください。");
  }

  if (isReject) {
    await deleteSubaccountLink(env, actorId, link.main_discord_id);
    await writeAuditLog(env, { actor: actorId, action: "subaccount_link_rejected", target: link.main_discord_id });
    return updateMessage("連携を拒否しました。");
  }

  await confirmLink(env, actorId);
  await writeAuditLog(env, { actor: actorId, action: "subaccount_link_confirmed", target: link.main_discord_id });
  return updateMessage(
    `連携を承認しました。以後、このアカウントで実行した運営コマンドは <@${link.main_discord_id}>（メイン垢）が行ったものとして扱われます。`,
  );
}
