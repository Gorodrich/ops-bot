// /ops cost・/ops log・/ops dashboard（利用枠消費状況・監査ログ確認・ダッシュボード即時更新）。

import type { Env } from "../env";
import { type CommandOption, type Interaction, InteractionResponseType, optionValue } from "../discord/types";
import { getLlmSetting, patchLlmSetting } from "../settings";
import { resolveUneiActor } from "../staff/subaccountEligibility";
import { EPHEMERAL_FLAG, sendFollowupMessage } from "../discord/rest";
import type { DeferredResult } from "../accountLinks/authoriseCommand";
import { updateDashboards } from "../cron/dashboard";
import { deleteDashboardMessage } from "../dashboard/repo";

function immediate(content: string): DeferredResult {
  return {
    ack: { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content, flags: EPHEMERAL_FLAG } },
    followUp: async () => {},
  };
}

async function requireUnei(env: Env, interaction: Interaction): Promise<string | null> {
  const resolved = await resolveUneiActor(env, interaction.member);
  return resolved.ok ? null : resolved.message;
}

export async function handleOpsCost(env: Env, interaction: Interaction): Promise<DeferredResult> {
  const err = await requireUnei(env, interaction);
  if (err) return immediate(err);

  const totals = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok_count,
       SUM(CASE WHEN created_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day') THEN 1 ELSE 0 END) AS last_24h,
       SUM(CASE WHEN created_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-7 days') THEN 1 ELSE 0 END) AS last_7d
     FROM llm_usage WHERE kind = 'claude_code'`,
  ).first<{ total: number; ok_count: number; last_24h: number; last_7d: number }>();

  if (!totals || totals.total === 0) {
    return immediate("LLM呼び出しの記録はまだありません（C-1：機械判定できる処理はLLMを介さないため、記録が少ないのは正常です）。");
  }

  // トークン・コストはCT側（ct/opsbot_ct/llm.py）がCLIの--output-format jsonエンベロープから
  // detail列へ書き込んだメタ情報から集計する（§7.4：Pro利用枠でも参考値として返るtotal_cost_usdを含む）。
  const usage = await env.DB.prepare(
    `SELECT
       SUM(COALESCE(json_extract(detail, '$.usage.input_tokens'), 0)) AS input_tokens,
       SUM(COALESCE(json_extract(detail, '$.usage.output_tokens'), 0)) AS output_tokens,
       SUM(COALESCE(json_extract(detail, '$.total_cost_usd'), 0)) AS total_cost_usd,
       COUNT(json_extract(detail, '$.model')) AS with_model_count
     FROM llm_usage WHERE kind = 'claude_code' AND ok = 1`,
  ).first<{ input_tokens: number; output_tokens: number; total_cost_usd: number; with_model_count: number }>();

  const latestModel = await env.DB.prepare(
    `SELECT json_extract(detail, '$.model') AS model FROM llm_usage
     WHERE kind = 'claude_code' AND ok = 1 AND json_extract(detail, '$.model') IS NOT NULL
     ORDER BY id DESC LIMIT 1`,
  ).first<{ model: string | null }>();

  const lines = [
    "【LLM利用枠消費状況（llm_usage）】",
    `累計呼び出し：${totals.total}件（成功 ${totals.ok_count}件）`,
    `直近24時間：${totals.last_24h}件 ／ 直近7日：${totals.last_7d}件`,
  ];

  if (usage && usage.with_model_count > 0) {
    lines.push(`使用モデル（直近）：${latestModel?.model ?? "不明"}`);
    lines.push(
      `累計トークン（成功分・入力/出力）：${usage.input_tokens.toLocaleString()} / ${usage.output_tokens.toLocaleString()}`,
    );
    lines.push(`参考コスト換算合計：$${usage.total_cost_usd.toFixed(4)}（Pro利用枠のためAPI従量課金は発生していません）`);
  } else {
    lines.push("トークン・コストのメタ情報はまだ記録されていません（古いバージョンのCLI、または成功呼び出しがまだ無いため）。");
  }

  lines.push("Claude Pro利用枠は開発者の日常利用と共有されるため、逼迫時はC-2により縮退運転（LLM層停止時も他機能は継続）します。");

  return immediate(lines.join("\n"));
}

export async function handleOpsLog(env: Env, interaction: Interaction, options: CommandOption[]): Promise<DeferredResult> {
  const err = await requireUnei(env, interaction);
  if (err) return immediate(err);

  const limitRaw = optionValue(options, "limit");
  const limit = Math.min(Math.max(Number(limitRaw ?? 20) || 20, 1), 50);
  const actorFilter = optionValue(options, "actor");

  const query = actorFilter
    ? env.DB.prepare("SELECT actor, action, target, created_at FROM audit_log WHERE actor = ? ORDER BY created_at DESC LIMIT ?").bind(actorFilter, limit)
    : env.DB.prepare("SELECT actor, action, target, created_at FROM audit_log ORDER BY created_at DESC LIMIT ?").bind(limit);

  const res = await query.all<{ actor: string | null; action: string; target: string | null; created_at: string }>();
  const rows = res.results ?? [];
  if (rows.length === 0) return immediate("該当する監査ログがありません。");

  const lines = rows.map((r) => `${r.created_at}｜${r.actor ?? "-"}｜${r.action}${r.target ? `｜対象:${r.target}` : ""}`);
  return immediate(["【監査ログ（直近から）】", ...lines].join("\n"));
}

export async function handleOpsLlm(env: Env, interaction: Interaction, options: CommandOption[]): Promise<DeferredResult> {
  const err = await requireUnei(env, interaction);
  if (err) return immediate(err);

  const action = optionValue(options, "action") ?? "status";
  const setting = await getLlmSetting(env);

  if (action === "pause") {
    if (setting.paused) return immediate("LLM層は既に一時停止中です。");
    await patchLlmSetting(env, { paused: true });
    return immediate("LLM層を一時停止しました（C-2：他の全機能は継続動作します）。`/ops llm action:resume` で再開できます。");
  }
  if (action === "resume") {
    if (!setting.paused) return immediate("LLM層は現在停止していません。");
    await patchLlmSetting(env, { paused: false });
    return immediate("LLM層を再開しました。");
  }

  const pendingCount = await env.DB.prepare(
    "SELECT COUNT(*) as n FROM llm_shadow_detections WHERE status NOT IN ('resolved', 'candidate_rejected')",
  ).first<{ n: number }>();
  const shadowMode = setting.shadow_mode !== false;
  return immediate(
    [
      `【LLM層の状態（${shadowMode ? "シャドーモード" : "本稼働"}）】`,
      `一時停止：${setting.paused ? "はい" : "いいえ"}`,
      `モード：${shadowMode ? "シャドーモード（実タスク起票なし・開発者DMのみ）" : "本稼働（実タスク起票・実担当者への通知あり）"}`,
      `確信度しきい値：${setting.confidence_threshold}／連続失敗しきい値：${setting.consecutive_failure_pause_threshold}`,
      `検出：処理待ち ${pendingCount?.n ?? 0} 件`,
      setting.developer_discord_id ? "" : "【要設定】settings.llm.developer_discord_id が未記入のため、開発者への通知DMが送れません。",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

export async function handleOpsDashboard(env: Env, interaction: Interaction, options: CommandOption[]): Promise<DeferredResult> {
  const err = await requireUnei(env, interaction);
  if (err) return immediate(err);

  const action = optionValue(options, "action") ?? "update";

  return {
    ack: { type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: EPHEMERAL_FLAG } },
    followUp: async () => {
      let content: string;
      try {
        if (action === "repost") {
          // 運営専用チャンネルは他の運営通知（新規タスク等）と混在し既存のダッシュボードが埋もれるため、
          // 参照だけ破棄して次の更新で新規投稿させる（古いメッセージ自体は削除せず放置する）
          await deleteDashboardMessage(env, "ops");
        }
        await updateDashboards(env);
        content = action === "repost" ? "ダッシュボードを再投稿しました（以前のメッセージの更新は停止しました）。" : "ダッシュボードを即時更新しました。";
      } catch (e) {
        console.error("ダッシュボードの即時更新に失敗", e);
        content = "ダッシュボードの即時更新に失敗しました（ログを確認してください）。";
      }
      await sendFollowupMessage(env.DISCORD_APP_ID, interaction.token, { content });
    },
  };
}
