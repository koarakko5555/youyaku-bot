import {
  EPHEMERAL,
  InteractionResponseType,
  InteractionType,
  ComponentType,
  TextInputStyle,
  chunkForEmbeds,
  editOriginalResponse,
  getModalValue,
  verifyRequest,
  type Interaction,
} from "./discord.ts";
import { GeminiError, summarizeYouTube } from "./gemini.ts";
import {
  claimJobs,
  enqueueJob,
  remainingTokenLifeMs,
  type SummaryJob,
} from "./jobs.ts";
import { DAILY_LIMIT_SECONDS, addUsage, readQuota } from "./quota.ts";
import { formatSeconds, parseTimecode, validateClip, type ClipRange } from "./timecode.ts";
import { fetchVideoInfo, normalizeYouTubeUrl } from "./youtube.ts";

export interface Env {
  DISCORD_PUBLIC_KEY: string;
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;
  JOBS: KVNamespace;
}

const DEFAULT_MODEL = "gemini-3.6-flash";

/**
 * 1 回の Cron で処理するジョブ数。
 * 実測で長尺動画の初回要約が約 139 秒かかるため、Cron の 15 分枠に対して 3 件が上限の目安。
 */
const MAX_JOBS_PER_TICK = 3;

/** 1 ジョブあたりの Gemini 打ち切り時間。トークン残時間とのうち短いほうを採用する。 */
const MAX_GEMINI_MS = 8 * 60 * 1000;

/**
 * 動画 1 秒あたりのトークン数（実測値）。
 * 区間を指定しなかった場合に、消費した動画の長さを逆算するのに使う。
 */
const TOKENS_PER_VIDEO_SECOND = 91;

/** embed の左側の帯の色。赤はエラー表示に見えるため Discord 標準のブラープルにしている。 */
const EMBED_COLOR = 0x5865f2;

/** 枠の状況は補足情報なので、要約本体より目立たない色にする。 */
const QUOTA_COLOR = 0x4f545c;

/** `/youyaku` を打つと開く入力フォーム。 */
const SUMMARY_MODAL = {
  custom_id: "summarize",
  title: "動画の要約",
  components: [
    {
      type: ComponentType.LABEL,
      label: "動画のURL",
      component: {
        type: ComponentType.TEXT_INPUT,
        custom_id: "url",
        style: TextInputStyle.SHORT,
        placeholder: "https://www.youtube.com/watch?v=...",
        required: true,
        max_length: 200,
      },
    },
    {
      type: ComponentType.LABEL,
      label: "開始時刻（任意）",
      description: "省略すると動画の先頭から。例: 0:00 / 1:23:45 / 90m",
      component: {
        type: ComponentType.TEXT_INPUT,
        custom_id: "from",
        style: TextInputStyle.SHORT,
        placeholder: "0:00",
        required: false,
        max_length: 20,
      },
    },
    {
      type: ComponentType.LABEL,
      label: "終了時刻（任意）",
      description: "省略すると動画の最後まで。区間は最大3時間",
      component: {
        type: ComponentType.TEXT_INPUT,
        custom_id: "to",
        style: TextInputStyle.SHORT,
        placeholder: "2:00:00",
        required: false,
        max_length: 20,
      },
    },
  ],
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("youyaku-bot is running", { status: 200 });
    }

    const rawBody = await request.text();
    if (!(await verifyRequest(request, rawBody, env.DISCORD_PUBLIC_KEY))) {
      return new Response("invalid request signature", { status: 401 });
    }

    const interaction = JSON.parse(rawBody) as Interaction;

    if (interaction.type === InteractionType.PING) {
      return json({ type: InteractionResponseType.PONG });
    }

    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
      if (interaction.data?.name === "quota") {
        return json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: await describeQuota(env.JOBS), flags: EPHEMERAL },
        });
      }
      // 要約コマンドは、この時点では何も受け取らず入力用のモーダルを開く。
      return json({ type: InteractionResponseType.MODAL, data: SUMMARY_MODAL });
    }

    if (interaction.type !== InteractionType.MODAL_SUBMIT) {
      return new Response("unsupported interaction type", { status: 400 });
    }

    const url = normalizeYouTubeUrl(getModalValue(interaction, "url") ?? "");
    if (!url) {
      return rejection(
        "YouTube の URL として認識できませんでした。`https://www.youtube.com/watch?v=...` の形式で指定してください。",
      );
    }

    const clip = buildClip(getModalValue(interaction, "from"), getModalValue(interaction, "to"));
    if (typeof clip === "string") return rejection(clip);

    const job: SummaryJob = {
      url,
      clip,
      applicationId: interaction.application_id,
      token: interaction.token,
      userId: interaction.member?.user?.id ?? interaction.user?.id,
      createdAt: Date.now(),
    };

    // 要約自体は Cron に任せ、ここでは KV に積むだけ。KV への書き込みは数十 ms で終わる。
    await enqueueJob(env.JOBS, job);

    // 「考え中…」のままだと進捗が分からないので、受付表示に差し替えておく。
    ctx.waitUntil(
      editOriginalResponse(job.applicationId, job.token, {
        content: `🔄 要約を受け付けました。完了までしばらくかかります。${describeClip(clip)}\n${url}`,
        allowed_mentions: { parse: [] },
      }),
    );

    return json({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const jobs = await claimJobs(env.JOBS, MAX_JOBS_PER_TICK);
    if (jobs.length === 0) return;

    console.log(`claimed ${jobs.length} job(s)`);
    // Gemini のレート制限と subrequest 上限を踏まえ、直列で処理する。
    for (const job of jobs) {
      await runSummary(job, env);
    }
  },
} satisfies ExportedHandler<Env>;

