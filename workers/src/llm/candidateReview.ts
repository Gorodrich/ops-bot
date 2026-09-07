// LLM検出候補（confidence閾値未満）の採用／却下ボタン（Phase 7・§7.3）。
// C-3：Botは採否の判断を代行しない。運営者ロールを持つ者の操作のみを起点とする。

import type { Env } from "../env";
import { InteractionResponseType, type Interaction } from "../discord/types";
import { resolveUneiActor } from "../staff/subaccountEligibility";
import { EPHEMERAL_FLAG, editChannelMessage } from "../discord/rest";
import { writeAuditLog } from "../auditLog";
import { autoAssign } from "../tasks/autoAssign";
import { isValidTag } from "../staff/tags";
import { getDetectionById, materializeDetectedTask, type LlmShadowDetectionRow } from "./detectionCompletion";
import { buildLlmCandidateReviewEmbed, LLM_CANDIDATE_ACCEPT_BUTTON_PREFIX, LLM_CANDIDATE_REJECT_BUTTON_PREFIX } from "./templates";
import type { DeferredResult } from "../accountLinks/authoriseCommand";

function immediate(content: string): DeferredResult {
  return {
    ack: { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content, flags: EPHEMERAL_FLAG } },
    followUp: async () => {},
  };
}

function noOp(): DeferredResult {
  return { ack: { type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE }, followUp: async () => {} };
}

export async function handleLlmCandidateButton(env: Env, interaction: Interaction): Promise<DeferredResult> {
  const resolved = await resolveUneiActor(env, interaction.member);
  if (!resolved.ok) return immediate(resolved.message);
  const actorId = resolved.actorId;

  const customId = interaction.data?.custom_id ?? "";
  const isAccept = customId.startsWith(LLM_CANDIDATE_ACCEPT_BUTTON_PREFIX);
  const isReject = customId.startsWith(LLM_CANDIDATE_REJECT_BUTTON_PREFIX);
  if (!isAccept && !isReject) return immediate("不明な操作です。");

  const prefix = isAccept ? LLM_CANDIDATE_ACCEPT_BUTTON_PREFIX : LLM_CANDIDATE_REJECT_BUTTON_PREFIX;
  const detectionId = Number(customId.slice(prefix.length));
  const detection = await getDetectionById(env, detectionId);
  if (!detection) return immediate("対象の検出結果が見つかりません。");
  if (detection.status !== "candidate_pending") return noOp(); // 二重押下等：既に決着済みのため何もしない

  if (isReject) {
    await env.DB.prepare(
      `UPDATE llm_shadow_detections SET status = 'candidate_rejected', decided_by = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`,
    )
      .bind(actorId, detectionId)
      .run();
    await writeAuditLog(env, { actor: actorId, action: "llm_candidate_rejected", target: String(detectionId) });
    return finishCandidatePost(env, detection, `却下（<@${actorId}>）`);
  }

  const requiredTags = (JSON.parse(detection.required_tags || "[]") as string[]).filter(isValidTag);
  const outcome = await autoAssign(env, {
    requiredTags,
    requiresTechnician: false,
    requiredPermissionTier: null,
    isControversial: requiredTags.includes("controversial_review"),
  });

  // 運営が既に採用の意思決定を行っているため、スコア同点・閾値未満の場合もLLMへ再照会せず、
  // 未割当タスクとして起票し運営内の手動割当に委ねる（無限にタイブレークを繰り返さないため）。
  const assignment =
    outcome.reason === "ok"
      ? { primary: outcome.primary, coSigner: outcome.coSigner, coSignRequiredButUnavailable: outcome.coSignRequiredButUnavailable }
      : { primary: null, coSigner: null, coSignRequiredButUnavailable: false };

  const taskId = await materializeDetectedTask(env, detection.source_message_url, assignment);
  await env.DB.prepare(`UPDATE llm_shadow_detections SET decided_by = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`)
    .bind(actorId, detectionId)
    .run();
  await writeAuditLog(env, { actor: actorId, action: "llm_candidate_accepted", target: String(detectionId), detail: { taskId } });

  return finishCandidatePost(env, detection, `採用（<@${actorId}>）→ タスク #${taskId}`);
}

async function finishCandidatePost(env: Env, detection: LlmShadowDetectionRow, decisionLine: string): Promise<DeferredResult> {
  return {
    ack: { type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE },
    followUp: async () => {
      if (!detection.review_channel_id || !detection.review_message_id) return;
      const embed = buildLlmCandidateReviewEmbed(detection, decisionLine);
      await editChannelMessage(env.DISCORD_BOT_TOKEN, detection.review_channel_id, detection.review_message_id, {
        embeds: [embed],
        components: [],
      }).catch((e) => console.error("LLM検出候補メッセージの更新に失敗", e));
    },
  };
}
