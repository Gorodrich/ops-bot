// 運営による撤回（§5.7.2）：承認から24時間以内、運営者であれば誰か1人でもボタンを押せば撤回できる。
// 撤回理由はモーダル（テキスト入力）で入力させ、撤回者名・理由とともに申請者へ通知する。

import type { Env } from "../env";
import { InteractionResponseType, modalFieldValue, type Interaction } from "../discord/types";
import { resolveUneiActor } from "../staff/subaccountEligibility";
import { isPastDeadline } from "./domain";
import { getApplication, supersedeClaim, updateApplicationStatus } from "./repo";
import { enqueueJob } from "../jobs/queue";
import { writeAuditLog } from "../auditLog";
import { sendDirectMessage } from "../discord/rest";
import { buildRevokedNoticeEmbed, REVOKE_BUTTON_CUSTOM_ID_PREFIX, REVOKE_MODAL_CUSTOM_ID_PREFIX, REVOKE_REASON_FIELD_ID } from "./templates";
import type { DeferredResult } from "../accountLinks/authoriseCommand";

const EPHEMERAL_FLAG = 1 << 6;

function immediate(content: string): DeferredResult {
  return {
    ack: { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content, flags: EPHEMERAL_FLAG } },
    followUp: async () => {},
  };
}

function safeJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** 撤回ボタン押下 → 理由入力モーダルを開く（MESSAGE_COMPONENT）。 */
export async function handleRevokeButton(env: Env, interaction: Interaction): Promise<DeferredResult> {
  const resolved = await resolveUneiActor(env, interaction.member);
  if (!resolved.ok) return immediate(resolved.message);

  const customId = interaction.data?.custom_id ?? "";
  const applicationId = customId.slice(REVOKE_BUTTON_CUSTOM_ID_PREFIX.length);
  const application = await getApplication(env, Number(applicationId));
  if (!application || application.status !== "approved" || application.kind !== "kaihatsu_set") {
    return immediate("この届出は撤回できません（既に処理済み、または対象外です）。");
  }
  if (isPastDeadline(new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), application.revocable_until)) {
    return immediate("撤回可能期間（24時間）を過ぎています。");
  }

  return {
    ack: {
      type: InteractionResponseType.MODAL,
      data: {
        custom_id: `${REVOKE_MODAL_CUSTOM_ID_PREFIX}${applicationId}`,
        title: "撤回理由の入力",
        components: [
          {
            type: 1,
            components: [
              {
                type: 4,
                custom_id: REVOKE_REASON_FIELD_ID,
                style: 2,
                label: "撤回理由",
                required: true,
                max_length: 500,
              },
            ],
          },
        ],
      },
    },
    followUp: async () => {},
  };
}

/** モーダル送信（MODAL_SUBMIT） → 撤回を確定する。 */
export async function handleRevokeModalSubmit(env: Env, interaction: Interaction): Promise<DeferredResult> {
  const resolved = await resolveUneiActor(env, interaction.member);
  if (!resolved.ok) return immediate(resolved.message);
  const actorId = resolved.actorId;

  const customId = interaction.data?.custom_id ?? "";
  const applicationId = Number(customId.slice(REVOKE_MODAL_CUSTOM_ID_PREFIX.length));
  const reason = modalFieldValue(interaction, REVOKE_REASON_FIELD_ID) ?? "（理由未入力）";

  const application = await getApplication(env, applicationId);
  if (!application || application.status !== "approved") {
    return immediate("この届出は既に処理済みのため撤回できません。");
  }
  if (isPastDeadline(new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), application.revocable_until)) {
    return immediate("撤回可能期間（24時間）を過ぎています。");
  }

  return {
    ack: { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: `撤回しました（理由：${reason}）。手動審査タスクを起票しました。`, flags: EPHEMERAL_FLAG } },
    followUp: async () => {
      const payload = safeJsonParse<{ claim_id?: number }>(application.payload);
      if (payload?.claim_id) {
        await supersedeClaim(env, payload.claim_id, "superseded"); // §5.7.2：撤回時点で承認の効力を止める（手動審査に切替）
      }
      await updateApplicationStatus(env, application.id, "revoked");

      await env.DB.prepare(
        `INSERT INTO revocations (target_type, target_id, revoked_by, reason, revoked_at)
         VALUES ('application', ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
      )
        .bind(application.id, actorId, reason)
        .run();

      await env.DB.prepare(
        `INSERT INTO tasks (type, title, summary, related_rule, status, priority, created_at)
         VALUES ('T-A', ?, ?, '§5.7.2', 'unassigned', 'high', strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
      )
        .bind(
          `個人開発領の撤回後の手動審査：${application.owner_mc_name ?? application.requester}`,
          `運営(<@${actorId}>)により撤回されました（理由：${reason}）。内容を確認のうえ、類型A秘密投票（§5.2）で最終決定してください。`,
        )
        .run();

      if (application.owner_mc_name) {
        await enqueueJob(env, "dynmap_sync", { op: "remove", mc_name: application.owner_mc_name }).catch(() => {});
      }

      const revokedEmbed = buildRevokedNoticeEmbed({ mcName: application.owner_mc_name ?? "", revokedByMention: `<@${actorId}>`, reason });
      await sendDirectMessage(env.DISCORD_BOT_TOKEN, application.requester, "", [revokedEmbed]).catch(() => {});

      await writeAuditLog(env, {
        actor: actorId,
        action: "kaihatsu_set_revoked",
        target: String(application.id),
        detail: { mc_name: application.owner_mc_name, reason },
      });
    },
  };
}
