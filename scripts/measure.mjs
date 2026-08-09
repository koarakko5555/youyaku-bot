#!/usr/bin/env node
/**
 * Gemini の要約レイテンシを実測する。Discord は経由しない（GEMINI_API_KEY だけあれば動く）。
 *
 *   npm run measure -- <YouTube URL> [<YouTube URL> ...]
 *   npm run measure -- --style short <YouTube URL>
 *
 * Worker と同じ src/gemini.ts を読み込むため、ここでの計測結果は本番の挙動と一致する。
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { summarizeYouTube, GeminiError } = await import(`${ROOT}/src/gemini.ts`);
const { normalizeYouTubeUrl } = await import(`${ROOT}/src/youtube.ts`);
const { parseTimecode, validateClip, formatSeconds } = await import(`${ROOT}/src/timecode.ts`);

/** 無料プランで waitUntil が打ち切られるまでの時間。判定の基準線。 */
const WAITUNTIL_LIMIT_MS = 30_000;
/** src/index.ts の GEMINI_TIMEOUT_MS と揃えること。 */
const BUDGET_MS = 24_000;
/**
 * 入力トークンから動画の尺を逆算するための係数。
 * ドキュメント上は通常解像度 300 / 低解像度 100 tok/秒 とされているが、
 * このエンドポイントで実測すると約 91 tok/秒（19秒・213秒の動画で一致）だったため
 * 実測値を採用している。
 */
const TOKENS_PER_VIDEO_SECOND = 91;

loadDevVars();

const args = process.argv.slice(2);
const urls = [];
let printSummary = false;
let from;
let to;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--print") printSummary = true;
  else if (args[i] === "--from") from = args[++i];
  else if (args[i] === "--to") to = args[++i];
  else urls.push(args[i]);
}

let clip;
if (from !== undefined || to !== undefined) {
  const startSeconds = from === undefined ? 0 : parseTimecode(from);
  const endSeconds = to === undefined ? undefined : parseTimecode(to);
  if (startSeconds === null || endSeconds === null) {
    console.error("時刻を解釈できませんでした。1:23:45 / 12:34 / 90m のような形式で指定してください。");
    process.exit(1);
  }
  clip = { startSeconds, endSeconds };
  const problem = validateClip(clip);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
}

if (urls.length === 0) {
  console.error(`使い方: npm run measure -- <YouTube URL> [...]

長さの異なる動画を数本渡すと傾向が見えます（例: 3分 / 15分 / 45分）。
オプション:
  --print                          要約本文も出力する
  --from <時刻> --to <時刻>        区間を指定（例: --from 0:00 --to 2:00:00、最大3時間）`);
  process.exit(1);
}

const apiKey = process.env.GEMINI_API_KEY?.trim();
if (!apiKey) {
  console.error("GEMINI_API_KEY が未設定です。.dev.vars に設定してください（.dev.vars.example 参照）。");
  process.exit(1);
}
const model = process.env.GEMINI_MODEL?.trim() || "gemini-3.6-flash";

console.log(`model: ${model}`);
if (clip) {
  const end = clip.endSeconds !== undefined ? formatSeconds(clip.endSeconds) : "最後";
  console.log(`区間: ${formatSeconds(clip.startSeconds)} 〜 ${end}`);
}
console.log("");

const rows = [];
for (const rawUrl of urls) {
  const url = normalizeYouTubeUrl(rawUrl);
  if (!url) {
    console.error(`⚠️  YouTube URL として認識できません: ${rawUrl}`);
    continue;
  }

  {
    process.stdout.write(`計測中: ${url} ... `);
    // 実際に何秒かかるか知りたいので、本番の 24 秒ではなく余裕を持たせて打ち切る。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 600_000);
    const startedAt = Date.now();

    try {
      const { text, usage } = await summarizeYouTube({
        apiKey,
        model,
        url,
        clip,
        signal: controller.signal,
      });
      const elapsed = Date.now() - startedAt;
      const inputTokens = usage?.inputTokens;
      const videoSec = inputTokens ? Math.round(inputTokens / TOKENS_PER_VIDEO_SECOND) : undefined;

      console.log(`${(elapsed / 1000).toFixed(1)}s`);
      if (printSummary) {
        console.log(`${"-".repeat(78)}\n${text}\n${"-".repeat(78)}\n`);
      }
      rows.push({
        url,
        elapsed,
        inputTokens,
        videoSec,
        chars: text.length,
        ok: true,
      });
    } catch (error) {
      const elapsed = Date.now() - startedAt;
      console.log("失敗");
      console.error(`   ${error instanceof GeminiError ? error.message : error}`);
      rows.push({ url, elapsed, ok: false });
    } finally {
      clearTimeout(timer);
    }
  }
}

if (rows.length === 0) process.exit(1);

console.log(`\n${"=".repeat(78)}`);
console.log(
  ["所要".padStart(8), "入力tok".padStart(10), "推定尺".padStart(9), "出力字".padStart(7), "判定"].join("  "),
);
console.log("-".repeat(78));

for (const row of rows) {
  if (!row.ok) {
    console.log([`${(row.elapsed / 1000).toFixed(1)}s`.padStart(8), "-".padStart(10), "-".padStart(9), "-".padStart(7), "❌ 失敗"].join("  "));
    continue;
  }
  const verdict =
    row.elapsed < BUDGET_MS * 0.6
      ? "✅ 余裕"
      : row.elapsed < BUDGET_MS
        ? "⚠️ ギリギリ"
        : row.elapsed < WAITUNTIL_LIMIT_MS
          ? "❌ 予算超過"
          : "❌ 30秒の壁を超過";

  console.log(
    [
      `${(row.elapsed / 1000).toFixed(1)}s`.padStart(8),
      (row.inputTokens?.toLocaleString() ?? "?").padStart(10),
      (row.videoSec !== undefined ? formatDuration(row.videoSec) : "?").padStart(9),
      String(row.chars).padStart(7),
      verdict,
    ].join("  "),
  );
}

console.log("=".repeat(78));

const succeeded = rows.filter((r) => r.ok);
const overBudget = succeeded.filter((r) => r.elapsed >= BUDGET_MS);
console.log(`\n判定基準: 予算 ${BUDGET_MS / 1000}s（src/index.ts の GEMINI_TIMEOUT_MS） / 壁 ${WAITUNTIL_LIMIT_MS / 1000}s`);
if (succeeded.length === 0) {
  console.log("成功したケースがありません。API キーと動画の公開設定を確認してください。");
} else if (overBudget.length === 0) {
  console.log("→ 全ケースが予算内。現在の waitUntil 方式のままで運用できます。");
} else {
  console.log(
    `→ ${overBudget.length}/${succeeded.length} ケースが予算超過。KV + Cron 方式への切り替えを検討してください。`,
  );
}

function formatDuration(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return m > 0 ? `${m}分${String(s).padStart(2, "0")}秒` : `${s}秒`;
}

function loadDevVars() {
  try {
    const content = readFileSync(resolve(ROOT, ".dev.vars"), "utf8");
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
