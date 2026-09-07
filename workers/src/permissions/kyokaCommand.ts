// /kyoka（記名許可要請の作成・§5.4）と、OK/NG/取り下げボタン（MESSAGE_COMPONENT）。
// /umetate（§5.4.1）もこのボタンハンドラを共用する（同じ記名許可の仕組みのため）。

import type { Env } from "../env";
import { InteractionResponseType, type CommandOption, type Interaction, optionValue } from "../discord/types";
import { getApprovalTypes, getChannels } from "../settings";
import { resolveUneiActor } from "../staff/subaccountEligibility";
import { sendChannelMessageWithComponents, editChannelMessage, sendDirectMessage, sendFollowupMessage, EPHEMERAL_FLAG } from "../discord/rest";
import { writeAuditLog } from "../auditLog";
import { isPermissionApproved } from "./domain";
import {
  getPermissionRequest,
  insertPermissionRequest,
  listSignatures,
  markPermissionRequestDecided,
  setPermissionRequestMessage,
  setPermissionRequestTaskId,
  upsertSignature,
  type PermissionRequestRow,
  type SignatureRow,
} from "./repo";
import {
  buildPermissionApprovedDmEmbed,
  buildPermissionButtonRow,
  buildPermissionRequestEmbed,
  PERMISSION_MESSAGES,
  PERMISSION_NG_BUTTON_PREFIX,
  PERMISSION_OK_BUTTON_PREFIX,
  PERMISSION_WITHDRAW_BUTTON_PREFIX,
} from "./templates";
import type { DeferredResult } from "../accountLinks/authoriseCommand";

function immediate(content: string): DeferredResult {
  return {
    ack: { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content, flags: EPHEMERAL_FLAG } },
    followUp: async () => {},
  };
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * 記名許可要請を作成する共通処理（/kyoka・/umetate 両方から呼ぶ）。
 * approvalKey は settings.approval_types のうち method:"B" のものに限る。
 */
export async function createPermissionRequest(
  env: Env,
  interaction: Interaction,
  args: { approvalKey: string; subject: string; description: string | null; imageUrl: string | null },
): Promise<DeferredResult> {
  const operator = interaction.member;
  if (!operator) return immediate("このコマンドはサーバー内でのみ実行できます。");

  const approvalTypes = await getApprovalTypes(env);
  const entry = approvalTypes[args.approvalKey];
  if (!entry) return immediate(PERMISSION_MESSAGES.unknownApprovalKey);
  if (entry.method !== "B") return immediate(PERMISSION_MESSAGES.methodAMismatch);
  if (!entry.required_count) return immediate(PERMISSION_MESSAGES.unknownApprovalKey);

  return {
    ack: { type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: EPHEMERAL_FLAG } },
    followUp: async () => {
      const channels = await getChannels(env);
      const channelId = channels.unei_only;
      if (!channelId) {
        await sendFollowupMessage(env.DISCORD_APP_ID, interaction.token, {
          content: "運営専用チャンネル（settings.channels.unei_only）が未設定のため投稿できませんでした。",
          flags: EPHEMERAL_FLAG,
        });
        return;
      }

      const requestId = await insertPermissionRequest(env, {
        approvalKey: args.approvalKey,
        subject: args.subject,
        requesterId: operator.user.id,
        requiredCount: entry.required_count as number,
        description: args.description,
        imageUrl: args.imageUrl,
      });

      const embed = buildPermissionRequestEmbed({
        requestId,
        label: entry.label,
        subject: args.subject,
        requesterMention: `<@${operator.user.id}>`,
        requiredCount: entry.required_count as number,
        description: args.description,
        imageUrl: args.imageUrl,
        signatures: [],
        status: "open",
      });
      const messageId = await sendChannelMessageWithComponents(
        env.DISCORD_BOT_TOKEN,
        channelId,
        "",
        buildPermissionButtonRow(requestId, operator.user.id),
        [embed],
      );
      await setPermissionRequestMessage(env, requestId, channelId, messageId);

      const taskRes = await env.DB.prepare(
        `INSERT INTO tasks (type, title, summary, related_rule, requester, status, priority, created_at, assigned_at)
         VALUES ('T-E', ?, ?, '§5.4', ?, 'in_progress', 'medium', ?, ?)`,
      )
        .bind(`記名許可 #${requestId}：${entry.label}`, args.subject, operator.user.id, nowIso(), nowIso())
        .run();
      await setPermissionRequestTaskId(env, requestId, Number(taskRes.meta.last_row_id));

      await writeAuditLog(env, {
        actor: operator.user.id,
        action: "permission_request_created",
        target: String(requestId),
        detail: { approvalKey: args.approvalKey, subject: args.subject },
      });

      await sendFollowupMessage(env.DISCORD_APP_ID, interaction.token, { content: `記名許可要請 #${requestId} を作成しました。`, flags: EPHEMERAL_FLAG });
    },
  };
}

