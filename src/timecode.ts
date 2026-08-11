/** 動画の時刻指定（`1:23:45` `90m` `3600s` など）の解釈。 */

/** 1 リクエストで扱える上限。Gemini の制約は 3 時間だが、待ち時間と消費を抑えて 1 時間で運用する。 */
export const MAX_CLIP_SECONDS = 60 * 60;

/**
 * 実際に拒否する閾値。
 * 「ちょうど1時間」を謳う動画が実測では数十秒はみ出すことがあるため、1 分の遊びを持たせる。
 * 1時間1分ちょうどから拒否する。
 */
export const REJECT_SECONDS = MAX_CLIP_SECONDS + 60;

/** 要約の対象になる長さが上限を超えているか。 */
export function exceedsLimit(seconds: number): boolean {
  return seconds >= REJECT_SECONDS;
}

const COLON = /^(?:(\d+):)?(\d{1,2}):([0-5]?\d)$/;
const UNITS = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;

/**
 * 時刻文字列を秒に変換する。解釈できなければ null。
 *
 * 受け付ける形式:
 *   `1:23:45` `12:34` （コロン区切り）
 *   `1h30m` `90m` `5400s` （単位付き）
 *   `5400` （数値のみ＝秒）
 */
export function parseTimecode(input: string): number | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;

  if (/^\d+$/.test(text)) return Number(text);

  const colon = text.match(COLON);
  if (colon) {
    const [, h, m, s] = colon;
    return Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s);
  }

  const units = text.match(UNITS);
  // UNITS は全要素が省略可能なため、空文字にもマッチしてしまう。何か拾えた場合のみ有効とする。
  if (units && units.slice(1).some((part) => part !== undefined)) {
    const [, h, m, s] = units;
    return Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0);
  }

  return null;
}

export function formatSeconds(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export interface ClipRange {
  startSeconds: number;
  /** 未指定なら動画の最後まで。 */
  endSeconds?: number;
}

/** 指定された範囲を検証する。問題があればエラー文言を返す。 */
export function validateClip(range: ClipRange): string | null {
  const { startSeconds, endSeconds } = range;

  if (endSeconds !== undefined) {
    if (endSeconds <= startSeconds) {
      return "終了時刻は開始時刻より後にしてください。";
    }
    if (exceedsLimit(endSeconds - startSeconds)) {
      return `一度に要約できるのは1時間までです（指定は ${formatSeconds(endSeconds - startSeconds)}）。区間を1時間以内にしてください。`;
    }
  }
  return null;
}
