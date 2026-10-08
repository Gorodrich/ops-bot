// 障害お知らせ（/shogai・decisions.md #66）の単体テスト：日時の解釈・整形、Embedの組み立て、投稿フロー（採番・ロールバック）。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, mockFetch, setSetting } from "./helpers/d1.mjs";
import {
  buildGeneralFirstMessage,
  buildGeneralResolvedMessage,
  buildIncidentEmbed,
  formatDuration,
  formatNextNotice,
  formatOccurrence,
  formatResumeEta,
  markImpactRecovered,
  parseJstDateTime,
  resolvedLead,
} from "../src/incidents/domain";
import {
  handleShogaiModalSubmit,
  handleShogaiResolve,
  handleShogaiStart,
  handleShogaiUpdate,
  postReport,
} from "../src/incidents/shogaiCommand";

// 2026-10-08 15:00 JST
const NOW = "2026-10-08T06:00:00Z";

describe("parseJstDateTime", () => {
  it("H:MM は今日（JST）として解釈する", () => {
    expect(parseJstDateTime("14:05", NOW)).toBe("2026-10-08T05:05:00Z");
  });

  it("H:MM が現在より先なら前日とみなす（日付またぎ）", () => {
    expect(parseJstDateTime("23:30", NOW)).toBe("2026-10-07T14:30:00Z");
  });

  it("数分先までは当日扱い", () => {
    expect(parseJstDateTime("15:03", NOW)).toBe("2026-10-08T06:03:00Z");
  });

  it("M/D H:MM・YYYY/M/D H:MM・全角を受け付ける", () => {
    expect(parseJstDateTime("10/7 9:00", NOW)).toBe("2026-10-07T00:00:00Z");
    expect(parseJstDateTime("2026/10/7 9:00", NOW)).toBe("2026-10-07T00:00:00Z");
    expect(parseJstDateTime("１０／７　９：００", NOW)).toBe("2026-10-07T00:00:00Z");
  });

  it("不正な形式・存在しない日付・未来の日付は null", () => {
    expect(parseJstDateTime("昼ごろ", NOW)).toBeNull();
    expect(parseJstDateTime("25:00", NOW)).toBeNull();
    expect(parseJstDateTime("2/30 10:00", NOW)).toBeNull();
    expect(parseJstDateTime("10/9 10:00", NOW)).toBeNull();
  });
});

describe("期間・発生日時・次回のお知らせの整形", () => {
  it("formatDuration", () => {
    expect(formatDuration("2026-10-08T05:00:00Z", "2026-10-08T05:45:00Z")).toBe("約45分");
    expect(formatDuration("2026-10-08T05:00:00Z", "2026-10-08T08:00:00Z")).toBe("約3時間");
    expect(formatDuration("2026-10-08T05:00:00Z", "2026-10-08T08:20:00Z")).toBe("約3時間20分");
  });

  it("formatOccurrence：継続中／同日復旧は時刻のみ／日付またぎは日付つき", () => {
    expect(formatOccurrence("2026-10-08T05:05:00Z", null)).toBe("2026年10月8日 14:05頃 〜（継続中）");
    expect(formatOccurrence("2026-10-08T05:05:00Z", "2026-10-08T07:05:00Z")).toBe("2026年10月8日 14:05頃 〜 16:05（約2時間）");
    expect(formatOccurrence("2026-10-07T14:00:00Z", "2026-10-08T01:00:00Z")).toBe(
      "2026年10月7日 23:00頃 〜 2026年10月8日 10:00（約11時間）",
    );
  });

  it("formatNextNotice：時刻だけなら定型文に展開・未入力なら既定文", () => {
    expect(formatNextNotice("16:00", 3)).toBe("16:00までに第3報を出します（それまでに復旧した場合は復旧時にお知らせします）。");
    expect(formatNextNotice("１６：００", 2)).toContain("16:00までに第2報");
    expect(formatNextNotice("再開時にお知らせします", 2)).toBe("再開時にお知らせします");
    expect(formatNextNotice(undefined, 2)).toBe("状況に変化があり次第お知らせします。");
  });

  it("markImpactRecovered：通常どおり以外の行を復旧済みに書き換える", () => {
    const before = "- Minecraftサーバー：停止中\n- Dynmap：一部不安定\n- OpsBot：通常どおり\n補足の行";
    expect(markImpactRecovered(before)).toBe("- Minecraftサーバー：**復旧済み**\n- Dynmap：**復旧済み**\n- OpsBot：通常どおり\n補足の行");
  });
});

