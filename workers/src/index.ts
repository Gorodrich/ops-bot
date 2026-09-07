// OpsBot Edge層エントリポイント。
//
// Phase 1 で追加したスコープ：
//   * アカウント紐づけコマンド（/authorise /modauth /whoami）
//   * job_queue の実クレーム（排他ロック）・完了報告受け口（/ct/jobs/complete）
//   * Cron：脱退・資格喪失の定期差分検知、日次ホワイトリスト突合ジョブの積み込み
//
// Phase 0 からの制約はそのまま維持：
//   * CT102へのインバウンド経路は一切設けない（プル方式・§3.4.2）
//   * チャンネルID・ロールID・重み・閾値は D1 settings テーブルから読む（ハードコード禁止・ルールc）

import type { Env } from "./env";
import { verifyDiscordRequest } from "./discord/verify";
import { InteractionType, InteractionResponseType, focusedOption, subcommand, type Interaction } from "./discord/types";
import { handleAuthorise } from "./accountLinks/authoriseCommand";
import { handleModauth, handleModauthComponent } from "./accountLinks/modauthCommand";
import { handleWhoami } from "./accountLinks/whoamiCommand";
import type { DeferredResult } from "./accountLinks/authoriseCommand";
import { handleKaihatsuSet } from "./kaihatsu/setCommand";
import { handleKaihatsuDelete } from "./kaihatsu/deleteCommand";
import { handleKaihatsuList } from "./kaihatsu/listCommand";
import { handleKaihatsuGroupFinalize } from "./kaihatsu/groupFinalizeCommand";
import { handleKaihatsuConfirmComponent } from "./kaihatsu/confirmCommand";
import { handleRevokeButton, handleRevokeModalSubmit } from "./kaihatsu/revokeCommand";
import {
  CONFIRM_BUTTON_CUSTOM_ID_PREFIX,
  REVOKE_BUTTON_CUSTOM_ID_PREFIX,
  REVOKE_MODAL_CUSTOM_ID_PREFIX,
  WITHDRAW_BUTTON_CUSTOM_ID_PREFIX,
} from "./kaihatsu/templates";
import { claimJobs } from "./jobs/queue";
import { handleJobComplete } from "./jobs/completion";
import { runMemberDiff } from "./cron/memberDiff";
import { triggerWhitelistAudit } from "./cron/whitelistAudit";
import { detectStaleJobs } from "./cron/staleJobs";
import { processPhase3Deadlines } from "./cron/phase3Deadlines";
import { processVoteDeadlines } from "./cron/voteDeadlines";
import { processTaskHoldResume } from "./cron/taskHoldResume";
import { processNudges } from "./cron/nudge";
import { processVoteReminders } from "./cron/voteReminder";
import { updateDashboards } from "./cron/dashboard";
import { runTicketChannelScan } from "./llm/ticketScan";
import { runLlmMessageScan } from "./llm/messageScan";
import { handleModvoteEnd, handleModvoteHogokuikiBuild, handleModvoteIdAutocomplete, handleModvoteQuick, handleModvoteStart, handleModvoteStatus } from "./votes/modvoteCommand";
import { handleParticipantVoteEnd, handleParticipantVoteIdAutocomplete, handleParticipantVoteStart, handleParticipantVoteStatus } from "./votes/participantVoteCommand";
import { handleVoteBallotButton } from "./votes/voteShared";
import { handleKyoka, handlePermissionButton } from "./permissions/kyokaCommand";
import { handleUmetate } from "./permissions/umetateCommand";
import { handleTaskAdd, handleTaskDecline, handleTaskDone, handleTaskHold, handleTaskIdAutocomplete, handleTaskList } from "./tasks/taskCommand";
import { handleStaffLeave } from "./staff/leaveCommand";
import { handleSubaccountConfirmComponent, handleSubaccountLink, handleSubaccountList, handleSubaccountUnlink } from "./staff/subaccountCommand";
import { handleOpsCost, handleOpsLog, handleOpsDashboard, handleOpsLlm } from "./ops/opsCommand";
import {
  PERMISSION_NG_BUTTON_PREFIX,
  PERMISSION_OK_BUTTON_PREFIX,
  PERMISSION_WITHDRAW_BUTTON_PREFIX,
} from "./permissions/templates";
import { VOTE_ABSTAIN_BUTTON_PREFIX, VOTE_NO_BUTTON_PREFIX, VOTE_YES_BUTTON_PREFIX } from "./votes/templates";
import { handleLlmCandidateButton } from "./llm/candidateReview";
import { LLM_CANDIDATE_ACCEPT_BUTTON_PREFIX, LLM_CANDIDATE_REJECT_BUTTON_PREFIX } from "./llm/templates";
import { resolveUneiActor } from "./staff/subaccountEligibility";