export async function handleKyoka(env: Env, interaction: Interaction, options: CommandOption[]): Promise<DeferredResult> {
  const approvalKey = optionValue(options, "kind");
  const subject = optionValue(options, "subject");
  const description = optionValue(options, "description") ?? null;
  if (!approvalKey || !subject) return immediate("kind・subject オプションが必要です。");
  return createPermissionRequest(env, interaction, { approvalKey, subject, description, imageUrl: null });
}

/** OK/NG/取り下げボタン（/kyoka・/umetate 共用）。 */
export async function handlePermissionButton(env: Env, interaction: Interaction): Promise<DeferredResult> {
  const actorId = interaction.member?.user.id;
  if (!actorId) return immediate("このボタンはサーバー内でのみ使用できます。");

  const customId = interaction.data?.custom_id ?? "";
  const isOk = customId.startsWith(PERMISSION_OK_BUTTON_PREFIX);
  const isNg = customId.startsWith(PERMISSION_NG_BUTTON_PREFIX);
  const isWithdraw = customId.startsWith(PERMISSION_WITHDRAW_BUTTON_PREFIX);
  if (!isOk && !isNg && !isWithdraw) return immediate("不明な操作です。");

  const prefix = isOk ? PERMISSION_OK_BUTTON_PREFIX : isNg ? PERMISSION_NG_BUTTON_PREFIX : PERMISSION_WITHDRAW_BUTTON_PREFIX;
  const requestId = Number(customId.slice(prefix.length));
  const request = await getPermissionRequest(env, requestId);
  if (!request) return immediate("対象の要請が見つかりません。");
  if (request.status !== "open") return immediate(PERMISSION_MESSAGES.alreadyDecided);

  if (isWithdraw) {
    if (request.requester_id !== actorId) return immediate(PERMISSION_MESSAGES.onlyRequesterCanWithdraw);
    await markPermissionRequestDecided(env, requestId, "withdrawn");
    return finishWithUpdatedPost(env, request, "withdrawn", actorId, "permission_request_withdrawn");
  }

  const resolved = await resolveUneiActor(env, interaction.member);
  if (!resolved.ok) return immediate(resolved.message);
  const signerId = resolved.actorId;

  await upsertSignature(env, requestId, signerId, isOk ? "ok" : "ng", null);
  const signatures = await listSignatures(env, requestId);
  const okCount = signatures.filter((s) => s.decision === "ok").length;
  const approved = isPermissionApproved(okCount, request.required_count);
  if (approved) await markPermissionRequestDecided(env, requestId, "approved");

  return finishWithUpdatedPost(env, request, approved ? "approved" : "open", signerId, isOk ? "permission_signed_ok" : "permission_signed_ng", signatures);
}

async function finishWithUpdatedPost(
  env: Env,
  request: PermissionRequestRow,
  newStatus: "open" | "approved" | "withdrawn",
  actorId: string,
  auditAction: string,
  signaturesArg?: SignatureRow[],
): Promise<DeferredResult> {
  const approvalTypes = await getApprovalTypes(env);
  const entry = approvalTypes[request.approval_key];

  return {
    ack: { type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE },
    followUp: async () => {
      const signatures = signaturesArg ?? (await listSignatures(env, request.id));
      const embed = buildPermissionRequestEmbed({
        requestId: request.id,
        label: entry?.label ?? request.approval_key,
        subject: request.subject,
        requesterMention: `<@${request.requester_id}>`,
        requiredCount: request.required_count,
        description: request.description,
        imageUrl: request.image_url,
        signatures,
        status: newStatus,
      });
      if (request.channel_id && request.message_id) {
        await editChannelMessage(env.DISCORD_BOT_TOKEN, request.channel_id, request.message_id, {
          embeds: [embed],
          components: newStatus === "open" ? buildPermissionButtonRow(request.id, request.requester_id) : [],
        }).catch((e) => console.error("permission post edit failed", e));
      }

      if (newStatus === "approved") {
        await env.DB.prepare("UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ?")
          .bind(new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), request.task_id)
          .run();
        const approvedDmEmbed = buildPermissionApprovedDmEmbed({
          label: entry?.label ?? request.approval_key,
          subject: request.subject,
          description: request.description,
          imageUrl: request.image_url,
        });
        await sendDirectMessage(env.DISCORD_BOT_TOKEN, request.requester_id, "", [approvedDmEmbed]).catch(() => {});
      }

      await writeAuditLog(env, { actor: actorId, action: auditAction, target: String(request.id) });
    },
  };
}
