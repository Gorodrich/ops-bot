// /kaihatsu の通知文面（§11-6：文面のみで調整できるよう1ファイルに集約）。
// Bot形式審査の通知は固定テンプレート（§5.7.6）。
// 運営専用チャンネル(kaihatsu_ryo)への公開投稿・参加者向けDMはEmbed形式で送る
// （votes/templates.ts・permissions/templates.ts と同じ方針）。

import { DECOMPOSITION_LABELS, type DecompositionLabel } from "./domain";

export const KAIHATSU_MESSAGES = {
  needsAuthorise: "先に /authorise でMinecraftアカウントを紐づけてください（条件⑦：ファイル名のプレイヤー名が紐づけ済みである必要があります）。",
  noAttachments: "画像を1枚以上添付してください。",
  alreadyProcessing: "前回の届出を処理中です。結果が出るまでお待ちください。",
  noActiveClaim: "削除対象の個人開発領がありません。",
  accepted: "受付しました。判定処理を開始します。結果は個人開発領の専用チャンネルに投稿されます。",
  processingFailed: "処理中にエラーが発生しました。運営に確認を依頼しました。しばらくしてから再度お試しください。",
  alreadyOpenElsewhere: "対象の参加者について、仮承認の本人確認待ち・グループ受付中・処理中のいずれかの届出が既にあります。先行する届出の確認完了または却下確定を待ってから再度お試しください（§5.7.3）。",
  groupRequiresOtherPlayerDelete: "他者を対象とする削除（mcuser指定）は group オプションを必ず伴わせてください（§6.2・本人確認を要するため）。",
  groupAccepted: "同時処理グループに追加しました。全員分の届出が揃ったら /kaihatsu group_finalize で受付を締め切ってください。",
  groupNotFound: "指定された同時処理グループが見つかりません。先に /kaihatsu set または /kaihatsu delete で group を指定して届け出てください。",
  groupAlreadyFinalized: "この同時処理グループは既に受付を締め切っています。",
  groupFinalized: "同時処理グループの受付を締め切りました。判定処理を開始します。",
  groupEmpty: "このグループにはまだ届出がありません。",
} as const;

const COLOR_APPROVED = 0x57f287;
const COLOR_REJECTED = 0xed4245;
const COLOR_PENDING = 0xfee75c;
const COLOR_NEUTRAL = 0x99aab5;

export function decompositionSummary(labels: DecompositionLabel[]): string {
  return labels.map((l) => DECOMPOSITION_LABELS[l]).join(" / ");
}

export function formatBlocks(n: number): string {
  return n.toLocaleString("ja-JP");
}

export interface EmbedWithContent {
  content: string;
  embed: Record<string, unknown>;
}

function reasonsField(reasons: string[]): { name: string; value: string } {
  return { name: "不合格理由", value: reasons.map((r) => `・${r}`).join("\n") };
}

/** 正式承認確定・撤回猶予中の確認投稿本文（§5.7.2）。単独申請の即時確定と本人確認完了後の両方から使う。 */
export function buildApprovedEmbed(args: {
  mentionDiscordId: string;
  mcName: string;
  areaBlocks: number;
  loc1: { x: number; y: number; z: number };
  loc2: { x: number; y: number; z: number };
  decomposition: DecompositionLabel[];
  addedPixels: number;
  removedPixels: number;
  revokeWindowHours: number;
}): EmbedWithContent {
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: "分類", value: decompositionSummary(args.decomposition) },
    { name: "申請面積", value: `${formatBlocks(args.areaBlocks)}ブロック`, inline: true },
    {
      name: "座標",
      value: `loc1(${args.loc1.x}, ${args.loc1.y}, ${args.loc1.z}) / loc2(${args.loc2.x}, ${args.loc2.y}, ${args.loc2.z})`,
    },
  ];
  if (args.removedPixels > 0) {
    fields.push({
      name: "⚠ 削除扱いになる範囲",
      value: `従前の範囲のうち ${formatBlocks(args.removedPixels)}ブロックが今回の届出範囲に含まれないため削除扱いになります（復元はできません。誤りの場合は再度 /kaihatsu set で届け出てください）。`,
    });
  }
  if (args.addedPixels > 0) {
    fields.push({ name: "新規追加分", value: `${formatBlocks(args.addedPixels)}ブロック`, inline: true });
  }

  return {
    content: `<@${args.mentionDiscordId}>`,
    embed: {
      title: "【個人開発領：本人確認完了・正式承認】",
      description: `${args.mcName} の届出を承認しました。\n\n本判定はBotによる機械的な形式審査です（面積・保護区域・重複の3条件のみで判定）。運営者は${args.revokeWindowHours}時間以内であれば下のボタンから撤回できます。`,
      color: COLOR_APPROVED,
      fields,
    },
  };
}

