// node:sqlite（test/helpers/d1.mjs の D1 シム）は node 22.13 未満では実験フラグが必要。
// CI（node 22 最新）では不要なので、ローカルの古い node のときだけ付与する。
import { defineConfig } from "vitest/config";

const [major, minor] = process.versions.node.split(".").map(Number);
const needsSqliteFlag = major < 22 || (major === 22 && minor < 13);

export default defineConfig({
  test: {
    execArgv: needsSqliteFlag ? ["--experimental-sqlite", "--no-warnings"] : [],
  },
});