describe("buildIncidentEmbed", () => {
  const base = {
    incidentId: 7,
    subject: "Minecraftサーバー",
    postedAt: "2026-10-08T06:00:00Z",
    startedAt: "2026-10-08T05:05:00Z",
    lead: "冒頭",
    impact: "- Minecraftサーバー：停止中",
    cause: "調査中です。",
    dataImpact: "調査中です。",
  };

  it("続報：見出し・現在時刻・次回のお知らせを含む", () => {
    const e = buildIncidentEmbed({ ...base, kind: "update", reportNo: 2, headline: "復旧作業中", resolvedAt: null, eta: "未定", nextNotice: "x" });
    expect(e.title).toBe("【第2報】Minecraftサーバー障害（復旧作業中）");
    expect(e.description).toBe("2026年10月8日 15:00 現在\n\n冒頭");
    expect(e.fields.map((f) => f.name)).toEqual(["1. 発生日時", "2. 影響範囲", "3. 原因", "4. 復旧見込み", "5. データへの影響", "次回のお知らせ"]);
  });

  it("復旧報：経緯・再発防止策・補填の欄になり、空欄は「—」", () => {
    const e = buildIncidentEmbed({
      ...base,
      kind: "resolved",
      reportNo: 3,
      headline: "全サービス復旧",
      resolvedAt: "2026-10-08T06:00:00Z",
      timeline: "- 経緯",
      prevention: "",
      compensation: "なし",
    });
    expect(e.title).toBe("【復旧報】Minecraftサーバー障害（全サービス復旧）");
    expect(e.fields.map((f) => f.name)).toEqual(["1. 発生日時", "2. 影響範囲", "3. 原因", "4. 復旧までの経緯", "5. データへの影響", "6. 再発防止策", "補填"]);
    expect(e.fields[5].value).toBe("—");
  });

  it("長すぎるフィールドは1024文字に切り詰める", () => {
    const e = buildIncidentEmbed({ ...base, kind: "first", reportNo: 1, headline: "停止中", resolvedAt: null, cause: "あ".repeat(2000) });
    expect(e.fields[2].value.length).toBe(1024);
  });
});

