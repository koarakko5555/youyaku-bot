# youyaku-bot

Discord から YouTube 動画を要約する Bot。Cloudflare Workers 上で動き、**無料枠のみで運用できる**。

カードゲーム（シャドウバース）の解説・対戦動画を対象に、マリガン基準や打点計算といった
**上達につながる情報だけを抜き出す**ようプロンプトを組んである。雑談や告知は落とす。

## 使い方

`/youyaku` を実行すると入力フォームが開く。

| 項目 | 必須 | 内容 |
| --- | --- | --- |
| 動画のURL | ✅ | `https://www.youtube.com/watch?v=...` |
| 開始時刻 | | 省略で先頭から。`0:00` `1:23:45` `90m` `5400s` |
| 終了時刻 | | 省略で最後まで。区間は最大3時間 |

`/quota` で無料枠の残りとリセット時刻を確認できる（本人にのみ表示）。

要約は動画のサムネイル付きカードと一緒に投稿され、各項目の先頭に付くタイムスタンプは
**クリックでその場面から再生できる**リンクになる。

## 構成

```
Discord ──(HTTP Interactions)──▶ Workers fetch()
                                    │ ① Ed25519 署名検証
                                    │ ② モーダルを開く / 送信を受けて KV に積む
                                    │ ③ 3秒以内に ACK →「🔄 受け付けました」
                                    ▼
                                   KV
                                    ▲
                                    │ 1分ごとに取り出す
                          Workers scheduled()  ← Cron Trigger（実行上限15分）
                                    │
                                    ├─▶ Gemini generateContent（YouTube URL を直接渡す）
                                    │
                                    └─▶ PATCH で「受け付けました」を要約に差し替え
```

### 要約を Cron に逃がしている理由

`fetch()` ハンドラは ACK を返した後、無料プランだと **30 秒**しか生き延びられない
（`ctx.waitUntil()` の上限）。しかし実測では 31分の動画の初回要約に **約 139 秒**かかった。
Cron Trigger は実行上限が 15 分あり、この制約を受けない。

代償として、Cron の最小間隔が 1 分なので**最大 60 秒の待ちが上乗せ**される。

### 字幕スクレイピングをしない理由

`timedtext` 系の非公式エンドポイントは、データセンター IP（Cloudflare / AWS / GCP）からの
アクセスを YouTube がブロックする。ローカルで動いてもデプロイ後に必ず壊れる。
代わりに Gemini へ YouTube URL をそのまま渡し、動画の取得・解析を Google 側に任せている。
字幕が付いていない動画も要約できる。

### Interactions API ではなく generateContent を使う理由

区間指定（`videoMetadata` の `startOffset` / `endOffset`）が Interactions API に未実装のため。

## セットアップ

### 1. Discord アプリ

