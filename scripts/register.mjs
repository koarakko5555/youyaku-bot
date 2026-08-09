#!/usr/bin/env node
/**
 * スラッシュコマンドを Discord に登録する。
 * コマンド定義を変えたときだけ実行すればよい（デプロイのたびには不要）。
 *
 *   npm run register
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

loadDevVars();

const APPLICATION_ID = requireEnv("DISCORD_APPLICATION_ID");
const BOT_TOKEN = requireEnv("DISCORD_BOT_TOKEN");
const GUILD_ID = process.env.DISCORD_GUILD_ID?.trim();

const commands = [
  {
    name: "youyaku",
    name_localizations: { ja: "要約" },
    description: "Summarize a YouTube video with AI",
    description_localizations: { ja: "YouTube動画をAIで要約します（入力フォームが開きます）" },
  },
  {
    name: "quota",
    name_localizations: { ja: "残り枠" },
    description: "Show remaining Gemini free-tier quota",
    description_localizations: { ja: "Gemini無料枠の残りとリセット時刻を表示します" },
  },
];

const url = GUILD_ID
  ? `https://discord.com/api/v10/applications/${APPLICATION_ID}/guilds/${GUILD_ID}/commands`
  : `https://discord.com/api/v10/applications/${APPLICATION_ID}/commands`;

const res = await fetch(url, {
  method: "PUT",
  headers: {
    "content-type": "application/json",
    authorization: `Bot ${BOT_TOKEN}`,
  },
  body: JSON.stringify(commands),
});

if (!res.ok) {
  console.error(`登録に失敗しました: HTTP ${res.status}`);
  console.error(await res.text());
  process.exit(1);
}

const registered = await res.json();
console.log(
  `✅ ${registered.length} 件のコマンドを登録しました（${GUILD_ID ? `ギルド ${GUILD_ID}・即時反映` : "グローバル・反映に最大1時間"}）`,
);
for (const command of registered) console.log(`   /${command.name}`);

function loadDevVars() {
  try {
    const content = readFileSync(resolve(process.cwd(), ".dev.vars"), "utf8");
    for (const line of content.split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!match) continue;
      const [, key, value] = match;
      if (!process.env[key]) process.env[key] = value.trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // .dev.vars が無ければ環境変数だけを使う
  }
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`環境変数 ${name} が未設定です。.dev.vars を作成してください（.dev.vars.example 参照）。`);
    process.exit(1);
  }
  return value;
}