// Cron式ごとの役割（wrangler.jsonc の triggers.crons と対応）。
// Cloudflare Workers Free枠はアカウント全体でcronトリガー5件までのため、
// Phase 5で追加した4ジョブは新規cronを増やさず、既存の2つの発火（10分ごと／15分ごと）に相乗りさせる。
// 各ジョブは絶対時刻ベースで対象を判定するため（§9）、発火頻度が上がっても二重処理は起きない。
const CRON_STALE_JOBS = "*/5 * * * *"; // 5分ごと：job_queue の滞留検知（Phase 0で確保した枠。G-10）
const CRON_MEMBER_DIFF = "0 * * * *"; // 毎時0分：脱退・資格喪失の差分検知（§6.4.3、既定1時間ごと）
const CRON_WHITELIST_AUDIT = "0 9 * * *"; // 毎日09:00 UTC：日次ホワイトリスト突合（§6.4.4）
const CRON_FAST = "*/10 * * * *"; // 10分ごと：投票締切（§5.2・§5.3）＋保留タスク自動復帰（§4.2）＋投票締切3h前リマインド（§4.7）
const CRON_SLOW = "*/15 * * * *"; // 15分ごと：仮承認・グループ72h期限切れ（§9）＋督促エスカレーション（§4.7）＋ダッシュボード更新（§4.8）

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ ok: true, env: env.OPSBOT_ENV, shadow: env.SHADOW_MODE === "true" });
    }

    if (url.pathname === "/interactions" && request.method === "POST") {
      return handleInteractions(request, env, ctx);
    }

    // CT102 → Workers ポーリング（アウトバウンドのみ・§3.4.2）
    if (url.pathname === "/ct/jobs/poll" && request.method === "POST") {
      if (!isCtAuthorized(request, env)) return new Response("unauthorized", { status: 401 });
      const body = (await request.json().catch(() => ({}))) as {
        capacity?: { image?: number; llm?: number; crafty?: number };
      };
      const jobs = await claimJobs(env, body.capacity ?? {}, "ct102");
      return Response.json({
        jobs: jobs.map((j) => ({ id: j.id, kind: j.kind, payload: JSON.parse(j.payload) })),
      });
    }

    // CT102 → Workers ジョブ完了報告（アウトバウンドのみ・§3.4.2）
    if (url.pathname === "/ct/jobs/complete" && request.method === "POST") {
      if (!isCtAuthorized(request, env)) return new Response("unauthorized", { status: 401 });
      const body = (await request.json().catch(() => null)) as
        | { id: number; status: "done" | "failed"; result?: unknown; error?: string }
        | null;
      if (!body || typeof body.id !== "number") return new Response("bad request", { status: 400 });
      await handleJobComplete(env, body.id, { status: body.status, result: body.result, error: body.error });
      return Response.json({ ok: true });
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === CRON_STALE_JOBS) {
      ctx.waitUntil(detectStaleJobs(env));
    } else if (event.cron === CRON_MEMBER_DIFF) {
      ctx.waitUntil(runMemberDiff(env));
    } else if (event.cron === CRON_WHITELIST_AUDIT) {
      ctx.waitUntil(triggerWhitelistAudit(env));
    } else if (event.cron === CRON_FAST) {
      ctx.waitUntil(processVoteDeadlines(env));
      ctx.waitUntil(processTaskHoldResume(env));
      ctx.waitUntil(processVoteReminders(env));
    } else if (event.cron === CRON_SLOW) {
      ctx.waitUntil(processPhase3Deadlines(env));
      ctx.waitUntil(processNudges(env));
      ctx.waitUntil(updateDashboards(env));
      // Phase 6：LLM層（シャドーモード）。§7.1の「30分間隔」・ticket-tool-spec.mdの「1時間ごと」は
      // 各関数内部で絶対時刻ベースに間引く（Cronトリガー数の free枠上限のため新規cronは追加しない）。
      ctx.waitUntil(runTicketChannelScan(env));
      ctx.waitUntil(runLlmMessageScan(env));
    }
  },
};

