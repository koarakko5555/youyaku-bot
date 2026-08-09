/**
 * 無料枠の消費を自前で記録する。
 *
 * Google は残量を照会する API を公開していないため、要約が成功するたびに
 * 「何秒ぶんの動画を投げたか」を KV に足していく。あくまで自前の集計であり、
 * Google 側の実カウントとは一致しない可能性がある。
 */

/** 無料枠: YouTube 動画は 1 日 8 時間まで。 */
export const DAILY_LIMIT_SECONDS = 8 * 60 * 60;

/** 日次クォータは太平洋時間の 0 時にリセットされる。 */
const QUOTA_TIMEZONE = "America/Los_Angeles";

const KEY_PREFIX = "usage:";

const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: QUOTA_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const timeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: QUOTA_TIMEZONE,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** 太平洋時間での「今日」。これがクォータの単位になる。 */
function quotaDay(now: Date): string {
  return dateFormatter.format(now);
}

/**
 * 次にリセットされる時刻。
 * 太平洋時間での経過秒数を求め、その日の残りを足す。
 */
export function nextResetAt(now: Date): Date {
  const [h, m, s] = timeFormatter.format(now).split(":").map(Number);
  const elapsed = h * 3600 + m * 60 + s;
  return new Date(now.getTime() + (86400 - elapsed) * 1000);
}

export interface QuotaStatus {
  usedSeconds: number;
  remainingSeconds: number;
  resetAt: Date;
}

export async function readQuota(kv: KVNamespace, now = new Date()): Promise<QuotaStatus> {
  const raw = await kv.get(`${KEY_PREFIX}${quotaDay(now)}`);
  const usedSeconds = Math.max(0, Number(raw ?? 0) || 0);
  return {
    usedSeconds,
    remainingSeconds: Math.max(0, DAILY_LIMIT_SECONDS - usedSeconds),
    resetAt: nextResetAt(now),
  };
}

/** 消費を加算する。件数が少ないため読み書きの競合は許容している。 */
export async function addUsage(kv: KVNamespace, seconds: number, now = new Date()): Promise<void> {
  if (seconds <= 0) return;
  const key = `${KEY_PREFIX}${quotaDay(now)}`;
  const current = Number((await kv.get(key)) ?? 0) || 0;
  await kv.put(key, String(Math.round(current + seconds)), {
    // リセット後は不要になるが、集計を追えるよう 3 日残す。
    expirationTtl: 3 * 24 * 60 * 60,
  });
}
