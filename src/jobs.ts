/**
 * 要約ジョブの受け渡し。
 *
 * Interaction ハンドラは「30 秒の壁」（waitUntil の上限）の中で終わらせる必要があるが、
 * 実測では長尺動画の初回要約に約 139 秒かかる。そのため要約本体は Cron Trigger
 * （実行上限 15 分）へ逃がし、その間の受け渡しに KV を使う。
 *
 * ## 毎分 list してはいけない
 *
 * KV の無料枠はアカウント単位の合算で、操作ごとに桁が違う。
 *
 *   list 1,000/日 ／ write 1,000/日 ／ delete 1,000/日 ／ read 100,000/日
 *
 * Cron は最小間隔の毎分（= 1,440 回/日）で起きるため、キューが空でも list を撃つ実装だと
 * ジョブが 1 件も無い日でも必ず list を使い切る。しかも枠はアカウント単位なので、
 * 同じアカウントの他の Worker まで巻き添えでブロックされる（2026-08 に実際に起きた）。
 * list を「キュー用の1キーを毎分 write する」形に置き換える手も、write が同じ 1,000/日 なので詰む。
 *
 * 桁が違うのは read だけなので、そこへ寄せる。毎分やってよいのは kv.get() だけ、と考える。
 *
 * ## 番兵キーで list を守る
 *
 * enqueueJob は job キーに加えて番兵キー（PENDING_KEY）を短い TTL 付きで置く。
 * claimJobs はまず番兵を kv.get() し、無ければ list せずに帰る。
 * これで list を撃つのは「直近にジョブが積まれた数分間」だけになる。
 *
 * 番兵は delete せず TTL で消す。「空を確認したから消す」方式だと、消す直前に積まれた
 * ジョブの番兵まで消してしまい、そのジョブが誰にも拾われないまま失効する。
 * 余計に list が数回走るほうが、ジョブを取りこぼすより安い。
 *
 * ## 遅延の見積もり
 *
 * KV は結果整合で、put が list に現れるまでと、kv.get() の（存在しないという結果も含む）
 * キャッシュが切れるまでに、それぞれ最大 60 秒かかる。つまりジョブ投入から拾い上げまでは
 * 最悪 2 分強（番兵の伝播 + Cron の 1 分刻み）。要約に約 139 秒かかるとしても、
 * Discord の follow-up トークンの 15 分（TOKEN_TTL_MS）に対して 10 分近く余裕がある。
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

/**
 * 「拾うべきジョブがあるかもしれない」ことだけを示す番兵キー。
 * 値は最後にジョブを積んだ時刻（ログ調査用で、処理には使わない）。
 */
const PENDING_KEY = "queue:pending";

/**
 * 番兵の寿命。
 *
 * 「積まれたジョブが全部 claim されるまで」生きていればよい。list に現れるまで最大 60 秒、
 * そこから MAX_JOBS_PER_TICK 件ずつ毎分さらっていくので、実用上は 2〜3 分で足りる。
 * 一方これを延ばした分だけ空振りの list が増える（1 分につき 1 回）ため、5 分で切る。
 * ここを過ぎても拾われないジョブは、どのみちトークンが失効して結果を返せない。
 */
const PENDING_TTL_SECONDS = 5 * 60;

/** Discord の interaction token の有効期間。 */
export const TOKEN_TTL_MS = 15 * 60 * 1000;
/** 失効間際のジョブは処理しても結果を返せないため、この余裕を切ったら捨てる。 */
const EXPIRY_MARGIN_MS = 60 * 1000;

export async function enqueueJob(kv: KVNamespace, job: SummaryJob): Promise<void> {
  // キーに作成時刻を入れて古い順に並ぶようにする（KV の list はキー名昇順）。
  const key = `${PREFIX}${String(job.createdAt).padStart(15, "0")}:${crypto.randomUUID()}`;
  // 3 秒の ACK 期限の内側で走るので、2 本の書き込みを直列にせず一度に投げる。
  await Promise.all([
    kv.put(key, JSON.stringify(job), {
      // 何らかの理由で拾われなかったジョブが残り続けないようにする。
      expirationTtl: 60 * 60,
    }),
    kv.put(PENDING_KEY, String(job.createdAt), { expirationTtl: PENDING_TTL_SECONDS }),
  ]);
}

/**
 * 古い順に最大 limit 件のジョブを取り出す。キューが空なら list せずに帰る。
 *
 * 取り出したジョブは即座に削除して所有権を確保する。要約は 1 分以上かかるため
 * Cron の実行が重なるが、先に消しておけば二重に Gemini を叩くことを避けられる。
 * KV は結果整合なので完全な排他ではない点に注意（個人利用の規模では実害が出にくい）。
 */
export async function claimJobs(kv: KVNamespace, limit: number): Promise<SummaryJob[]> {
  // 番兵が見えないならキューは空とみなす。ここで帰ることで、
  // ジョブの無い日の list をゼロに保っている（冒頭の「毎分 list してはいけない」を参照）。
  if ((await kv.get(PENDING_KEY)) === null) return [];

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
