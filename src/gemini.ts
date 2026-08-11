/**
 * Gemini generateContent API 経由の要約。
 *
 * YouTube URL をそのまま渡し、動画の取得と解析は Google 側に任せる
 * （字幕スクレイピングはデータセンター IP からブロックされるため使わない）。
 *
 * Interactions API ではなく generateContent を使っているのは、区間指定
 * （videoMetadata の startOffset / endOffset）が前者に未実装のため。
 */

import { linkifyTimestamps } from "./youtube.ts";
import { formatSeconds, type ClipRange } from "./timecode.ts";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

const OUTPUT_INSTRUCTION =
  "冒頭に2〜3文の概要、続けて学びになる要点を箇条書き。全体で1400文字程度。";

const SYSTEM_INSTRUCTION = [
  "あなたはカードゲーム（主にシャドウバース）の動画を要約する日本語アシスタントです。",
  "視聴者がプレイの実力を伸ばすための要約を作ることが目的です。",
  "",
  "【優先して拾う内容】",
  "- マリガンの基準と、そう判断した理由",
  "- プレイの分岐と選択理由（なぜその択を取ったか／取らなかったか）",
  "- 打点計算、リーサル計算、相手の回復や守護を踏まえた詰め方",
  "- リソース管理（手札・進化権・除去札をいつ切り、いつ温存するか）",
  "- 対面ごとの立ち回り方針の違い、相手のデッキタイプの読み方",
  "- 環境でのデッキの立ち位置（何が流行っているか、その中でこのデッキがなぜ強い／弱いか）",
  "- デッキ同士の相性と、有利不利を決めている要因（キーカード、速度差、除去の噛み合い）",
  "- デッキ構築やカード採用の意図",
  "- 失敗例とその改善策",
  "- 視聴者からの質問と、それに対する回答（何を聞かれてどう答えたかが分かるように書く）",
  "",
  "【省く内容】",
  "- 雑談、挨拶、近況報告、視聴者との掛け合い（プレイやデッキに関する質問への回答は省かず拾う）",
  "- 告知、宣伝、配信環境の話",
  "- 勝敗の実況そのもの（何が起きたかより、なぜそう判断したかを書く）",
  "",
  "カード名・コスト・打点・勝率などの具体的な数値は省略せず残してください。",
  "そこが再現可能な知識になる部分です。抽象化した一般論に置き換えないでください。",
  "上記に当てはまる内容が乏しい動画の場合は、無理に当てはめず通常の要約をしてください。",
  "",
  "【カバー範囲】",
  "要約は与えられた範囲の最初から最後まで均等にカバーしてください。前半に項目が偏るのは失敗です。",
  "まず範囲全体の長さを把握し、おおむね10分ごとに最低1項目を割り当ててください。",
  "（例: 90分なら9項目以上、うち最後の項目は終わりの10分以内の場面から取る）",
  "終盤に学びが乏しい場合でも、その旨を1項目として簡潔に書いてください。黙って省略しないこと。",
  "",
  "【書式】",
  "Discord に貼るため、Markdown の見出し記法(#)は使わず、箇条書き(-)と太字(**)のみを使ってください。",
  "動画で実際に語られている内容だけを書き、推測や一般論で補完しないでください。",
  "前置き（「承知しました」等）や末尾の感想は不要です。要約本文のみを出力してください。",
  "各箇条書きの行頭には、その内容が話されている時点のタイムスタンプを必ず付けてください。",
  "書式は角括弧で [MM:SS] または [H:MM:SS]（例: [04:12] [1:23:45]）。範囲ではなく開始時点のみ。",
  "タイムスタンプは動画の先頭を 0:00 とした実際の経過時間にしてください。",
  "区間を指定された場合も、その区間の先頭からではなく動画全体の先頭を基準にしてください。",
  "冒頭の概要文にタイムスタンプは不要です。",
].join("\n");

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  /** 動画そのものに使われたトークン。消費した動画の長さを逆算するのに使う。 */
  videoTokens?: number;
}

export interface SummaryResult {
  text: string;
  usage?: Usage;
}

export class GeminiError extends Error {
  /** モデル側の混雑やレート制限など、時間をおけば成功しうるものか。 */
  readonly retryable: boolean;
  /** API が待機時間を指定してきた場合はそれに従う。 */
  readonly retryAfterMs?: number;

  constructor(message: string, retryable = false, retryAfterMs?: number) {
    super(message);
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * 一時エラー時の試行回数と、その間隔（回を追うごとに伸ばす）。
 * 待ち時間の合計は 20+40+60 = 120 秒。Cron の実行枠 15 分に対して十分収まる。
 */
const MAX_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 20_000;

export interface SummarizeOptions {
  apiKey: string;
  model: string;
  url: string;
  signal: AbortSignal;
  /** 未指定なら動画全体。 */
  clip?: ClipRange;
}

interface GenerateContentResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    promptTokensDetails?: { modality?: string; tokenCount?: number }[];
  };
  error?: { message?: string; details?: ErrorDetail[] };
}

interface ErrorDetail {
  "@type"?: string;
  violations?: { quotaMetric?: string; quotaId?: string }[];
  retryDelay?: string;
}

/**
 * 混雑エラー（`high demand`）は実際に発生するため、時間をおいて再試行する。
 * Cron 側の実行枠は 15 分あり、数十秒の待機は許容できる。
 */
