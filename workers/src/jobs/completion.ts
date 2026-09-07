// CT102からのジョブ完了報告の後処理（§6.4.4：再試行上限超過時のタスク起票／日次突合レポート、
// §6.3.4：/kaihatsu set の判定結果の反映・通知、Phase 3：仮承認・保留・グループ・Dynmap反映）。

import type { Env } from "../env";
import { completeJob, scheduleRetry, markFailedTerminal, type JobRow } from "./queue";
import { getJobRetrySetting, getChannels, getDeadlines } from "../settings";
import {
  sendChannelMessage,
  sendChannelMessageWithFile,
  sendDirectMessage,
  sendDirectMessageWithComponents,
  sendDirectMessageWithComponentsAndFile,
} from "../discord/rest";
import { writeAuditLog } from "../auditLog";
import { addHoursIso } from "../kaihatsu/domain";
import { getApplication, updateApplicationStatus, type ApplicationRow } from "../kaihatsu/repo";
import {
  buildConfirmWithdrawButtonRow,
  buildProvisionalApprovedChannelEmbed,
  buildProvisionalConfirmEmbed,
  buildRejectedEmbed,
  KAIHATSU_MESSAGES,
} from "../kaihatsu/templates";
import { finalizeApprovedSet, markHeldAndNotify, markProvisional } from "../kaihatsu/phase3";
import { tryResolveGroup } from "../kaihatsu/groupResolution";
import { handleClaudeCodeJobComplete } from "../llm/detectionCompletion";

interface CraftyOpPayload {
  op: "add" | "remove";
  mc_name: string;
  mc_uuid: string;
}

interface KaihatsuSetJobPayload {
  subkind: "kaihatsu_set";
  application_id: number;
  requester_discord_id: string;
  requester_mc_name: string;
  requester_mc_uuid: string;
  previous_own_claim: { claim_id: number } | null;
}

interface KaihatsuBatchJobPayload {
  subkind: "kaihatsu_set_batch" | "kaihatsu_group";
  players: Array<{ player_name: string; application_id: number; previous_own_claim: { claim_id: number } | null }>;
}

