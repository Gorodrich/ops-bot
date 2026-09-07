import { describe, it, expect } from "vitest";
import { decideAuthorise, decideModauth } from "../src/accountLinks/domain.ts";

function record(overrides = {}) {
  return {
    minecraft_uuid: "uuid-1",
    minecraft_name: "Steve",
    discord_id: "d1",
    status: "active",
    linked_by: "self",
    linked_at: "2026-01-01T00:00:00Z",
    deactivated_at: null,
    ...overrides,
  };
}

function repoWith({ byUuid = null, activeByDiscord = null } = {}) {
  return {
    async getByUuid() {
      return byUuid;
    },
    async getActiveByDiscordId() {
      return activeByDiscord;
    },
  };
}

const eligible = { hasHito: true, hasKariSanka: false };
const ineligible = { hasHito: false, hasKariSanka: false };

describe("decideAuthorise", () => {
  it("条件④：人民・仮参加者ロールいずれも無ければ却下（Mojang APIは呼ばない前提の入力）", async () => {
    const repo = repoWith();
    const r = await decideAuthorise(repo, {
      discordId: "d1",
      mojangUuid: "uuid-1",
      mojangName: "Steve",
      eligibility: ineligible,
    });
    expect(r).toMatchObject({ kind: "reject", code: "④" });
  });

  it("条件①：Mojang APIで解決できないユーザー名は却下", async () => {
    const repo = repoWith();
    const r = await decideAuthorise(repo, {
      discordId: "d1",
      mojangUuid: null,
      mojangName: "nobody",
      eligibility: eligible,
    });
    expect(r).toMatchObject({ kind: "reject", code: "①" });
  });

  it("条件②：他者のactiveな紐づけと衝突すれば却下", async () => {
    const repo = repoWith({ byUuid: record({ discord_id: "other", status: "active" }) });
    const r = await decideAuthorise(repo, {
      discordId: "d1",
      mojangUuid: "uuid-1",
      mojangName: "Steve",
      eligibility: eligible,
    });
    expect(r).toMatchObject({ kind: "reject", code: "②" });
  });

  it("条件③：実行者が既に別アカウントを紐づけ済みなら却下", async () => {
    const repo = repoWith({ activeByDiscord: record({ minecraft_uuid: "uuid-other" }) });
    const r = await decideAuthorise(repo, {
      discordId: "d1",
      mojangUuid: "uuid-1",
      mojangName: "Steve",
      eligibility: eligible,
    });
    expect(r).toMatchObject({ kind: "reject", code: "③" });
  });

  it("再参加：本人のinactiveレコードと一致すれば②③より先に復元する", async () => {
    // このケースは既存レコードが同一discordのため②には該当しないが、
    // ③（getActiveByDiscordId）が万一true相当でも復元が優先されることを、
    // repoのgetActiveByDiscordIdが呼ばれない設計で保証する。
    let activeCalled = false;
    const repo = {
      async getByUuid() {
        return record({ discord_id: "d1", status: "inactive" });
      },
      async getActiveByDiscordId() {
        activeCalled = true;
        return null;
      },
    };
    const r = await decideAuthorise(repo, {
      discordId: "d1",
      mojangUuid: "uuid-1",
      mojangName: "Steve",
      eligibility: eligible,
    });
    expect(r.kind).toBe("reactivate");
    expect(activeCalled).toBe(false);
  });

  it("新規：衝突が無ければ作成", async () => {
    const repo = repoWith();
    const r = await decideAuthorise(repo, {
      discordId: "d1",
      mojangUuid: "uuid-1",
      mojangName: "Steve",
      eligibility: eligible,
    });
    expect(r).toMatchObject({ kind: "create", uuid: "uuid-1", name: "Steve" });
  });

  it("他者が過去に使用していたinactiveレコードは自己申告での再作成を認めず却下する（主キー衝突防止）", async () => {
    const repo = repoWith({ byUuid: record({ discord_id: "other", status: "inactive" }) });
    const r = await decideAuthorise(repo, {
      discordId: "d1",
      mojangUuid: "uuid-1",
      mojangName: "Steve",
      eligibility: eligible,
    });
    expect(r).toMatchObject({ kind: "reject", code: "②" });
  });
});

describe("decideModauth", () => {
  it("対象者が既に別アカウントを紐づけ済みなら、未確認では確認を要求する", async () => {
    const repo = repoWith({ activeByDiscord: record({ minecraft_uuid: "uuid-old" }) });
    const r = await decideModauth(repo, {
      targetDiscordId: "d1",
      mojangUuid: "uuid-1",
      mojangName: "Steve",
      targetEligibility: eligible,
      confirmedOverwrite: false,
    });
    expect(r.kind).toBe("confirm_overwrite");
  });

  it("確認済みなら上書き作成を許可する", async () => {
    const repo = repoWith({ activeByDiscord: record({ minecraft_uuid: "uuid-old" }) });
    const r = await decideModauth(repo, {
      targetDiscordId: "d1",
      mojangUuid: "uuid-1",
      mojangName: "Steve",
      targetEligibility: eligible,
      confirmedOverwrite: true,
    });
    expect(r.kind).toBe("create");
  });

  it("対象者が既に同一Minecraftアカウントに紐づけ済みなら何もしない（noop）", async () => {
    const repo = repoWith({ activeByDiscord: record({ minecraft_uuid: "uuid-1" }) });
    const r = await decideModauth(repo, {
      targetDiscordId: "d1",
      mojangUuid: "uuid-1",
      mojangName: "Steve",
      targetEligibility: eligible,
      confirmedOverwrite: false,
    });
    expect(r.kind).toBe("noop");
  });

  it("対象者に人民・仮参加者ロールが無ければ却下（④）", async () => {
    const repo = repoWith();
    const r = await decideModauth(repo, {
      targetDiscordId: "d1",
      mojangUuid: "uuid-1",
      mojangName: "Steve",
      targetEligibility: ineligible,
      confirmedOverwrite: false,
    });
    expect(r).toMatchObject({ kind: "reject", code: "④" });
  });

  it("他者が過去に使用していたinactiveレコードでも、対象者に他の紐づけが無ければ復元（再割当）する", async () => {
    // uuid-1 は discord_id: other の inactive レコードとして残っている想定（例：/modauth remove 後）。
    // これを他人（d1）へ再割当する際、insertLinkでの主キー衝突を避けるため reactivate になるべき。
    const repo = repoWith({ byUuid: record({ discord_id: "other", status: "inactive" }) });
    const r = await decideModauth(repo, {
      targetDiscordId: "d1",
      mojangUuid: "uuid-1",
      mojangName: "Steve",
      targetEligibility: eligible,
      confirmedOverwrite: false,
    });
    expect(r).toMatchObject({ kind: "reactivate", uuid: "uuid-1", name: "Steve" });
  });

  it("他者が過去に使用していたinactiveレコードへの再割当でも、対象者に別の紐づけがあれば先に上書き確認を要求する", async () => {
    const repo = {
      async getByUuid() {
        return record({ discord_id: "other", status: "inactive" });
      },
      async getActiveByDiscordId() {
        return record({ minecraft_uuid: "uuid-old", discord_id: "d1", status: "active" });
      },
    };
    const r = await decideModauth(repo, {
      targetDiscordId: "d1",
      mojangUuid: "uuid-1",
      mojangName: "Steve",
      targetEligibility: eligible,
      confirmedOverwrite: false,
    });
    expect(r.kind).toBe("confirm_overwrite");
  });
});