describe("全般用お知らせの文面", () => {
  const START = "2026-10-08T05:05:00Z"; // 10/8 14:05 JST

  it("formatResumeEta：時刻は「M月D日 H:MMごろ」に展開（過ぎた時刻は翌日）、それ以外はそのまま", () => {
    expect(formatResumeEta("18:00", NOW)).toBe("10月8日 18:00ごろ");
    expect(formatResumeEta("9:00", NOW)).toBe("10月9日 9:00ごろ");
    expect(formatResumeEta("10/10 12:00", NOW)).toBe("10月10日 12:00ごろ");
    expect(formatResumeEta("10月9日以降", NOW)).toBe("10月9日以降");
  });

  it("マイクラ鯖ダウン時の第1報：@everyone・【重要】版", () => {
    const msg = buildGeneralFirstMessage({
      minecraftDown: true,
      subject: "マイクラサーバー等の全サービス",
      startedAt: START,
      causeShort: "停電",
      resumeEta: "10月8日 18:00ごろ",
      worldDataSafe: true,
      detailChannelId: "CH_SERVER",
    });
    expect(msg).toBe(
      [
        "@everyone",
        "# 【重要】サーバー障害のお知らせとお詫び",
        "10月8日 14:05ごろから、停電により、マイクラサーバー等の全サービスが停止しています。",
        "再開は10月8日 18:00ごろの見込みです（見込みが変わればお知らせします）。ワールドデータは無事を確認済みです。",
        "ご迷惑をおかけし申し訳ございません。詳細は <#CH_SERVER> をご確認ください。",
      ].join("\n"),
    );
  });

  it("マイクラ鯖ダウン時の第1報：原因・見込み・データ未確定の既定文", () => {
    const msg = buildGeneralFirstMessage({
      minecraftDown: true,
      subject: "Minecraftサーバー",
      startedAt: START,
      causeShort: null,
      resumeEta: null,
      worldDataSafe: false,
      detailChannelId: "C",
    });
    expect(msg).toContain("原因を調査中の障害により、Minecraftサーバーが停止しています。");
    expect(msg).toContain("再開の見込みは未定です（見込みが立ち次第お知らせします）。ワールドデータは調査中です。");
  });

  it("一部サービスのみの第1報：メンションなし", () => {
    const msg = buildGeneralFirstMessage({
      minecraftDown: false,
      subject: "Dynmap",
      startedAt: START,
      causeShort: null,
      resumeEta: null,
      worldDataSafe: false,
      detailChannelId: "CH_SERVER",
    });
    expect(msg).toBe(
      [
        "# Dynmap障害のお知らせ",
        "10月8日 14:05ごろからDynmapに障害が発生しているため、一時的に停止しています。マイクラサーバーなどその他のサービスは通常どおり利用できます。",
        "ご迷惑をおかけし申し訳ございません。詳細は <#CH_SERVER> をご確認ください。",
      ].join("\n"),
    );
    expect(msg).not.toContain("@everyone");
  });

  it("マイクラ鯖ダウン時の復旧報：巻き戻しあり・長時間ならお詫びを強める", () => {
    const msg = buildGeneralResolvedMessage({
      minecraftDown: true,
      subject: "Minecraftサーバー",
      startedAt: START,
      resolvedAt: "2026-10-08T10:30:00Z", // 19:30
      rollbackTo: "2026-10-07T18:00:00Z", // 10/8 3:00
      detailChannelId: "CH_SERVER",
    });
    expect(msg).toBe(
      [
        "@everyone",
        "# 【重要】サーバー復旧のお知らせ",
        "10月8日 14:05ごろから発生していた障害は、10月8日 19:30に復旧しました。",
        "ワールドデータは10月8日 3:00時点に戻しました。異常に気づいた方はチケットでお知らせください。",
        "長期間にわたりご迷惑をおかけし、誠に申し訳ありませんでした。詳細は <#CH_SERVER> をご確認ください。",
      ].join("\n"),
    );
  });

  it("短時間の復旧報は「長期間にわたり」を付けない", () => {
    const msg = buildGeneralResolvedMessage({
      minecraftDown: true,
      subject: "Minecraftサーバー",
      startedAt: START,
      resolvedAt: "2026-10-08T05:50:00Z",
      rollbackTo: null,
      detailChannelId: "C",
    });
    expect(msg).toContain("ワールドデータは影響ありません。");
    expect(msg).toContain("\nご迷惑をおかけし、誠に申し訳ありませんでした。");
    expect(resolvedLead(START, "2026-10-08T05:50:00Z")).not.toContain("長時間");
    expect(resolvedLead(START, "2026-10-08T10:30:00Z")).toContain("長時間ご迷惑をおかけしました");
  });

  it("一部サービスのみの復旧報", () => {
    const msg = buildGeneralResolvedMessage({
      minecraftDown: false,
      subject: "監視システム",
      startedAt: START,
      resolvedAt: "2026-10-08T06:00:00Z",
      rollbackTo: null,
      detailChannelId: "C",
    });
    expect(msg).toBe(
      [
        "# 監視システム復旧のお知らせ",
        "10月8日 14:05ごろから発生していた監視システムの障害は、10月8日 15:00に復旧しました。ワールドデータやバックアップへの影響はありません。",
        "ご心配・ご迷惑をおかけし申し訳ありませんでした。",
      ].join("\n"),
    );
  });
});