export async function summarizeYouTube(options: SummarizeOptions): Promise<SummaryResult> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await requestSummary(options);
    } catch (error) {
      const retryable = error instanceof GeminiError && error.retryable;
      if (!retryable || attempt >= MAX_ATTEMPTS) throw error;

      const wait = error.retryAfterMs ?? RETRY_BASE_DELAY_MS * attempt;
      console.warn(`gemini busy, retrying in ${wait}ms (attempt ${attempt}/${MAX_ATTEMPTS})`);
      await delay(wait, options.signal);
    }
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function requestSummary(options: SummarizeOptions): Promise<SummaryResult> {
  const { apiKey, model, url, signal, clip } = options;

  const videoMetadata: Record<string, string> = {};
  if (clip) {
    videoMetadata.startOffset = `${clip.startSeconds}s`;
    if (clip.endSeconds !== undefined) videoMetadata.endOffset = `${clip.endSeconds}s`;
  }

  const scope = clip
    ? `動画のうち ${formatSeconds(clip.startSeconds)} 〜 ${clip.endSeconds !== undefined ? formatSeconds(clip.endSeconds) : "最後"} の範囲`
    : "この動画";

  const res = await fetch(`${ENDPOINT}/${model}:generateContent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
    },
    signal,
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      contents: [
        {
          parts: [
            {
              fileData: { fileUri: url },
              ...(clip ? { videoMetadata } : {}),
            },
            { text: `${scope}を日本語で要約してください。${OUTPUT_INSTRUCTION}` },
          ],
        },
      ],
    }),
  });

  // エラーが配列でラップされて返ることがある（[{ error: ... }]）。どちらの形状も受け付ける。
  const parsed: unknown = await res.json().catch(() => ({}));
  const body = (Array.isArray(parsed) ? (parsed[0] ?? {}) : parsed) as GenerateContentResponse;

  if (!res.ok) {
    const detail = body.error?.message ?? `HTTP ${res.status}`;
    const details = body.error?.details ?? [];
    const perDay = isPerDayQuota(details);
    throw new GeminiError(
      mapErrorMessage(res.status, detail, perDay),
      isRetryable(res.status, detail, perDay),
      retryAfterMs(details),
    );
  }

  const text = (body.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();

  if (!text) {
    throw new GeminiError(
      "要約を生成できませんでした。動画が公開設定になっているか、指定した区間が動画の長さを超えていないか確認してください。",
    );
  }

  return {
    // タイムスタンプをその時点から再生できるリンクにしておく。
    text: linkifyTimestamps(text, url),
    usage: {
      inputTokens: body.usageMetadata?.promptTokenCount,
      outputTokens: body.usageMetadata?.candidatesTokenCount,
      videoTokens: body.usageMetadata?.promptTokensDetails?.find(
        (detail) => detail.modality === "VIDEO",
      )?.tokenCount,
    },
  };
}

/**
 * 429 には「1日の上限」と「分あたりの上限」の 2 種類がある。
 * 前者は待っても直らないが、後者は数十秒で回復するため再試行する価値がある。
 * 長い動画は 1 回で 20 万トークンを超えるため、後者に当たりやすい。
 */
function isPerDayQuota(details: ErrorDetail[]): boolean {
  return details
    .flatMap((detail) => detail.violations ?? [])
    .some((violation) => /per.?day/i.test(`${violation.quotaId} ${violation.quotaMetric}`));
}

/** API が `retryDelay: "27s"` の形で待機時間を返してきた場合に拾う。 */
function retryAfterMs(details: ErrorDetail[]): number | undefined {
  const raw = details.find((detail) => detail.retryDelay)?.retryDelay;
  const seconds = raw ? Number(raw.replace(/s$/, "")) : Number.NaN;
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

function isRetryable(status: number, detail: string, perDay: boolean): boolean {
  if (status === 429) return !perDay;
  return status >= 500 || /high demand|overloaded|unavailable|try again/i.test(detail);
}

function mapErrorMessage(status: number, detail: string, perDay = false): string {
  // API キー不正は 400(API_KEY_INVALID) で返る。403 は動画側の問題なので混同しない。
  if (/api[ _-]?key/i.test(detail)) {
    return "Gemini API キーが拒否されました。`wrangler secret put GEMINI_API_KEY` の設定を確認してください。";
  }
  if (status === 403 || /permission/i.test(detail)) {
    return [
      "この動画にアクセスできませんでした。次のいずれかに該当する可能性があります。",
      "・年齢制限がある",
      "・埋め込み再生が無効になっている",
      "・地域制限がある",
      "・ライブ配信中、またはプレミア公開の予約状態",
    ].join("\n");
  }
  if (status === 429) {
    return perDay
      ? "Gemini 無料枠の1日の上限に達しました。太平洋時間の0時（日本時間16時）にリセットされます。"
      : [
          "Gemini のレート制限にかかりました（短時間に送れるトークン量の上限）。",
          "自動で数回再試行しましたが回復しませんでした。数分おいて実行してください。",
          "長い動画ほど1回の消費が大きいため、区間を短く区切ると通りやすくなります。",
        ].join("\n");
  }
  if (/token|context|too long|exceed/i.test(detail)) {
    return "動画が長すぎて一度に処理できません。開始時刻と終了時刻で1時間以内の区間を指定してください。";
  }
  if (status === 400 && /video|youtube|unsupported|fetch/i.test(detail)) {
    return "この動画を処理できませんでした。限定公開・非公開の動画は対象外です。";
  }
  if (isRetryable(status, detail, perDay)) {
    return "Gemini が混雑しており、再試行しても応答が得られませんでした。時間をおいて試してください。";
  }
  return `要約に失敗しました（${detail}）`;
}
