// D1 を必要とするモジュールの回帰テスト用ヘルパー。
// node:sqlite のインメモリDBに migrations/*.sql をすべて適用し、
// D1Database のうち本リポジトリが使う API（prepare/bind/first/all/run/batch）だけを模した env を返す。
// node 22.13 未満では --experimental-sqlite が必要（vitest.config.mjs で付与している）。

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    // D1 は undefined を受け付けないため、テストでも同じ制約で落とす
    if (params.some((p) => p === undefined)) throw new Error(`D1_TYPE_ERROR: undefined をbindしようとしました: ${this.sql}`);
    return new Statement(this.db, this.sql, params.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p)));
  }

  async first(column) {
    const row = this.db.prepare(this.sql).get(...this.params);
    if (!row) return null;
    const plain = { ...row };
    return column ? plain[column] ?? null : plain;
  }

  async all() {
    const rows = this.db.prepare(this.sql).all(...this.params).map((r) => ({ ...r }));
    return { results: rows, success: true, meta: { changes: 0 } };
  }

  async run() {
    const info = this.db.prepare(this.sql).run(...this.params);
    return { success: true, results: [], meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }
}

export function createTestDb() {
  const db = new DatabaseSync(":memory:");
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  return {
    raw: db,
    prepare: (sql) => new Statement(db, sql),
    async batch(stmts) {
      db.exec("BEGIN");
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

/** テスト用の Env。シークレット類はダミー値。 */
export function createTestEnv() {
  return {
    DB: createTestDb(),
    OPSBOT_ENV: "test",
    SHADOW_MODE: "true",
    DISCORD_PUBLIC_KEY: "00",
    DISCORD_BOT_TOKEN: "test-token",
    DISCORD_APP_ID: "test-app",
    CT_SHARED_SECRET: "test-secret",
  };
}

/** settings テーブルの1キーを上書きする（JSON値）。 */
export function setSetting(env, key, value) {
  env.DB.raw
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, JSON.stringify(value));
}

/** settings テーブルの1キーを部分更新する（オブジェクト値のマージ）。 */
export function patchSetting(env, key, patch) {
  const row = env.DB.raw.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  const current = row ? JSON.parse(row.value) : {};
  setSetting(env, key, { ...current, ...patch });
}

/**
 * globalThis.fetch を差し替えて Discord REST 呼び出しを記録する。
 * handler(url, init) が Response を返せばそれを使い、undefined なら既定の応答（200・{id}）を返す。
 * 戻り値の restore() で元に戻す。
 */
export function mockFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  let seq = 1000;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, method: init.method ?? "GET", body: init.body });
    const custom = handler ? await handler(url, init) : undefined;
    if (custom) return custom;
    return new Response(JSON.stringify({ id: String(seq++) }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}
