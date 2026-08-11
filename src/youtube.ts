/** YouTube URL の抽出と正規化。 */

const PATTERNS: RegExp[] = [
  /youtube\.com\/watch\?(?:[^\s]*&)?v=([\w-]{11})/i,
  /youtube\.com\/(?:shorts|live|embed|v)\/([\w-]{11})/i,
  /youtu\.be\/([\w-]{11})/i,
];

/**
 * 入力からビデオ ID を取り出し、正規化した watch URL を返す。
 * Discord の `<url>` 装飾や前後の文章が混ざっていても拾える。
 * 対象外なら null。
 */
export function normalizeYouTubeUrl(input: string): string | null {
  const id = extractVideoId(input);
  return id ? `https://www.youtube.com/watch?v=${id}` : null;
}

export function extractVideoId(input: string): string | null {
  const text = input.trim().replace(/^<|>$/g, "");
  for (const pattern of PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
}

export interface VideoInfo {
  /** サムネイルは ID から組み立てられるので、取得に失敗しても必ず入る。 */
  thumbnailUrl: string;
  title?: string;
  author?: string;
  authorUrl?: string;
}

/**
 * 動画のタイトルとサムネイルを得る。
 *
 * タイトルは oEmbed（APIキー不要）から取るが、YouTube はデータセンター IP からの
 * アクセスを弾くことがあるため、失敗してもサムネイルだけ返して処理を続ける。
 */
export async function fetchVideoInfo(url: string, signal?: AbortSignal): Promise<VideoInfo | null> {
  const id = extractVideoId(url);
  if (!id) return null;

  // hqdefault はどの動画にも必ず存在する。maxresdefault は無い動画がある。
  const info: VideoInfo = { thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` };

  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`,
      { signal },
    );
    if (!res.ok) return info;

    const data = (await res.json()) as {
      title?: string;
      author_name?: string;
      author_url?: string;
      thumbnail_url?: string;
    };
    return {
      thumbnailUrl: data.thumbnail_url ?? info.thumbnailUrl,
      title: data.title,
      author: data.author_name,
      authorUrl: data.author_url,
    };
  } catch {
    return info;
  }
}

const DATA_API = "https://www.googleapis.com/youtube/v3/videos";

/** ISO 8601 の期間表記。`PT1H23M45S` `PT45S` `P1DT2H`（24時間超）`P0D`（配信中）。 */
const ISO_DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

export function parseIsoDuration(input: string): number | null {
  const match = input.match(ISO_DURATION);
  if (!match) return null;
  const [, d, h, m, s] = match;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0);
}

export interface VideoDuration {
  /** 配信中、またはプレミア公開の予約状態。尺が確定しない。 */
  live: boolean;
  /** 動画全体の長さ（秒）。live のときは 0。 */
  seconds: number;
}

interface VideosListResponse {
  items?: {
    contentDetails?: { duration?: string };
    snippet?: { liveBroadcastContent?: string };
  }[];
}

/**
 * 動画の長さと配信状態を YouTube Data API v3 から得る。
 *
 * oEmbed は duration を返さないためこちらを使う。1 回 1 クォータユニット、
 * 無料枠は 1 日 10,000 ユニットなので、この用途では枠を気にしなくてよい。
 * `googleapis.com` 宛てなので、YouTube 本体と違いデータセンター IP でも弾かれない。
 *
 * 取得できなければ null。判断材料が無いだけなので、呼び出し側は要約を続行する。
 */
export async function fetchVideoDuration(
  url: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<VideoDuration | null> {
  const id = extractVideoId(url);
  if (!id) return null;

  try {
    const res = await fetch(
      `${DATA_API}?part=contentDetails,snippet&id=${id}&key=${encodeURIComponent(apiKey)}`,
      { signal },
    );
    if (!res.ok) {
      // キーに YouTube Data API が有効化されていない場合はここに来る（403）。
      console.warn(`youtube data api failed status=${res.status}`);
      return null;
    }

    const item = ((await res.json()) as VideosListResponse).items?.[0];
    // 非公開・削除済みの動画は items が空で返る。
    if (!item) return null;

    // 配信中は "live"、プレミア公開の予約は "upcoming"、通常の動画は "none"。
    const broadcast = item.snippet?.liveBroadcastContent;
    if (broadcast && broadcast !== "none") return { live: true, seconds: 0 };

    const raw = item.contentDetails?.duration;
    const seconds = raw ? parseIsoDuration(raw) : null;
    if (seconds === null) return null;

    // 配信中は duration が `P0D` で返る。上の判定を抜けた場合の保険。
    return seconds === 0 ? { live: true, seconds: 0 } : { live: false, seconds };
  } catch {
    return null;
  }
}

/** `[12:34]` `[1:02:03]` のような表記。行頭以外に現れることもある。 */
const TIMESTAMP = /\[(\d{1,2}):([0-5]\d)(?::([0-5]\d))?\]/g;

/**
 * 要約中のタイムスタンプを、その時点から再生できるリンクに変換する。
 * Discord の embed は `[表示文字](URL)` 形式のマスクリンクを描画できる。
 */
export function linkifyTimestamps(text: string, videoUrl: string): string {
  const id = extractVideoId(videoUrl);
  if (!id) return text;

  return text.replace(TIMESTAMP, (whole, a: string, b: string, c?: string) => {
    // 3 つ揃っていれば H:MM:SS、2 つなら MM:SS。
    const [h, m, s] = c !== undefined ? [Number(a), Number(b), Number(c)] : [0, Number(a), Number(b)];
    const seconds = h * 3600 + m * 60 + s;
    const label = whole.slice(1, -1);
    return `[${label}](https://youtu.be/${id}?t=${seconds})`;
  });
}