// ── 投稿フロー ──────────────────────────────────────────

const ROLES = { hito: "R_HITO", kari_sanka: "R_KARI", sub_aka: "R_SUB", unei: "R_UNEI", unei_sub: "R_UNEI_SUB" };
const STAFF = { token: "t", member: { user: { id: "STAFF1" }, roles: ["R_UNEI"] } };

function opts(map) {
  return Object.entries(map).map(([name, value]) => ({ name, type: 3, value }));
}

function modalSubmit(customId, values) {
  return {
    ...STAFF,
    data: { custom_id: customId, components: Object.entries(values).map(([custom_id, value]) => ({ components: [{ custom_id, value }] })) },
  };
}

function modalValues(ack) {
  const out = {};
  for (const row of ack.data.components) out[row.components[0].custom_id] = row.components[0].value;
  return out;
}

function postedEmbeds(fetchMock) {
  return fetchMock.calls
    .filter((c) => c.url.includes("/channels/CH_SERVER/messages"))
    .map((c) => JSON.parse(c.body).embeds[0]);
}

function generalPosts(fetchMock) {
  return fetchMock.calls.filter((c) => c.url.includes("/channels/CH_GENERAL/messages")).map((c) => JSON.parse(c.body));
}

describe("/shogai 投稿フロー", () => {
  let env;
  let fetchMock;

  beforeEach(() => {
    env = createTestEnv();
    setSetting(env, "roles", ROLES);
    setSetting(env, "channels", { server_notice: "CH_SERVER", general_notice: "CH_GENERAL" });
    setSetting(env, "discord_guild_id", "G1");
    setSetting(env, "incident_notice", { services: ["Minecraftサーバー", "OpsBot"] });
    fetchMock = mockFetch();
  });

  afterEach(() => fetchMock.restore());

  async function submit(ack, overrides = {}) {
    const values = { ...modalValues(ack), ...overrides };
    const res = await handleShogaiModalSubmit(env, modalSubmit(ack.data.custom_id, values));
    await res.followUp();
    return res;
  }

  it("運営ロールが無ければモーダルを開かない", async () => {
    const res = await handleShogaiStart(env, { token: "t", member: { user: { id: "X" }, roles: [] } }, opts({ subject: "a", status: "b" }));
    expect(res.ack.type).toBe(4);
    expect(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM incident_reports").get().n).toBe(0);
  });

  it("第1報 → 続報 → 復旧報：番号・前報の引継ぎ・障害の状態", async () => {
    const start = await handleShogaiStart(
      env,
      STAFF,
      opts({ subject: "Minecraftサーバー", status: "サーバー停止中", minecraft_down: true, started_at: "14:05", next: "16:00" }),
    );
    expect(start.ack.type).toBe(9);
    expect(modalValues(start.ack).impact).toBe("- Minecraftサーバー：通常どおり\n- OpsBot：通常どおり");
    await submit(start.ack, { impact: "- Minecraftサーバー：停止中\n- OpsBot：通常どおり" });

    const incident = env.DB.raw.prepare("SELECT * FROM incidents").get();
    expect(incident.status).toBe("open");

    // 継続中が1件なら incident 省略可。前報の内容が初期値に入る。
    const update = await handleShogaiUpdate(env, STAFF, opts({ status: "復旧作業中" }));
    expect(update.ack.type).toBe(9);
    expect(modalValues(update.ack).impact).toBe("- Minecraftサーバー：停止中\n- OpsBot：通常どおり");
    await submit(update.ack, { cause: "ディスク障害" });

    const resolve = await handleShogaiResolve(env, STAFF, opts({}));
    const rv = modalValues(resolve.ack);
    expect(rv.impact).toBe("- Minecraftサーバー：**復旧済み**\n- OpsBot：通常どおり");
    expect(rv.cause).toBe("ディスク障害");
    await submit(resolve.ack, { prevention: "- 監視の追加" });

    const embeds = postedEmbeds(fetchMock);
    expect(embeds.map((e) => e.title)).toEqual([
      "【第1報】Minecraftサーバー障害（サーバー停止中）",
      "【第2報】Minecraftサーバー障害（復旧作業中）",
      "【復旧報】Minecraftサーバー障害（全サービス復旧）",
    ]);
    expect(embeds[0].fields.at(-1).value).toBe("16:00までに第2報を出します（それまでに復旧した場合は復旧時にお知らせします）。");
    expect(embeds[2].fields.at(-1)).toEqual({ name: "補填", value: "なし" });

    expect(env.DB.raw.prepare("SELECT status FROM incidents").get().status).toBe("resolved");
    expect(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM incident_reports WHERE status = 'posted'").get().n).toBe(3);

    // 全般用お知らせは第1報・復旧報のときだけ。マイクラ鯖ダウンなので @everyone を通知として解釈させる。
    const general = generalPosts(fetchMock);
    expect(general).toHaveLength(2);
    expect(general[0].content).toMatch(/^@everyone\n# 【重要】サーバー障害のお知らせとお詫び/);
    expect(general[1].content).toMatch(/^@everyone\n# 【重要】サーバー復旧のお知らせ/);
    for (const g of general) expect(g.allowed_mentions).toEqual({ parse: ["everyone"] });

    // 復旧後は続報を出せない
    const after = await handleShogaiUpdate(env, STAFF, opts({}));
    expect(after.ack.data.content).toContain("継続中の障害がありません");
  });

  it("一部サービスのみの障害は全般用お知らせをメンションなしで投稿する", async () => {
    const start = await handleShogaiStart(env, STAFF, opts({ subject: "Dynmap", status: "停止中", minecraft_down: false }));
    await submit(start.ack);
    const resolve = await handleShogaiResolve(env, STAFF, opts({}));
    await submit(resolve.ack);
    const general = generalPosts(fetchMock);
    expect(general.map((g) => g.content.split("\n")[0])).toEqual(["# Dynmap障害のお知らせ", "# Dynmap復旧のお知らせ"]);
    for (const g of general) expect(g.allowed_mentions).toEqual({ parse: [] });
  });

  it("announce:false なら全般用お知らせを出さない", async () => {
    const start = await handleShogaiStart(env, STAFF, opts({ subject: "A", status: "停止中", minecraft_down: true, announce: false }));
    await submit(start.ack);
    expect(postedEmbeds(fetchMock)).toHaveLength(1);
    expect(generalPosts(fetchMock)).toHaveLength(0);
  });

  it("全般用お知らせの投稿先が未設定なら、announce:false を促してモーダルを開かない", async () => {
    setSetting(env, "channels", { server_notice: "CH_SERVER" });
    const res = await handleShogaiStart(env, STAFF, opts({ subject: "A", status: "停止中", minecraft_down: true }));
    expect(res.ack.type).toBe(4);
    expect(res.ack.data.content).toContain("announce:False");
  });

  it("全般用お知らせだけ失敗しても詳細報は巻き戻さず、実行者に手動投稿を促す", async () => {
    fetchMock.restore();
    fetchMock = mockFetch((url) => (url.includes("/channels/CH_GENERAL/messages") ? new Response("boom", { status: 403 }) : undefined));
    const start = await handleShogaiStart(env, STAFF, opts({ subject: "A", status: "停止中", minecraft_down: true }));
    await handleShogaiModalSubmit(env, modalSubmit(start.ack.data.custom_id, modalValues(start.ack)));
    const draftId = Number(start.ack.data.custom_id.split(":").at(-1));
    const msg = await postReport(env, draftId, "STAFF1");
    expect(msg).toContain("全般用お知らせの投稿に失敗しました");
    expect(env.DB.raw.prepare("SELECT status FROM incidents").get().status).toBe("open");
    expect(env.DB.raw.prepare("SELECT status FROM incident_reports").get().status).toBe("posted");
  });

  it("rollback_to を指定すると復旧報のデータへの影響・全般用お知らせに反映される", async () => {
    const start = await handleShogaiStart(env, STAFF, opts({ subject: "A", status: "停止中", minecraft_down: true, started_at: "2026/10/1 10:00" }));
    await submit(start.ack);
    const resolve = await handleShogaiResolve(env, STAFF, opts({ rollback_to: "2026/10/1 9:00" }));
    expect(modalValues(resolve.ack).data_impact).toContain("- 巻き戻し：あり（10月1日 9:00時点に戻しました）");
    await submit(resolve.ack);
    expect(generalPosts(fetchMock)[1].content).toContain("ワールドデータは10月1日 9:00時点に戻しました。");
  });

  it("同じモーダルを二重送信しても1回しか投稿しない", async () => {
    const start = await handleShogaiStart(env, STAFF, opts({ subject: "A", status: "停止中" }));
    await submit(start.ack);
    const again = await handleShogaiModalSubmit(env, modalSubmit(start.ack.data.custom_id, modalValues(start.ack)));
    expect(again.ack.data.content).toContain("既に投稿済み");
    expect(postedEmbeds(fetchMock)).toHaveLength(1);
  });

  it("同時に開いた続報も送信時点で採番するため番号が重複しない", async () => {
    const start = await handleShogaiStart(env, STAFF, opts({ subject: "A", status: "停止中" }));
    await submit(start.ack);
    const u1 = await handleShogaiUpdate(env, STAFF, opts({}));
    const u2 = await handleShogaiUpdate(env, STAFF, opts({}));
    await submit(u1.ack);
    await submit(u2.ack);
    expect(postedEmbeds(fetchMock).map((e) => e.title.slice(0, 5))).toEqual(["【第1報】", "【第2報】", "【第3報】"]);
  });

  it("Discordへの投稿に失敗したら第1報の障害登録を取り消す", async () => {
    fetchMock.restore();
    fetchMock = mockFetch((url) => (url.includes("/channels/CH_SERVER/messages") ? new Response("boom", { status: 500 }) : undefined));
    const start = await handleShogaiStart(env, STAFF, opts({ subject: "A", status: "停止中" }));
    await submit(start.ack);
    expect(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM incidents").get().n).toBe(0);
    const draft = env.DB.raw.prepare("SELECT * FROM incident_reports").get();
    expect(draft.status).toBe("draft");
    expect(draft.report_no).toBeNull();
  });

  it("復旧報の投稿に失敗したら障害を継続中に戻す", async () => {
    const start = await handleShogaiStart(env, STAFF, opts({ subject: "A", status: "停止中" }));
    await submit(start.ack);
    const resolve = await handleShogaiResolve(env, STAFF, opts({}));
    const values = modalValues(resolve.ack);
    await handleShogaiModalSubmit(env, modalSubmit(resolve.ack.data.custom_id, values)); // draft に書き込むだけ
    fetchMock.restore();
    fetchMock = mockFetch((url) => (url.includes("/channels/CH_SERVER/messages") ? new Response("boom", { status: 500 }) : undefined));
    const draftId = Number(resolve.ack.data.custom_id.split(":").at(-1));
    await expect(postReport(env, draftId, "STAFF1")).rejects.toThrow();
    expect(env.DB.raw.prepare("SELECT status FROM incidents").get().status).toBe("open");
  });

  it("復旧日時が発生日時より前なら拒否する", async () => {
    const start = await handleShogaiStart(env, STAFF, opts({ subject: "A", status: "停止中" }));
    await submit(start.ack);
    const res = await handleShogaiResolve(env, STAFF, opts({ resolved_at: "2020/1/1 0:00" }));
    expect(res.ack.data.content).toContain("発生日時");
  });
});
