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
