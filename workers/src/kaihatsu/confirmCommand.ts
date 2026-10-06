// 本人確認ボタン（§5.7.3：「この内容で申請する」「取り下げる」）のMESSAGE_COMPONENTハンドラ。

import type { Env } from "../env";
import { InteractionResponseType, type Interaction } from "../discord/types";
import { isPastDeadline } from "./domain";
import { getApplication, markApplicationConfirmed, transitionApplicationStatus, type ApplicationRow } from "./repo";
import { finalizeApprovedSet, releaseHoldsForResolvedApplication } from "./phase3";
import { tryResolveGroup } from "./groupResolution";
import { buildProvisionalWithdrawnOrExpiredEmbed, CONFIRM_BUTTON_CUSTOM_ID_PREFIX, WITHDRAW_BUTTON_CUSTOM_ID_PREFIX } from "./templates";
import { sendChannelMessage } from "../discord/rest";
import { getChannels } from "../settings";
import type { DeferredResult } from "../accountLinks/authoriseCommand";

function safeJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function immediate(content: string): DeferredResult {
  return {
    ack: { type: InteractionResponseType.UPDATE_MESSAGE, data: { content, components: [] } },
    followUp: async () => {},
  };
}

export async function handleKaihatsuConfirmComponent(env: Env, interaction: Interaction): Promise<DeferredResult> {
  const customId = interaction.data?.custom_id ?? "";
  // 本人確認DMはDM内のボタン操作のため、ギルド内実行時のinteraction.memberではなく
  // interaction.user（DMインタラクション）で送られてくる（§5.7.3）。
  const actorId = interaction.member?.user.id ?? interaction.user?.id;
  if (!actorId) return immediate("ユーザー情報を取得できませんでした。");

  const isConfirm = customId.startsWith(CONFIRM_BUTTON_CUSTOM_ID_PREFIX);
  const isWithdraw = customId.startsWith(WITHDRAW_BUTTON_CUSTOM_ID_PREFIX);
  if (!isConfirm && !isWithdraw) return immediate("不明な操作です。");

  const applicationId = Number(customId.slice(customId.lastIndexOf(":") + 1));
  const application = await getApplication(env, applicationId);
  if (!application) return immediate("対象の届出が見つかりません。");

  if (application.requester !== actorId) {
    return immediate("この本人確認はご自身宛てのものではありません。");
  }
  // 受付中（collecting）の同時処理グループの届出は、締切前でも本人が取り下げられる
  // （他者に追加された届出が本人の新たな届出を塞ぎ続けないようにするため・監査指摘・2026-10-07）。
  if (isWithdraw && application.status === "collecting" && application.group_key) {
    return {
      ack: { type: InteractionResponseType.UPDATE_MESSAGE, data: { content: "取り下げました。", components: [] } },
      followUp: async () => {
        await withdrawCollectingMember(env, application);
      },
    };
  }
  if (application.status !== "provisional") {
    return immediate("この届出は既に処理済みです。");
  }
  if (isPastDeadline(new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), application.provisional_until)) {
    return immediate("本人確認の期限を過ぎています。");
  }

  if (isWithdraw) {
    return {
      ack: { type: InteractionResponseType.UPDATE_MESSAGE, data: { content: "取り下げました。", components: [] } },
      followUp: async () => {
        await handleWithdrawOrExpire(env, application, "withdrawn");
      },
    };
  }

  return {
    ack: { type: InteractionResponseType.UPDATE_MESSAGE, data: { content: "確認を受け付けました。処理しています…", components: [] } },
    followUp: async () => {
      // ack時点の読み取りから followUp までの間に、2回目の確認・取り下げ・期限切れが先に遷移させている
      // 場合がある。遷移に勝った場合のみ以降の処理を行う（claimの二重登録を防ぐ・監査指摘・2026-10-07）。
      if (!(await markApplicationConfirmed(env, application.id))) return;
      if (application.group_key) {
        await tryResolveGroup(env, application.group_key);
      } else {
        const payload = safeJsonParse<{ ctResult: Parameters<typeof finalizeApprovedSet>[2]; previousClaimId: number | null }>(application.payload);
        if (payload?.ctResult) {
          await finalizeApprovedSet(env, application, payload.ctResult, payload.previousClaimId ?? null);
        }
      }
    },
  };
}

async function withdrawCollectingMember(env: Env, application: ApplicationRow): Promise<void> {
  const res = await env.DB.prepare("UPDATE applications SET status = 'withdrawn' WHERE id = ? AND status = 'collecting'")
    .bind(application.id)
    .run();
  if ((res.meta.changes ?? 0) !== 1) return; // 締切・失効等で既に状態が変わっていた
  await tryResolveGroup(env, application.group_key as string);
}

export async function handleWithdrawOrExpire(env: Env, application: ApplicationRow, reason: "withdrawn" | "expired"): Promise<void> {
  // 確認（confirmed）との競合で負けた場合は何もしない（確認済みの届出を取り下げ扱いにしない）。
  if (!(await transitionApplicationStatus(env, application.id, ["provisional"], reason))) return;

  if (application.group_key) {
    await tryResolveGroup(env, application.group_key);
    return;
  }

  const channels = await getChannels(env);
  if (channels.kaihatsu_ryo) {
    const embed = buildProvisionalWithdrawnOrExpiredEmbed({
      mentionDiscordId: application.requester,
      mcName: application.owner_mc_name ?? "",
      representativeMention: `<@${application.submitted_by ?? application.requester}>`,
      reason,
    });
    await sendChannelMessage(env.DISCORD_BOT_TOKEN, channels.kaihatsu_ryo, `<@${application.requester}>`, [embed]).catch(() => {});
  }

  await releaseHoldsForResolvedApplication(env, application.id, "released");
}
