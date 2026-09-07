// /umetate（海の埋立ての許可要請・§5.4.1）。地図画像添付または文章説明のいずれかを必須とする。
// 「運営」ロールを有する者2人以上のOKで成立する記名許可（類型B）。approval_key は
// settings.approval_types の "land_reclamation" に固定する。

import type { Env } from "../env";
import { type CommandOption, type Interaction, resolvedAttachment, optionValue, InteractionResponseType } from "../discord/types";
import { EPHEMERAL_FLAG } from "../discord/rest";
import { createPermissionRequest } from "./kyokaCommand";
import { PERMISSION_MESSAGES } from "./templates";
import type { DeferredResult } from "../accountLinks/authoriseCommand";

const UMETATE_APPROVAL_KEY = "land_reclamation";

function immediate(content: string): DeferredResult {
  return {
    ack: { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content, flags: EPHEMERAL_FLAG } },
    followUp: async () => {},
  };
}

export async function handleUmetate(env: Env, interaction: Interaction, options: CommandOption[]): Promise<DeferredResult> {
  const description = optionValue(options, "description") ?? null;
  const attachment = resolvedAttachment(interaction, "image", options);
  if (!description && !attachment) return immediate(PERMISSION_MESSAGES.needsAttachmentOrDescription);

  return createPermissionRequest(env, interaction, {
    approvalKey: UMETATE_APPROVAL_KEY,
    subject: "海の埋立ての許可（禁止事項及び罰則に関するルール第11条第1項）",
    description,
    imageUrl: attachment?.url ?? null,
  });
}