[Developer Portal](https://discord.com/developers/applications) で New Application。

- **一般情報** → `PUBLIC KEY` と `APPLICATION ID` を控える
- **Bot** → `Reset Token` でトークンを発行して控える（コマンド登録にのみ使用）
- **Installation** → Guild Install のスコープに `applications.commands` を追加し、
  生成された URL からサーバーに導入する

Message Content Intent は不要（メッセージを読まないため）。Bot の権限設定も不要
（応答は interaction token 経由で返すため、チャンネルへの書き込み権限を使わない）。

### 2. Gemini API キー

[Google AI Studio](https://aistudio.google.com/apikey) で発行する。

### 3. ローカル設定

```bash
npm install
cp .dev.vars.example .dev.vars   # 値を埋める
```

### 4. KV namespace を作る

```bash
npx wrangler kv namespace create JOBS
```

出力された id を `wrangler.jsonc` の `kv_namespaces` に書く。

### 5. コマンド登録とデプロイ

```bash
npm run register                          # コマンド定義を変えたときだけ
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put GEMINI_API_KEY
npm run deploy
```

`.dev.vars` の `DISCORD_GUILD_ID` を指定すると対象サーバーに即時反映される。
空ならグローバル登録になり、反映まで最大 1 時間かかる。

### 6. エンドポイントを Discord に登録

デプロイ時に表示される `https://<name>.<subdomain>.workers.dev` を、
**一般情報 → インタラクション・エンドポイントURL** に設定して保存。

> ⚠️ 「ウェブフック」ページの「エンドポイントURL」とは**別物**。そちらはアプリイベント用。

保存時に Discord が署名付き PING を送るため、**署名検証が動いていないとここで保存に失敗する**。

## コストと制限

| 項目 | 無料枠 | 備考 |
| --- | --- | --- |
| Workers リクエスト | 10万/日 | 個人利用なら十分 |
| Workers CPU 時間 | 10ms/呼び出し | `fetch()` の待ち時間は加算されない |
| Cron Trigger 実行時間 | 15分 | 要約の実質的な上限 |
| KV 書き込み | 1,000/日 | 1 リクエストにつき数回 |
| Gemini 動画 | 8時間/日 | 公開動画のみ |
| Gemini 1リクエスト | 3時間 | 低解像度時。コンテキスト1Mによる制約 |

Gemini の無料枠は**入力データが学習に利用され得る**。非公開の動画を扱う用途では有償プランを検討すること。

### 429 の2種類

| 種類 | 回復まで | 挙動 |
| --- | --- | --- |
| 1日の上限 | 太平洋時間0時（日本時間16時） | 再試行しない |
| 分あたりのトークン上限 | 数十秒 | **自動で最大4回再試行** |

長い動画は 1 回で 20 万トークンを超えるため後者に当たりやすい。区間を短く切ると通りやすい。

## 実測データ（2026-08-09 / gemini-3.6-flash）

| 動画 | 所要 | 入力トークン |
| --- | --- | --- |
| 19秒 | 6.8〜15.7s | 約1,700 |
| 3分33秒 | 9.2〜21.9s | 約19,500 |
| 90分（初回・区間なし） | **138.8s** | 172,327 |
| 90分（2回目以降・区間なし） | 30〜43s | 172,813 |
| 90分のうち10分を指定 | 29〜31s | 55,258 |

読み取れること:

- **所要時間を支配するのは出力の長さで、動画の尺ではない**
- **同じ動画の初回リクエストだけ極端に遅い**。動画の取り込みが初回に走るとみられる
- **区間を指定すると解像度が上がる**。区間なしは約32トークン/秒まで間引かれるが、
  区間ありは約92トークン/秒。精度は上がるが消費も増える

## 開発

```bash
npm run dev        # ローカル起動
npm run typecheck  # 型チェック
npm run measure -- <URL> [--from 0:00 --to 30:00] [--print]
npx wrangler tail  # 本番ログ
```

`measure` は Worker と同じ `src/gemini.ts` を読み込むため、結果が本番の挙動と一致する。
Discord を経由しないので `GEMINI_API_KEY` だけで動く。

Cron は待たずに手動発火できる。

```bash
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled"
```

## ファイル構成

| パス | 役割 |
| --- | --- |
| `src/index.ts` | `fetch()`（署名検証 → モーダル → ジョブ投入）と `scheduled()`（要約実行） |
| `src/gemini.ts` | Gemini 呼び出し、プロンプト、再試行、エラー文言の変換 |
| `src/jobs.ts` | KV を使ったジョブの積み下ろしと、失効ジョブの破棄 |
| `src/quota.ts` | 無料枠の消費を日次で記録（Google は残量 API を出していないため自前集計） |
| `src/timecode.ts` | `1:23:45` `90m` などの時刻解釈と区間の検証 |
| `src/youtube.ts` | URL の正規化、タイムスタンプのリンク化、サムネイル取得 |
| `src/discord.ts` | Ed25519 検証、モーダル値の読み取り、follow-up 送信、embed 分割 |
| `scripts/register.mjs` | スラッシュコマンド登録 |
| `scripts/measure.mjs` | 要約レイテンシの実測 |