function isDeferredResult(r: DeferredResult | { ack: object }): r is DeferredResult {
  return typeof (r as DeferredResult).followUp === "function";
}

function isCtAuthorized(request: Request, env: Env): boolean {
  return request.headers.get("authorization") === `Bearer ${env.CT_SHARED_SECRET}`;
}

async function routeKaihatsu(env: Env, interaction: Interaction): Promise<DeferredResult> {
  const sub = subcommand(interaction.data?.options);
  if (!sub) {
    return {
      ack: { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "サブコマンドを指定してください（set / delete / list）。" } },
      followUp: async () => {},
    };
  }
  if (sub.name === "set") return handleKaihatsuSet(env, interaction, sub.options);
  if (sub.name === "delete") return handleKaihatsuDelete(env, interaction, sub.options);
  if (sub.name === "list") return handleKaihatsuList(env, interaction);
  if (sub.name === "group_finalize") return handleKaihatsuGroupFinalize(env, interaction, sub.options);
  return {
    ack: { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "未対応のサブコマンドです。" } },
    followUp: async () => {},
  };
}

async function routeModvote(env: Env, interaction: Interaction): Promise<DeferredResult> {
  const sub = subcommand(interaction.data?.options);
  if (!sub) {
    return {
      ack: { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "サブコマンドを指定してください（start / quick / status / end / hogokuiki_build）。" } },
      followUp: async () => {},
    };
  }
  if (sub.name === "start") return handleModvoteStart(env, interaction, sub.options);
  if (sub.name === "quick") return handleModvoteQuick(env, interaction, sub.options);
  if (sub.name === "status") return handleModvoteStatus(env, interaction, sub.options);
  if (sub.name === "end") return handleModvoteEnd(env, interaction, sub.options);
  if (sub.name === "hogokuiki_build") return handleModvoteHogokuikiBuild(env, interaction, sub.options);
  return {
    ack: { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "未対応のサブコマンドです。" } },
    followUp: async () => {},
  };
}

/** /vote（参加者投票・2026-09-06決定）。quickは参加者投票には存在しない。 */
async function routeParticipantVote(env: Env, interaction: Interaction): Promise<DeferredResult> {
  const sub = subcommand(interaction.data?.options);
  if (!sub) {
    return {
      ack: { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "サブコマンドを指定してください（start / status / end）。" } },
      followUp: async () => {},
    };
  }
  if (sub.name === "start") return handleParticipantVoteStart(env, interaction, sub.options);
  if (sub.name === "status") return handleParticipantVoteStatus(env, interaction, sub.options);
  if (sub.name === "end") return handleParticipantVoteEnd(env, interaction, sub.options);
  return {
    ack: { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "未対応のサブコマンドです。" } },
    followUp: async () => {},
  };
}

/** APPLICATION_COMMAND_AUTOCOMPLETE（/modvote status・end、/vote status・end の vote_id、/task done・decline・hold の task_id）。
 *  /modvote status は運営者のみ実行可（2026-09-06修正）。/vote status（参加者投票）は誰でも実行可。 */
