// /kyoka・/umetate の通知文面・ボタン定義（§11-6）。記名許可は押下者名・時刻を公開・永久記録する（§5.4）。

import type { SignatureRow } from "./repo";

export const PERMISSION_OK_BUTTON_PREFIX = "kyoka:ok:";
export const PERMISSION_NG_BUTTON_PREFIX = "kyoka:ng:";
export const PERMISSION_WITHDRAW_BUTTON_PREFIX = "kyoka:withdraw:";

export function buildPermissionButtonRow(requestId: number, requesterId: string): unknown[] {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 3, label: "許可する（OK）", custom_id: `${PERMISSION_OK_BUTTON_PREFIX}${requestId}` },
        { type: 2, style: 4, label: "許可しない（NG）", custom_id: `${PERMISSION_NG_BUTTON_PREFIX}${requestId}` },
        { type: 2, style: 2, label: "取り下げる（申請者）", custom_id: `${PERMISSION_WITHDRAW_BUTTON_PREFIX}${requestId}` },
      ],
    },
  ];
}

function signatureLines(signatures: SignatureRow[]): string {
  if (signatures.length === 0) return "（まだ記名がありません）";
  return signatures
    .map((s) => `・<@${s.granter_id}>：${s.decision === "ok" ? "OK" : "NG"}（<t:${Math.floor(new Date(s.decided_at).getTime() / 1000)}:R>）`)
    .join("\n");
}

const STATUS_COLOR: Record<"open" | "approved" | "withdrawn", number> = {
  open: 0xfee75c,
  approved: 0x57f287,
  withdrawn: 0x99aab5,
};

export function buildPermissionRequestEmbed(args: {
  requestId: number;
  label: string;
  subject: string;
  requesterMention: string;
  requiredCount: number;
  description?: string | null;
  imageUrl?: string | null;
  signatures: SignatureRow[];
  status: "open" | "approved" | "withdrawn";
}): Record<string, unknown> {
  const okCount = args.signatures.filter((s) => s.decision === "ok").length;
  const descLines = [`申請者：${args.requesterMention}`, `件名：${args.subject}`];
  if (args.description) descLines.push(`内容：${args.description}`);
  if (args.status === "approved") descLines.push("→ 必要人数に達したため成立しました。");
  if (args.status === "withdrawn") descLines.push("→ 申請者により取り下げられました。");

  const fields = [
    { name: "必要人数", value: `${args.requiredCount}人（現在 ${okCount}人がOK）` },
    { name: "押下者名・押下時刻（公開・永久記録・§5.4）", value: signatureLines(args.signatures) },
  ];

  return {
    title: `【記名許可（類型B）】要請 #${args.requestId}：${args.label}`,
    description: descLines.join("\n"),
    color: STATUS_COLOR[args.status],
    fields,
    ...(args.imageUrl ? { image: { url: args.imageUrl } } : {}),
  };
}

export function buildPermissionApprovedDmEmbed(args: {
  label: string;
  subject: string;
  description?: string | null;
  imageUrl?: string | null;
}): Record<string, unknown> {
  const fields = [{ name: "件名", value: args.subject }];
  if (args.description) fields.push({ name: "内容", value: args.description });
  return {
    title: `【記名許可（類型B）】「${args.label}」が許可されました`,
    description: "申請内容について運営が許可しました。実施することができます。",
    color: 0x57f287,
    fields,
    ...(args.imageUrl ? { image: { url: args.imageUrl } } : {}),
  };
}

export const PERMISSION_MESSAGES = {
  unknownApprovalKey: "指定された事項は承認事項の分類表（settings.approval_types）に登録されていません。",
  methodAMismatch: "この事項は運営の承認（類型A・秘密投票）です。/vote start を使用してください。",
  requiresUneiRole: "この操作は「運営」ロールを持つ運営者のみ実行できます（§5.4.1）。",
  alreadyDecided: "この要請は既に成立または取り下げ済みです。",
  onlyRequesterCanWithdraw: "取り下げは申請者本人のみ実行できます。",
  needsAttachmentOrDescription: "地図の画像添付、または文章による説明のいずれかが必須です（§5.4.1）。",
} as const;
