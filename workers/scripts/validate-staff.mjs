#!/usr/bin/env node
// staff.yaml を検証し、任意で D1 seed 用の SQL を出力する。
//
//   node scripts/validate-staff.mjs [--emit-sql] <path-to-staff.yaml>
//
// 終了コード：0=合格、1=検証エラー、2=引数/ファイルエラー

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { validateStaffDoc, toInsertSql } from "./staff-schema.mjs";

const args = process.argv.slice(2);
const emitSql = args.includes("--emit-sql");
const path = args.find((a) => !a.startsWith("--"));

if (!path) {
  console.error("使い方: node scripts/validate-staff.mjs [--emit-sql] <path-to-staff.yaml>");
  process.exit(2);
}

let doc;
try {
  doc = parse(readFileSync(path, "utf8"));
} catch (e) {
  console.error(`ファイルを読み込めません: ${path}\n${e.message}`);
  process.exit(2);
}

const errors = validateStaffDoc(doc);
if (errors.length > 0) {
  console.error(`[NG] ${path}: ${errors.length} 件のエラー`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.error(`[OK] ${path}: ${doc.staff.length} 名、検証に合格しました`);
if (emitSql) {
  process.stdout.write(toInsertSql(doc) + "\n");
}