export interface CtSetResult {
  outcome: "approved" | "rejected" | "held";
  reasons: string[];
  area_blocks?: number;
  bbox?: { x1: number; z1: number; x2: number; z2: number };
  loc1?: { x: number; y: number; z: number };
  loc2?: { x: number; y: number; z: number };
  removed_pixels?: number;
  added_pixels?: number;
  had_previous_claim?: boolean;
  mask_saved_path?: string;
  confirmation_image_base64?: string;
  overlap_with?: Array<{ owner_name: string; pixels: number }>;
  held_blocking_ref_type?: "application" | "group";
  held_blocking_ref_id?: number | string;
  overlap_pending?: Array<{ owner_name: string; pixels: number; ref_type: string | null; ref_id: number | string | null }>;
  application_id?: number;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function handleJobComplete(
  env: Env,
  id: number,
  outcome: { status: "done" | "failed"; result?: unknown; error?: string },
): Promise<void> {
  const job = await completeJob(env, id, outcome);
  if (!job) return;

  if (job.status === "pending") {
    // 失敗して再試行待ち。バックオフ分だけ次回取得を遅らせる（§6.4.4：一定回数まで再試行）。
    const retry = await getJobRetrySetting(env);
    const nextRetryAt = new Date(Date.now() + retry.crafty_retry_backoff_sec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    await scheduleRetry(env, id, nextRetryAt);
  }

  if (job.kind === "crafty_op") {
    await handleCraftyOpCompletion(env, job, outcome);
  } else if (job.kind === "crafty_whitelist_audit") {
    await handleWhitelistAuditCompletion(env, job, outcome);
  } else if (job.kind === "dynmap_sync") {
    await handleDynmapSyncCompletion(env, job, outcome);
  } else if (job.kind === "claude_code") {
    await handleClaudeCodeJobComplete(env, job, outcome);
  } else if (job.kind === "image_process") {
    const payload = JSON.parse(job.payload) as KaihatsuSetJobPayload | KaihatsuBatchJobPayload;
    if (payload.subkind === "kaihatsu_set") {
      await handleKaihatsuSetCompletion(env, job, payload, outcome);
    } else if (payload.subkind === "kaihatsu_set_batch" || payload.subkind === "kaihatsu_group") {
      await handleKaihatsuBatchCompletion(env, job, payload, outcome);
    }
  }
}

// ── 単独申請（Phase 2互換）：即時確定。仮承認を経ない（§5.7.2） ───────────

async function handleKaihatsuSetCompletion(
  env: Env,
  job: JobRow,
  payload: KaihatsuSetJobPayload,
  outcome: { status: "done" | "failed"; result?: unknown; error?: string },
): Promise<void> {
  const channels = await getChannels(env);
  const channelId = channels.kaihatsu_ryo;

  if (outcome.status === "failed") {
    const retry = await getJobRetrySetting(env);
    if (job.attempts < retry.crafty_max_attempts) return; // まだ再試行の余地あり

    await markFailedTerminal(env, job.id);
    await updateApplicationStatus(env, payload.application_id, "failed").catch(() => {});

    await env.DB.prepare(
      `INSERT INTO tasks (type, title, summary, related_rule, status, priority, created_at)
       VALUES ('T-A', ?, ?, '§6.3', 'unassigned', 'high', strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
    )
      .bind(
        `個人開発領の画像処理失敗：${payload.requester_mc_name}`,
        `/kaihatsu set の画像処理ジョブが${job.attempts}回失敗しました。エラー: ${outcome.error ?? "不明"}`,
      )
      .run();

    await sendDirectMessage(env.DISCORD_BOT_TOKEN, payload.requester_discord_id, KAIHATSU_MESSAGES.processingFailed).catch(() => {});

    if (channels.unei_only) {
      await sendChannelMessage(
        env.DISCORD_BOT_TOKEN,
        channels.unei_only,
        `【要対応】個人開発領の画像処理が${job.attempts}回失敗しました（${payload.requester_mc_name}）。タスクを起票しました。`,
      ).catch(() => {});
    }
    return;
  }

  const result = outcome.result as CtSetResult;
  const application = await getApplication(env, payload.application_id);
  if (!application) return;

  if (result.outcome === "held") {
    await markHeldAndNotify(env, application, result);
    return;
  }

  if (result.outcome === "rejected") {
    await updateApplicationStatus(env, payload.application_id, "rejected", { payload: result }).catch(() => {});
    await writeAuditLog(env, {
      actor: "bot",
      action: "kaihatsu_set_rejected",
      target: String(payload.application_id),
      detail: { mc_name: payload.requester_mc_name, reasons: result.reasons },
    });

    if (!channelId) return;
    const { content, embed } = buildRejectedEmbed({
      mentionDiscordId: payload.requester_discord_id,
      mcName: payload.requester_mc_name,
      reasons: result.reasons,
    });
    await postWithOptionalImage(env, channelId, content, embed, result.confirmation_image_base64, `rejected_${payload.application_id}.png`);
    return;
  }

  // 単独申請は仮承認を経ず即時確定する（§5.7.2）。
  await finalizeApprovedSet(env, application, result, payload.previous_own_claim?.claim_id ?? null);
}

// ── 代表者一括申請・同時処理グループのset側（§5.7.3・§5.7.4） ────────────

async function handleKaihatsuBatchCompletion(
  env: Env,
  job: JobRow,
  payload: KaihatsuBatchJobPayload,
  outcome: { status: "done" | "failed"; result?: unknown; error?: string },
): Promise<void> {
  const channels = await getChannels(env);
  const isGroup = payload.subkind === "kaihatsu_group";

  if (outcome.status === "failed") {
    const retry = await getJobRetrySetting(env);
    if (job.attempts < retry.crafty_max_attempts) return;
    await markFailedTerminal(env, job.id);

    for (const p of payload.players) {
      await updateApplicationStatus(env, p.application_id, "failed").catch(() => {});
    }
    await env.DB.prepare(
      `INSERT INTO tasks (type, title, summary, related_rule, status, priority, created_at)
       VALUES ('T-A', ?, ?, '§5.7.3', 'unassigned', 'high', strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
    )
      .bind(
        `代表者一括申請の画像処理失敗（${payload.players.length}名分）`,
        `job_queue #${job.id} が${job.attempts}回失敗しました。エラー: ${outcome.error ?? "不明"}`,
      )
      .run();
    if (channels.unei_only) {
      await sendChannelMessage(env.DISCORD_BOT_TOKEN, channels.unei_only, `【要対応】代表者一括申請の画像処理が失敗しました（job #${job.id}）。タスクを起票しました。`).catch(() => {});
    }
    return;
  }

  const result = outcome.result as { players: Record<string, CtSetResult>; unresolved_players: string[]; skipped_files: string[] };
  const prevByAppId = new Map(payload.players.map((p) => [p.application_id, p.previous_own_claim?.claim_id ?? null]));

  let anyRejected = false;
  let groupKey: string | null = null;
  const provisionalApplications: Array<{ application: ApplicationRow; result: CtSetResult }> = [];

  for (const [playerName, r] of Object.entries(result.players)) {
    const applicationId = r.application_id;
    if (applicationId == null) continue;
    const application = await getApplication(env, applicationId);
    if (!application) continue;
    if (application.group_key) groupKey = application.group_key;

    if (r.outcome === "held") {
      if (isGroup) {
        // グループのset側でheldになった場合、仕様上明記のない相互作用のため、安全側に倒して
        // グループ全体を却下する（設計上の単純化。詳細はgroupResolution.tsのコメント参照）。
        anyRejected = true;
        await updateApplicationStatus(env, applicationId, "rejected", {
          payload: { reasons: [`保留（他の仮承認・グループ予約との重複）: ${r.reasons.join(" / ")}`] },
        });
      } else {
        // 非グループの一括申請は単独申請と同様、却下ではなく保留として扱う（§5.7.5）。
        await markHeldAndNotify(env, application, r);
      }
      continue;
    }

    if (r.outcome === "rejected") {
      anyRejected = true;
      await updateApplicationStatus(env, applicationId, "rejected", { payload: r });
      await writeAuditLog(env, { actor: "bot", action: "kaihatsu_batch_member_rejected", target: String(applicationId), detail: { mc_name: playerName, reasons: r.reasons } });
      if (!isGroup && channels.kaihatsu_ryo) {
        const { content, embed } = buildRejectedEmbed({ mentionDiscordId: application.requester, mcName: playerName, reasons: r.reasons });
        await postWithOptionalImage(env, channels.kaihatsu_ryo, content, embed, r.confirmation_image_base64, `rejected_${applicationId}.png`).catch(() => {});
      }
      continue;
    }

    // approved（形式要件は充足。ここから72時間の本人確認・§5.7.3）
    await markProvisional(env, application, r, prevByAppId.get(applicationId) ?? null);
    provisionalApplications.push({ application, result: r });

    await writeAuditLog(env, { actor: "bot", action: "kaihatsu_batch_member_provisional", target: String(applicationId), detail: { mc_name: playerName } });

    if (!isGroup && channels.kaihatsu_ryo) {
      const { content, embed } = buildProvisionalApprovedChannelEmbed({
        mentionDiscordId: application.requester,
        mcName: playerName,
        representativeMention: `<@${application.submitted_by ?? application.requester}>`,
        areaBlocks: r.area_blocks ?? 0,
      });
      await sendChannelMessage(env.DISCORD_BOT_TOKEN, channels.kaihatsu_ryo, content, [embed]).catch(() => {});
    }
  }

  if (result.unresolved_players.length > 0) {
    anyRejected = anyRejected || isGroup; // グループの場合は未紐づけの参加者もグループ却下の対象
  }

  if (isGroup) {
    // グループはこの時点で1人でも却下があれば全体を却下、なければ全員へ本人確認DMを送る。
    await tryResolveGroupAfterSetEvaluation(env, groupKey, provisionalApplications, anyRejected);
  } else {
    for (const { application, result: r } of provisionalApplications) {
      await sendProvisionalConfirmDm(env, application, r);
    }
  }
}

async function tryResolveGroupAfterSetEvaluation(
  env: Env,
  groupKey: string | null,
  provisionalApplications: Array<{ application: ApplicationRow; result: CtSetResult }>,
  anySetMemberRejected: boolean,
): Promise<void> {
  if (!groupKey) return;
  if (anySetMemberRejected) {
    await tryResolveGroup(env, groupKey); // applications側は既にrejectedに更新済みなので、これがグループ却下を確定させる
    return;
  }
  for (const { application, result } of provisionalApplications) {
    await sendProvisionalConfirmDm(env, application, result);
  }
}

async function sendProvisionalConfirmDm(env: Env, application: ApplicationRow, ctResult: CtSetResult): Promise<void> {
  const deadlines = await getDeadlines(env);
  const provisionalUntilRow = await env.DB.prepare("SELECT provisional_until FROM applications WHERE id = ?").bind(application.id).first<{ provisional_until: string | null }>();
  const provisionalUntil = provisionalUntilRow?.provisional_until ?? addHoursIso(new Date().toISOString(), deadlines.provisional_confirm_hours);
  const discordTs = `<t:${Math.floor(new Date(provisionalUntil).getTime() / 1000)}:f>`;

  const embed = buildProvisionalConfirmEmbed({
    mcName: application.owner_mc_name ?? "",
    representativeMention: `<@${application.submitted_by ?? application.requester}>`,
    areaBlocks: ctResult.area_blocks ?? 0,
    confirmDeadlineDiscordTimestamp: discordTs,
    groupNote: application.group_key ? "この届出は同時処理グループの一部です。グループ内の全員が確認するまで正式承認は確定しません。" : undefined,
  });
  const buttons = buildConfirmWithdrawButtonRow(application.id);

  if (ctResult.confirmation_image_base64) {
    const filename = `provisional_${application.id}.png`;
    embed.image = { url: `attachment://${filename}` };
    await sendDirectMessageWithComponentsAndFile(
      env.DISCORD_BOT_TOKEN,
      application.requester,
      "",
      buttons,
      { filename, bytes: base64ToBytes(ctResult.confirmation_image_base64) },
      [embed],
    ).catch((e) => console.error("provisional confirm DM failed", e));
  } else {
    await sendDirectMessageWithComponents(env.DISCORD_BOT_TOKEN, application.requester, "", buttons, [embed]).catch((e) =>
      console.error("provisional confirm DM failed", e),
    );
  }
}

async function postWithOptionalImage(
  env: Env,
  channelId: string,
  content: string,
  embed: Record<string, unknown>,
  base64Image: string | undefined,
  filename: string,
): Promise<void> {
  try {
    if (base64Image) {
      embed.image = { url: `attachment://${filename}` };
      await sendChannelMessageWithFile(env.DISCORD_BOT_TOKEN, channelId, content, { filename, bytes: base64ToBytes(base64Image) }, [embed]);
    } else {
      await sendChannelMessage(env.DISCORD_BOT_TOKEN, channelId, content, [embed]);
    }
  } catch (e) {
    console.error("kaihatsu_set: channel post failed", e);
  }
}

async function handleCraftyOpCompletion(
  env: Env,
  job: JobRow,
  outcome: { status: "done" | "failed"; error?: string },
): Promise<void> {
  if (outcome.status === "done") return;

  const retry = await getJobRetrySetting(env);
  if (job.attempts < retry.crafty_max_attempts) return; // まだ再試行の余地あり（次回ポーリングで再取得される）

  // 上限到達：以後は再試行させない（通知の連投防止。§6.4.4の再試行上限の趣旨）。
  await markFailedTerminal(env, job.id);

  const payload = JSON.parse(job.payload) as CraftyOpPayload;
  const channels = await getChannels(env);

  await env.DB.prepare(
    `INSERT INTO tasks (type, title, summary, related_rule, status, priority, created_at)
     VALUES ('T-A', ?, ?, ?, 'unassigned', 'high', strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
  )
    .bind(
      `ホワイトリスト${payload.op === "add" ? "追加" : "削除"}の失敗：${payload.mc_name}`,
      `Crafty API経由の whitelist ${payload.op} が${job.attempts}回失敗しました。手動での確認・対応が必要です。エラー: ${outcome.error ?? "不明"}`,
      "§6.4.4",
    )
    .run();

  if (channels.unei_only) {
    await sendChannelMessage(
      env.DISCORD_BOT_TOKEN,
      channels.unei_only,
      `【要対応】ホワイトリスト${payload.op === "add" ? "追加" : "削除"}が${job.attempts}回失敗しました（${payload.mc_name}）。タスクを起票しました。`,
    ).catch(() => {});
  }
}

async function handleWhitelistAuditCompletion(
  env: Env,
  job: JobRow,
  outcome: { status: "done" | "failed"; result?: unknown; error?: string },
): Promise<void> {
  const channels = await getChannels(env);
  if (!channels.unei_only) return;

  if (outcome.status === "failed") {
    const retry = await getJobRetrySetting(env);
    if (job.attempts < retry.crafty_max_attempts) return;

    // 上限到達：以後は再試行させない（通知の連投防止。§6.4.4の再試行上限の趣旨）。
    await markFailedTerminal(env, job.id);

    await sendChannelMessage(
      env.DISCORD_BOT_TOKEN,
      channels.unei_only,
      `【要対応】日次ホワイトリスト突合が取得できませんでした（${job.attempts}回失敗）。Crafty側の状態を確認してください。`,
    ).catch(() => {});
    return;
  }

  const result = outcome.result as { whitelisted_names?: string[] } | undefined;
  const craftyNames = result?.whitelisted_names ?? [];
  const craftyLower = new Set(craftyNames.map((n) => n.toLowerCase()));

  const active = await env.DB.prepare(
    "SELECT minecraft_name FROM account_links WHERE status = 'active'",
  ).all<{ minecraft_name: string }>();
  const ledgerNames = (active.results ?? []).map((r) => r.minecraft_name);
  const ledgerLower = new Set(ledgerNames.map((n) => n.toLowerCase()));

  // 表示は元の大文字小文字を保つ。比較のみ大文字小文字を無視する。
  const onlyOnCrafty = craftyNames.filter((n) => !ledgerLower.has(n.toLowerCase()));
  const onlyOnLedger = ledgerNames.filter((n) => !craftyLower.has(n.toLowerCase()));

  if (onlyOnCrafty.length === 0 && onlyOnLedger.length === 0) return; // 差分なし。平常時は静かに終える

  const lines = [
    "【日次ホワイトリスト突合】台帳とCraftyの実状態に差分があります（手動操作の検知）。",
    onlyOnCrafty.length ? `Craftyのみに存在：${onlyOnCrafty.join(", ")}` : null,
    onlyOnLedger.length ? `台帳のみに存在：${onlyOnLedger.join(", ")}` : null,
  ].filter(Boolean);

  await sendChannelMessage(env.DISCORD_BOT_TOKEN, channels.unei_only, lines.join("\n")).catch(() => {});
}

async function handleDynmapSyncCompletion(
  env: Env,
  job: JobRow,
  outcome: { status: "done" | "failed"; result?: unknown; error?: string },
): Promise<void> {
  if (outcome.status === "done") return;

  const retry = await getJobRetrySetting(env);
  if (job.attempts < retry.crafty_max_attempts) return;
  await markFailedTerminal(env, job.id);

  const payload = JSON.parse(job.payload) as { op: string; mc_name: string };
  const channels = await getChannels(env);

  await env.DB.prepare(
    `INSERT INTO tasks (type, title, summary, related_rule, status, priority, created_at)
     VALUES ('T-A', ?, ?, '§6.3.4', 'unassigned', 'medium', strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
  )
    .bind(
      `Dynmap反映失敗：${payload.mc_name}（${payload.op}）`,
      `Dynmapへの自動反映が${job.attempts}回失敗しました。手動での配置・regions更新が必要です。エラー: ${outcome.error ?? "不明"}`,
    )
    .run();

  if (channels.unei_only) {
    await sendChannelMessage(
      env.DISCORD_BOT_TOKEN,
      channels.unei_only,
      `【要対応】Dynmapへの自動反映が失敗しました（${payload.mc_name} / ${payload.op}）。タスクを起票しました。`,
    ).catch(() => {});
  }
}