async function runSummary(job: SummaryJob, env: Env): Promise<void> {
  const remaining = remainingTokenLifeMs(job);
  if (remaining <= 0) {
    // トークンが失効しており、結果を返す手段がない。Gemini を無駄に叩かず捨てる。
    console.error(`dropping expired job url=${job.url} age=${Date.now() - job.createdAt}ms`);
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(remaining, MAX_GEMINI_MS));
  const startedAt = Date.now();

  try {
    const { text: summary, usage } = await summarizeYouTube({
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL ?? DEFAULT_MODEL,
      url: job.url,
      clip: job.clip,
      signal: controller.signal,
    });

    console.log(
      `summary ok elapsed=${Date.now() - startedAt}ms queued=${startedAt - job.createdAt}ms input_tokens=${usage?.inputTokens ?? "?"} url=${job.url}`,
    );

    await addUsage(env.JOBS, consumedSeconds(job, usage));
    const quota = await describeQuota(env.JOBS);
    const info = await fetchVideoInfo(job.url, controller.signal);
    console.log(`video info title=${info?.title ? "取得成功" : "取得失敗"} url=${job.url}`);

    const { chunks, truncated } = chunkForEmbeds(summary);
    const header = job.userId ? `<@${job.userId}> の要約リクエスト` : "要約";
    await editOriginalResponse(job.applicationId, job.token, {
      content: `${header}${describeClip(job.clip)}`,
      embeds: [
        // 元動画のカード。サムネイルとタイトルから、何の要約か一目で分かるようにする。
        {
          title: info?.title ?? job.url,
          url: job.url,
          author: info?.author ? { name: info.author, url: info.authorUrl } : undefined,
          image: info ? { url: info.thumbnailUrl } : undefined,
          color: EMBED_COLOR,
        },
        ...chunks.map((chunk, i) => ({
          title: i === 0 ? "📺 動画の要約" : undefined,
          description: chunk,
          color: EMBED_COLOR,
          footer:
            i === chunks.length - 1
              ? { text: truncated ? "文字数上限のため一部省略されました" : "Generated by Gemini" }
              : undefined,
        })),
        { description: quota, color: QUOTA_COLOR },
      ],
      // 要約本文中の URL やメンションで余計な通知が飛ばないようにする。
      allowed_mentions: { parse: [] },
    });
  } catch (error) {
    const message =
      error instanceof GeminiError
        ? error.message
        : error instanceof Error && error.name === "AbortError"
          ? "要約が時間内に終わりませんでした。動画が長すぎる可能性があります。"
          : "予期しないエラーが発生しました。";

    console.error(`summary failed elapsed=${Date.now() - startedAt}ms url=${job.url}`, error);
    await editOriginalResponse(job.applicationId, job.token, { content: `⚠️ ${message}` });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 今回の要約で消費した動画の長さ。
 * 区間の両端が指定されていれば厳密に分かる。それ以外はトークン数から逆算する。
 */
function consumedSeconds(job: SummaryJob, usage?: { videoTokens?: number }): number {
  if (job.clip?.endSeconds !== undefined) {
    return job.clip.endSeconds - job.clip.startSeconds;
  }
  const videoTokens = usage?.videoTokens;
  return videoTokens ? Math.round(videoTokens / TOKENS_PER_VIDEO_SECOND) : 0;
}

async function describeQuota(kv: KVNamespace): Promise<string> {
  const { usedSeconds, remainingSeconds, resetAt } = await readQuota(kv);
  const reset = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(resetAt);
  const width = 20;
  const filled = Math.min(width, Math.round((usedSeconds / DAILY_LIMIT_SECONDS) * width));
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  const percent = Math.round((usedSeconds / DAILY_LIMIT_SECONDS) * 100);

  return [
    "**Gemini 無料枠の状況**",
    "```",
    `${bar} ${percent}%`,
    "```",
    `使用済み: ${formatSeconds(usedSeconds)} / ${formatSeconds(DAILY_LIMIT_SECONDS)}`,
    `残り: 約 ${Math.floor(remainingSeconds / 60)} 分ぶんの動画を要約できます`,
    `リセット: ${reset}`,
    "",
    "-# この数値は Bot 側の集計です。Google の実カウントとは差が出ることがあります。",
  ].join("\n");
}

/** 本人にだけ見える即時エラー応答。ジョブは積まない。 */
function rejection(message: string): Response {
  return json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: message, flags: EPHEMERAL },
  });
}

/**
 * from / to から区間を組み立てる。
 * 未指定なら undefined（動画全体）、不正ならエラー文言を返す。
 */
function buildClip(from?: string, to?: string): ClipRange | undefined | string {
  if (from === undefined && to === undefined) return undefined;

  const startSeconds = from === undefined ? 0 : parseTimecode(from);
  if (startSeconds === null) {
    return `開始時刻「${from}」を解釈できませんでした。\`1:23:45\` \`12:34\` \`90m\` のような形式で指定してください。`;
  }

  let endSeconds: number | undefined;
  if (to !== undefined) {
    const parsed = parseTimecode(to);
    if (parsed === null) {
      return `終了時刻「${to}」を解釈できませんでした。\`1:23:45\` \`12:34\` \`90m\` のような形式で指定してください。`;
    }
    endSeconds = parsed;
  }

  const range: ClipRange = { startSeconds, endSeconds };
  const problem = validateClip(range);
  return problem ?? range;
}

function describeClip(clip?: ClipRange): string {
  if (!clip) return "";
  const end = clip.endSeconds !== undefined ? formatSeconds(clip.endSeconds) : "最後";
  return `\n範囲: ${formatSeconds(clip.startSeconds)} 〜 ${end}`;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}
