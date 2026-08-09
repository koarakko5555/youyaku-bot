/**
 * 要約ジョブの受け渡し。
 *
 * Interaction ハンドラは「30 秒の壁」（waitUntil の上限）の中で終わらせる必要があるが、
 * 実測では長尺動画の初回要約に約 139 秒かかる。そのため要約本体は Cron Trigger
 * （実行上限 15 分）へ逃がし、その間の受け渡しに KV を使う。
 */
import type { ClipRange } from "./timecode.ts";

export interface SummaryJob {
  url: string;
  /** 未指定なら動画全体。 */
  clip?: ClipRange;
  applicationId: string;
  /** Discord の follow-up 用トークン。発行から 15 分で失効する。 */
  token: string;
  userId?: string;
  createdAt: number;
}

const PREFIX = "job:";

/** Discord の interaction token の有効期間。 */
export const TOKEN_TTL_MS = 15 * 60 * 1000;
/** 失効間際のジョブは処理しても結果を返せないため、この余裕を切ったら捨てる。 */
const EXPIRY_MARGIN_MS = 60 * 1000;

export async function enqueueJob(kv: KVNamespace, job: SummaryJob): Promise<void> {
  // キーに作成時刻を入れて古い順に並ぶようにする（KV の list はキー名昇順）。
  const key = `${PREFIX}${String(job.createdAt).padStart(15, "0")}:${crypto.randomUUID()}`;
  await kv.put(key, JSON.stringify(job), {
    // 何らかの理由で拾われなかったジョブが残り続けないようにする。
    expirationTtl: 60 * 60,
  });
}

/**
 * 古い順に最大 limit 件のジョブを取り出す。
 *
 * 取り出したジョブは即座に削除して所有権を確保する。要約は 1 分以上かかるため
 * Cron の実行が重なるが、先に消しておけば二重に Gemini を叩くことを避けられる。
 * KV は結果整合なので完全な排他ではない点に注意（個人利用の規模では実害が出にくい）。
 */
export async function claimJobs(kv: KVNamespace, limit: number): Promise<SummaryJob[]> {
  const listed = await kv.list({ prefix: PREFIX, limit });
  const jobs: SummaryJob[] = [];

  for (const key of listed.keys) {
    const raw = await kv.get(key.name);
    await kv.delete(key.name);
    if (!raw) continue;
    try {
      jobs.push(JSON.parse(raw) as SummaryJob);
    } catch {
      console.error(`skipping malformed job ${key.name}`);
    }
  }
  return jobs;
}

/** トークン失効までの残り時間。0 以下ならもう結果を返せない。 */
export function remainingTokenLifeMs(job: SummaryJob, now = Date.now()): number {
  return job.createdAt + TOKEN_TTL_MS - EXPIRY_MARGIN_MS - now;
}