export const REVOKE_BUTTON_CUSTOM_ID_PREFIX = "kaihatsu:revoke:";
export const REVOKE_MODAL_CUSTOM_ID_PREFIX = "kaihatsu:revoke_modal:";
export const REVOKE_REASON_FIELD_ID = "reason";
export const CONFIRM_BUTTON_CUSTOM_ID_PREFIX = "kaihatsu:confirm:";
export const WITHDRAW_BUTTON_CUSTOM_ID_PREFIX = "kaihatsu:withdraw:";

export function buildRevokeButtonRow(applicationId: number): unknown[] {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 4, label: "撤回する（運営者）", custom_id: `${REVOKE_BUTTON_CUSTOM_ID_PREFIX}${applicationId}` },
      ],
    },
  ];
}

export function buildConfirmWithdrawButtonRow(applicationId: number): unknown[] {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 3, label: "この内容で申請する", custom_id: `${CONFIRM_BUTTON_CUSTOM_ID_PREFIX}${applicationId}` },
        { type: 2, style: 4, label: "取り下げる", custom_id: `${WITHDRAW_BUTTON_CUSTOM_ID_PREFIX}${applicationId}` },
      ],
    },
  ];
}

/** 本人確認DM（§5.7.3）：代表者一括申請・同時処理グループの対象者に、この内容で申請してよいか確認する。 */
export function buildProvisionalConfirmEmbed(args: {
  mcName: string;
  representativeMention: string;
  areaBlocks: number;
  confirmDeadlineDiscordTimestamp: string;
  groupNote?: string;
}): Record<string, unknown> {
  const fields = [
    { name: "申請面積", value: `${formatBlocks(args.areaBlocks)}ブロック`, inline: true },
    { name: "確認期限", value: args.confirmDeadlineDiscordTimestamp, inline: true },
  ];
  if (args.groupNote) fields.push({ name: "注記", value: args.groupNote, inline: false });
  return {
    title: "【個人開発領：本人確認】",
    description: `あなたの個人開発領の申請が ${args.representativeMention} さんによって行われました。この範囲で問題ありませんか？\n\n期限までに「この内容で申請する」を押してください。無反応の場合は却下扱いになります。`,
    color: COLOR_PENDING,
    fields,
  };
}

/** 仮承認のチャンネル通知（§5.7.3：代表者一括申請・非グループのみ）。 */
export function buildProvisionalApprovedChannelEmbed(args: {
  mentionDiscordId: string;
  mcName: string;
  representativeMention: string;
  areaBlocks: number;
}): EmbedWithContent {
  return {
    content: `<@${args.mentionDiscordId}>`,
    embed: {
      title: "【個人開発領：Bot形式審査（仮承認）】",
      description: `${args.mcName} の届出（${args.representativeMention} さんによる代表提出）が形式要件を満たしたため仮承認しました。\n\n本人確認のDMを送信しました。72時間以内に本人が確認すると正式承認となります。`,
      color: COLOR_PENDING,
      fields: [{ name: "申請面積", value: `${formatBlocks(args.areaBlocks)}ブロック`, inline: true }],
    },
  };
}

/** 仮承認の取り下げ・期限切れ通知DM（§5.7.3）。グループ却下に巻き込まれた場合は groupRejectedNote を立てる。 */
export function buildProvisionalWithdrawnOrExpiredEmbed(args: {
  mentionDiscordId: string;
  mcName: string;
  representativeMention: string;
  reason: "withdrawn" | "expired";
  groupRejectedNote?: boolean;
}): Record<string, unknown> {
  const reasonText = args.reason === "withdrawn" ? "本人が取り下げました" : "本人確認の期限（72時間）内に応答がなかったため期限切れとなりました";
  const fields = [
    { name: "理由", value: `${reasonText}（内容への異議ではありません）。` },
  ];
  if (args.groupRejectedNote) {
    fields.push({ name: "注記", value: "グループ内の他のメンバーの不成立により、グループ全体が却下されました。" });
  }
  return {
    title: "【個人開発領：Bot形式審査（却下）】",
    description: `${args.mcName} の届出（${args.representativeMention} さんによる代表提出）は却下されました。\n\n再度届け出る場合は、あらためて /kaihatsu set で申請してください。`,
    color: COLOR_REJECTED,
    fields,
  };
}

/** 削除の本人確認DM（§6.2・同時処理グループでの他者対象削除）。 */
export function buildDeleteProvisionalConfirmEmbed(args: {
  mcName: string;
  representativeMention: string;
  confirmDeadlineDiscordTimestamp: string;
}): Record<string, unknown> {
  return {
    title: "【個人開発領：本人確認（削除）】",
    description: `${args.representativeMention} さんから、あなたの個人開発領（${args.mcName}）を削除する同時処理グループの届出がありました。\n\nこの操作により、あなたの個人開発領は失われます（復元はできません）。\n\n期限までに「この内容で申請する」を押してください。無反応の場合はグループ全体が却下されます。`,
    color: COLOR_PENDING,
    fields: [{ name: "確認期限", value: args.confirmDeadlineDiscordTimestamp, inline: true }],
  };
}