async function buildAutocompleteResponse(env: Env, interaction: Interaction): Promise<{ type: number; data: { choices: Array<{ name: string; value: string }> } }> {
  const empty = { type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT, data: { choices: [] } };
  const name = interaction.data?.name;
  if (name !== "modvote" && name !== "vote" && name !== "task") return empty;

  const sub = subcommand(interaction.data?.options);
  const focused = focusedOption(sub?.options);
  if (!sub || !focused) return empty;

  if ((name === "modvote" || name === "vote") && focused.name === "vote_id") {
    // /modvote end・/vote end は実行資格が運営者ロールのみ（各startと同様）のため、
    // 候補表示の時点でも同じロールを要求する。/modvote status も運営者のみ実行可（2026-09-06修正）のため
    // 同様にゲートする。/vote status（参加者投票）のみ「誰でも」実行可のためゲートしない。
    if (sub.name === "end" || (name === "modvote" && sub.name === "status")) {
      const resolved = await resolveUneiActor(env, interaction.member);
      if (!resolved.ok) return empty;
    }
    const choices = name === "modvote"
      ? await handleModvoteIdAutocomplete(env, sub.name, String(focused.value ?? ""))
      : await handleParticipantVoteIdAutocomplete(env, sub.name, String(focused.value ?? ""));
    return { type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT, data: { choices } };
  }

  if (name === "task" && focused.name === "task_id") {
    // /task の全サブコマンドが運営者ロール必須（requireUnei）のため、候補表示でも同じ実行資格を要求する
    // （運営サブ垢からの場合は連携済みメイン垢の担当タスクを候補にする）。
    const resolved = await resolveUneiActor(env, interaction.member);
    if (!resolved.ok) return empty;
    const choices = await handleTaskIdAutocomplete(env, sub.name, resolved.actorId, String(focused.value ?? ""));
    return { type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT, data: { choices } };
  }

  return empty;
}

async function routeTask(env: Env, interaction: Interaction): Promise<DeferredResult> {
  const sub = subcommand(interaction.data?.options);
  if (!sub) {
    return {
      ack: { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "サブコマンドを指定してください（add / done / decline / hold / list）。" } },
      followUp: async () => {},
    };
  }
  if (sub.name === "add") return handleTaskAdd(env, interaction, sub.options);
  if (sub.name === "done") return handleTaskDone(env, interaction, sub.options);
  if (sub.name === "decline") return handleTaskDecline(env, interaction, sub.options);
  if (sub.name === "hold") return handleTaskHold(env, interaction, sub.options);
  if (sub.name === "list") return handleTaskList(env, interaction);
  return {
    ack: { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "未対応のサブコマンドです。" } },
    followUp: async () => {},
  };
}

async function routeStaff(env: Env, interaction: Interaction): Promise<DeferredResult> {
  const sub = subcommand(interaction.data?.options);
  if (sub?.name === "leave") return handleStaffLeave(env, interaction, sub.options);
  return {
    ack: { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "未対応のサブコマンドです（leave のみ対応）。" } },
    followUp: async () => {},
  };
}

async function routeSubaccount(env: Env, interaction: Interaction): Promise<DeferredResult> {
  const sub = subcommand(interaction.data?.options);
  if (sub?.name === "link") return handleSubaccountLink(env, interaction, sub.options ?? []);
  if (sub?.name === "unlink") return handleSubaccountUnlink(env, interaction, sub.options ?? []);
  if (sub?.name === "list") return handleSubaccountList(env, interaction);
  return {
    ack: { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "未対応のサブコマンドです（link / unlink / list のみ対応）。" } },
    followUp: async () => {},
  };
}

async function routeOps(env: Env, interaction: Interaction): Promise<DeferredResult> {
  const sub = subcommand(interaction.data?.options);
  if (sub?.name === "cost") return handleOpsCost(env, interaction);
  if (sub?.name === "log") return handleOpsLog(env, interaction, sub.options);
  if (sub?.name === "dashboard") return handleOpsDashboard(env, interaction, sub.options);
  if (sub?.name === "llm") return handleOpsLlm(env, interaction, sub.options);
  return {
    ack: { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "未対応のサブコマンドです（cost / log / dashboard / llm のみ対応）。" } },
    followUp: async () => {},
  };
}

