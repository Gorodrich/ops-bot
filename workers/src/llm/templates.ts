// LLM検出候補（confidence閾値未満）の運営提示・採否ボタン（Phase 7・§7.3）。
// C-3：Botは賛否・採否の判断を代行しない。採用／却下は必ず運営者の操作を起点とする。

import type { LlmShadowDetectionRow } from "./detectionCompletion";

export const LLM_CANDIDATE_ACCEPT_BUTTON_PREFIX = "llmcand:accept:";
export const LLM_CANDIDATE_REJECT_BUTTON_PREFIX = "llmcand:reject:";

export function buildLlmCandidateButtonRow(detectionId: number): unknown[] {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 3, label: "採用してタスク化", custom_id: `${LLM_CANDIDATE_ACCEPT_BUTTON_PREFIX}${detectionId}` },
        { type: 2, style: 4, label: "却下", custom_id: `${LLM_CANDIDATE_REJECT_BUTTON_PREFIX}${detectionId}` },
      ],
    },
  ];
}

const STATUS_COLOR = { pending: 0xfee75c, decided: 0x99aab5 } as const;

export function buildLlmCandidateReviewEmbed(detection: LlmShadowDetectionRow, decisionLine?: string): Record<string, unknown> {
  const requiredTags = JSON.parse(detection.required_tags || "[]") as string[];
  const fields = [
    { name: "種別", value: detection.type, inline: true },
    { name: "確信度", value: detection.confidence.toFixed(2), inline: true },
    { name: "必要タグ", value: requiredTags.length ? requiredTags.join(", ") : "（なし）" },
    { name: "参考ルール条文", value: detection.suggested_rule ?? "（なし）" },
    { name: "元メッセージ", value: detection.source_message_url },
  ];
  if (decisionLine) fields.push({ name: "判断結果", value: decisionLine });

  return {
    title: `【LLM検出候補・要採否】${detection.title}`,
    description:
      `${detection.summary}\n\n確信度が閾値未満のため自動タスク化されていません（§7.3）。` +
      `運営が内容を確認し、採用（実タスク化）または却下を判断してください（C-3：Botは採否の判断を代行しません）。`,
    color: decisionLine ? STATUS_COLOR.decided : STATUS_COLOR.pending,
    fields,
  };
}
