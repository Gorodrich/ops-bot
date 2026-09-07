// グローバル登録されたスラッシュコマンドを全削除する（ギルド限定登録との重複解消用）。
// 使い方: DISCORD_APP_ID / DISCORD_BOT_TOKEN を環境変数に設定して実行。
//   node scripts/unregister-global-commands.mjs
//
// グローバルコマンド一覧を空配列でPUTすることで全削除する（Discord API仕様）。

async function main() {
  const appId = requireEnv("DISCORD_APP_ID");
  const token = requireEnv("DISCORD_BOT_TOKEN");

  const url = `https://discord.com/api/v10/applications/${appId}/commands`;

  const res = await fetch(url, {
    method: "PUT",
    headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
    body: JSON.stringify([]),
  });
  if (!res.ok) {
    console.error(`削除失敗: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  console.log("グローバルコマンドを全削除しました。反映まで最大1時間かかる場合があります。");
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`環境変数 ${name} が未設定です`);
    process.exit(1);
  }
  return v;
}

main();
