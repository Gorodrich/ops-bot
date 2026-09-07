// Workers バインディング／シークレットの型。
// シークレットは `wrangler secret put <NAME>` で登録する（ソースにもwrangler.jsoncにも書かない・ルールc）。
export interface Env {
  DB: D1Database;

  // vars（wrangler.jsonc）
  OPSBOT_ENV: string;
  SHADOW_MODE: string;

  // secrets（wrangler secret put）
  DISCORD_PUBLIC_KEY: string;   // Interactions 署名検証用（Ed25519 公開鍵, hex）
  DISCORD_BOT_TOKEN: string;    // Discord REST API 呼び出し用
  DISCORD_APP_ID: string;
  CT_SHARED_SECRET: string;     // CT102 ⇄ Workers ポーリングの共有シークレット（§3.4.2）
}
