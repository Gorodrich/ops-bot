// /authorise（本人による紐づけ・§6.4.1）

import type { Env } from "../env";
import { InteractionResponseType, type Interaction, optionValue } from "../discord/types";
import { getRoles } from "../settings";
import { resolveMinecraftProfile } from "../mojang";
import { decideAuthorise, type AuthoriseDecision } from "./domain";
import { d1AccountLinkRepo, insertLink, reactivateLink } from "./repo";
import { eligibilityFromRoles } from "./eligibility";
import { enqueueWhitelistAdd } from "./whitelist";
import { writeAuditLog } from "../auditLog";
import { sendFollowupMessage, EPHEMERAL_FLAG } from "../discord/rest";

export interface DeferredResult {
  ack: object;
  followUp: () => Promise<void>;
}

export async function handleAuthorise(env: Env, interaction: Interaction): Promise<DeferredResult> {
  const member = interaction.member;
  if (!member) {
    return immediateReject("このコマンドはサーバー内でのみ実行できます。");
  }
  const discordId = member.user.id;
  const mcUsername = optionValue(interaction.data?.options, "mcuser");
  if (!mcUsername) {
    return immediateReject("mcuser オプションが必要です。");
  }

  const roles = await getRoles(env);
  const eligibility = eligibilityFromRoles(member.roles, roles);

  // 実行資格が無ければ Mojang API を呼ぶ前に即時却下（deferしない）
  if (!eligibility.hasHito && !eligibility.hasKariSanka) {
    const decision = await decideAuthorise(d1AccountLinkRepo(env), {
      discordId,
      mojangUuid: null,
      mojangName: "",
      eligibility,
    });
    return immediateReject((decision as Extract<AuthoriseDecision, { kind: "reject" }>).message);
  }

  return {
    ack: { type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: EPHEMERAL_FLAG } },
    followUp: async () => {
      const content = await processAuthorise(env, discordId, mcUsername, eligibility);
      await sendFollowupMessage(env.DISCORD_APP_ID, interaction.token, { content });
    },
  };
}

async function processAuthorise(
  env: Env,
  discordId: string,
  mcUsername: string,
  eligibility: { hasHito: boolean; hasKariSanka: boolean },
): Promise<string> {
  const { profile, timedOut } = await resolveMinecraftProfile(env, mcUsername).catch((err) => {
    console.error("resolveMinecraftProfile failed", mcUsername, err);
    return { profile: null, timedOut: true };
  });
  if (timedOut) {
    return "Minecraftアカウントの実在確認に時間がかかっています。しばらくしてからもう一度お試しください。";
  }
  const decision = await decideAuthorise(d1AccountLinkRepo(env), {
    discordId,
    mojangUuid: profile?.uuid ?? null,
    mojangName: profile?.name ?? mcUsername,
    eligibility,
  });

  if (decision.kind === "reject") {
    return `紐づけを受け付けられませんでした：${decision.message}`;
  }

  if (decision.kind === "reactivate") {
    await reactivateLink(env, { uuid: decision.uuid, name: decision.name, discordId, linkedBy: "self" });
  } else {
    await insertLink(env, { uuid: decision.uuid, name: decision.name, discordId, linkedBy: "self" });
  }

  await enqueueWhitelistAdd(env, decision.name, decision.uuid).catch(() => {
    // ジョブ積み込み失敗自体は紐づけの成否に影響させない。次回ホワイトリスト日次突合で検知される。
  });
  await writeAuditLog(env, {
    actor: discordId,
    action: decision.kind === "reactivate" ? "authorise_reactivate" : "authorise_create",
    target: decision.uuid,
    detail: { mc_name: decision.name },
  });

  return `Minecraftアカウント「${decision.name}」を紐づけました。ホワイトリストへの反映を行っています（反映まで少し時間がかかる場合があります）。`;
}

function immediateReject(message: string): DeferredResult {
  return {
    ack: {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: message, flags: EPHEMERAL_FLAG },
    },
    followUp: async () => {},
  };
}