async function handleInteractions(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const raw = await request.text();
  const valid = await verifyDiscordRequest(
    env.DISCORD_PUBLIC_KEY,
    request.headers.get("x-signature-ed25519"),
    request.headers.get("x-signature-timestamp"),
    raw,
  );
  if (!valid) return new Response("invalid request signature", { status: 401 });

  const interaction = JSON.parse(raw) as Interaction;

  if (interaction.type === InteractionType.PING) {
    return Response.json({ type: InteractionResponseType.PONG });
  }

  if (interaction.type === InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE) {
    return Response.json(await buildAutocompleteResponse(env, interaction));
  }

  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    const name = interaction.data?.name;
    const result: DeferredResult | { ack: object } | null =
      name === "authorise"
        ? await handleAuthorise(env, interaction)
        : name === "modauth"
          ? await handleModauth(env, interaction)
          : name === "whoami"
            ? await handleWhoami(env, interaction)
            : name === "kaihatsu"
              ? await routeKaihatsu(env, interaction)
              : name === "modvote"
                ? await routeModvote(env, interaction)
                : name === "vote"
                  ? await routeParticipantVote(env, interaction)
                  : name === "kyoka"
                  ? await handleKyoka(env, interaction, interaction.data?.options ?? [])
                  : name === "umetate"
                    ? await handleUmetate(env, interaction, interaction.data?.options ?? [])
                    : name === "task"
                      ? await routeTask(env, interaction)
                      : name === "staff"
                        ? await routeStaff(env, interaction)
                        : name === "ops"
                          ? await routeOps(env, interaction)
                          : name === "subaccount"
                            ? await routeSubaccount(env, interaction)
                            : null;

    if (!result) {
      return Response.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "未実装のコマンドです。" },
      });
    }
    if (isDeferredResult(result)) {
      ctx.waitUntil(result.followUp().catch((e: unknown) => console.error("followUp failed", e)));
    }
    return Response.json(result.ack);
  }

  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    const customId = interaction.data?.custom_id ?? "";
    if (customId.startsWith("modauth:")) {
      const result = await handleModauthComponent(env, interaction);
      ctx.waitUntil(result.followUp().catch((e) => console.error("followUp failed", e)));
      return Response.json(result.ack);
    }
    if (customId.startsWith(CONFIRM_BUTTON_CUSTOM_ID_PREFIX) || customId.startsWith(WITHDRAW_BUTTON_CUSTOM_ID_PREFIX)) {
      const result = await handleKaihatsuConfirmComponent(env, interaction);
      ctx.waitUntil(result.followUp().catch((e) => console.error("followUp failed", e)));
      return Response.json(result.ack);
    }
    if (customId.startsWith(REVOKE_BUTTON_CUSTOM_ID_PREFIX)) {
      const result = await handleRevokeButton(env, interaction);
      ctx.waitUntil(result.followUp().catch((e) => console.error("followUp failed", e)));
      return Response.json(result.ack);
    }
    if (
      customId.startsWith(VOTE_YES_BUTTON_PREFIX) ||
      customId.startsWith(VOTE_NO_BUTTON_PREFIX) ||
      customId.startsWith(VOTE_ABSTAIN_BUTTON_PREFIX)
    ) {
      const result = await handleVoteBallotButton(env, interaction);
      ctx.waitUntil(result.followUp().catch((e) => console.error("followUp failed", e)));
      return Response.json(result.ack);
    }
    if (
      customId.startsWith(PERMISSION_OK_BUTTON_PREFIX) ||
      customId.startsWith(PERMISSION_NG_BUTTON_PREFIX) ||
      customId.startsWith(PERMISSION_WITHDRAW_BUTTON_PREFIX)
    ) {
      const result = await handlePermissionButton(env, interaction);
      ctx.waitUntil(result.followUp().catch((e) => console.error("followUp failed", e)));
      return Response.json(result.ack);
    }
    if (customId.startsWith(LLM_CANDIDATE_ACCEPT_BUTTON_PREFIX) || customId.startsWith(LLM_CANDIDATE_REJECT_BUTTON_PREFIX)) {
      const result = await handleLlmCandidateButton(env, interaction);
      ctx.waitUntil(result.followUp().catch((e) => console.error("followUp failed", e)));
      return Response.json(result.ack);
    }
    if (customId === "subaccount:confirm" || customId === "subaccount:reject") {
      const result = await handleSubaccountConfirmComponent(env, interaction);
      ctx.waitUntil(result.followUp().catch((e) => console.error("followUp failed", e)));
      return Response.json(result.ack);
    }
    return Response.json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
  }

  if (interaction.type === InteractionType.MODAL_SUBMIT) {
    const customId = interaction.data?.custom_id ?? "";
    if (customId.startsWith(REVOKE_MODAL_CUSTOM_ID_PREFIX)) {
      const result = await handleRevokeModalSubmit(env, interaction);
      ctx.waitUntil(result.followUp().catch((e) => console.error("followUp failed", e)));
      return Response.json(result.ack);
    }
    return Response.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "未対応のモーダルです。" } });
  }

  return Response.json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "未対応のInteractionです。" } });
}