/** 保留通知DM（§5.7.5）。 */
export function buildHeldNoticeEmbed(args: { representativeMention: string; blockingOwnerName: string; deadlineDiscordTimestamp: string }): Record<string, unknown> {
  return {
    title: "【個人開発領：保留】",
    description: `${args.representativeMention} さんからの届出は、${args.blockingOwnerName} さんの仮承認中の範囲と重複するため保留しています。\n\n${args.blockingOwnerName} さんの本人確認の結果を待って自動的に再審査します。届出時刻は維持されます。`,
    color: COLOR_PENDING,
    fields: [{ name: "再審査見込み", value: args.deadlineDiscordTimestamp, inline: true }],
  };
}

/** 保留の解放時、重複相手の正式承認確定を理由に却下する通知DM（§6.3.3⑥／decisions.md #52：重複相手名を開示）。 */
export function buildHeldRejectedEmbed(args: { mcName: string; confirmedOwnerName: string }): Record<string, unknown> {
  return {
    title: "【個人開発領：却下】",
    description: `保留していた届出（${args.mcName}）は、重複相手の正式承認が確定したため却下されました。`,
    color: COLOR_REJECTED,
    fields: [{ name: "重複相手", value: args.confirmedOwnerName, inline: true }],
  };
}

/** 撤回通知DM（§5.7.2：24時間以内の運営者による撤回）。 */
export function buildRevokedNoticeEmbed(args: { mcName: string; revokedByMention: string; reason: string }): Record<string, unknown> {
  return {
    title: "【個人開発領：撤回】",
    description: `${args.mcName} さんの個人開発領の承認が、運営（${args.revokedByMention}）により撤回されました。\n\n今後は運営者による手動審査に切り替わります。追ってご連絡します。`,
    color: COLOR_REJECTED,
    fields: [{ name: "理由", value: args.reason }],
  };
}

/** 同時処理グループ却下のチャンネル通知（§5.7.4：全員成立の原則）。 */
export function buildGroupRejectedEmbed(args: { representativeMention: string; reasons: string[] }): EmbedWithContent {
  return {
    content: args.representativeMention,
    embed: {
      title: "【個人開発領：同時処理グループ却下】",
      description: `${args.representativeMention} さんが提出した同時処理グループは、全員成立の原則（§5.7.4）によりグループ全体が却下されました。`,
      color: COLOR_REJECTED,
      fields: [reasonsField(args.reasons)],
    },
  };
}

/** Bot形式審査の却下チャンネル通知（§6.3.3：不合格理由は全件表示する）。 */
export function buildRejectedEmbed(args: {
  mentionDiscordId: string;
  mcName: string;
  reasons: string[];
}): EmbedWithContent {
  return {
    content: `<@${args.mentionDiscordId}>`,
    embed: {
      title: "【個人開発領：Bot形式審査（却下）】",
      description: `${args.mcName} の届出を却下しました。\n\n内容を修正のうえ、再度 /kaihatsu set で届け出てください。`,
      color: COLOR_REJECTED,
      fields: [reasonsField(args.reasons)],
    },
  };
}

/** 全部削除の届出（自己削除）チャンネル通知。 */
export function buildDeletedEmbed(args: { mentionDiscordId: string; mcName: string; areaBlocks: number }): EmbedWithContent {
  return {
    content: `<@${args.mentionDiscordId}>`,
    embed: {
      title: "【個人開発領：全部削除の届出】",
      description: `${args.mcName} の個人開発領（${formatBlocks(args.areaBlocks)}ブロック）を削除しました。\n\nこの操作は復元できません。`,
      color: COLOR_NEUTRAL,
    },
  };
}

/** 同時処理グループ内でのdelete確定（他者対象削除）チャンネル通知。 */
export function buildGroupDeleteConfirmedEmbed(args: { mentionDiscordId: string; mcName: string }): EmbedWithContent {
  return {
    content: `<@${args.mentionDiscordId}>`,
    embed: {
      title: "【個人開発領：同時処理グループ・削除確定】",
      description: `${args.mcName} の個人開発領を削除しました（復元はできません）。`,
      color: COLOR_NEUTRAL,
    },
  };
}

export function buildProcessingFailedTaskSummary(args: { discordId: string; mcName: string; error: string }): string {
  return `/kaihatsu set の画像処理ジョブが再試行上限に達しました（${args.discordId} / ${args.mcName}）。エラー: ${args.error}`;
}
