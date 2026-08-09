/** Discord Interactions まわりの薄いヘルパー。ライブラリ依存を持たないための最小実装。 */

export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MODAL_SUBMIT: 5,
} as const;

export const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  MODAL: 9,
} as const;

export const ComponentType = {
  ACTION_ROW: 1,
  TEXT_INPUT: 4,
  LABEL: 18,
} as const;

/** テキスト入力のスタイル。1 = 1行、2 = 複数行。 */
export const TextInputStyle = { SHORT: 1, PARAGRAPH: 2 } as const;

/** メッセージを本人にだけ見せるフラグ。 */
export const EPHEMERAL = 1 << 6;

/**
 * モーダルの中身。Label(18) は単数の `component` を、
 * ActionRow(1) は配列の `components` を持つ。両方の形を受けられるようにしておく。
 */
export interface ModalNode {
  type?: number;
  custom_id?: string;
  value?: string;
  component?: ModalNode;
  components?: ModalNode[];
}

export interface Interaction {
  type: number;
  application_id: string;
  token: string;
  data?: {
    name?: string;
    custom_id?: string;
    options?: { name: string; value: string }[];
    components?: ModalNode[];
  };
  member?: { user?: { id: string } };
  user?: { id: string };
}

/**
 * モーダルの入力値を custom_id で引く。
 * Label 形式と ActionRow 形式のどちらでも辿れるよう、木を再帰的に探索する。
 * 空文字は未入力として undefined を返す。
 */
export function getModalValue(interaction: Interaction, customId: string): string | undefined {
  const found = findNode(interaction.data?.components ?? [], customId);
  const value = found?.value?.trim();
  return value ? value : undefined;
}

function findNode(nodes: ModalNode[], customId: string): ModalNode | undefined {
  for (const node of nodes) {
    if (node.custom_id === customId && node.value !== undefined) return node;

    const children = node.components ?? (node.component ? [node.component] : []);
    const hit = findNode(children, customId);
    if (hit) return hit;
  }
  return undefined;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Discord からのリクエストの Ed25519 署名を検証する。
 * これが無いとエンドポイント URL の登録自体が Discord 側で失敗する。
 */
export async function verifyRequest(
  request: Request,
  rawBody: string,
  publicKeyHex: string,
): Promise<boolean> {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp) return false;
  if (!/^[0-9a-f]+$/i.test(signature) || signature.length !== 128) return false;

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKeyHex),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      hexToBytes(signature),
      new TextEncoder().encode(timestamp + rawBody),
    );
  } catch {
    return false;
  }
}

export function getOption(interaction: Interaction, name: string): string | undefined {
  return interaction.data?.options?.find((o) => o.name === name)?.value;
}

/** deferred ACK 後に、元の「考え中…」メッセージを実際の内容へ差し替える。 */
export async function editOriginalResponse(
  applicationId: string,
  token: string,
  payload: unknown,
): Promise<void> {
  const res = await fetch(
    `https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) {
    console.error("failed to edit original response", res.status, await res.text());
  }
}

const EMBED_DESCRIPTION_LIMIT = 4096;
/**
 * 1メッセージあたり全 embed 合計の上限は 6000 文字。
 * 要約のうしろに枠の状況を伝える embed を足すため、その分を空けて手前で止める。
 */
const EMBED_TOTAL_LIMIT = 5400;

/**
 * 長文を embed の description 上限に収まるよう分割する。
 * 行単位で詰めることで、文の途中で切れるのを避ける。
 */
export function chunkForEmbeds(text: string): { chunks: string[]; truncated: boolean } {
  // 1行だけで上限を超えるケースに備え、先に行そのものを刻んでおく。
  const lines: string[] = [];
  for (const rawLine of text.split("\n")) {
    let line = rawLine;
    while (line.length > EMBED_DESCRIPTION_LIMIT) {
      lines.push(line.slice(0, EMBED_DESCRIPTION_LIMIT));
      line = line.slice(EMBED_DESCRIPTION_LIMIT);
    }
    lines.push(line);
  }

  const chunks: string[] = [];
  let current = "";
  let flushed = 0; // chunks に確定済みの文字数
  let truncated = false;

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > EMBED_DESCRIPTION_LIMIT) {
      chunks.push(current);
      flushed += current.length;
      current = line;
    } else {
      current = candidate;
    }

    if (flushed + current.length > EMBED_TOTAL_LIMIT) {
      truncated = true;
      current = current.slice(0, Math.max(0, EMBED_TOTAL_LIMIT - flushed));
      break;
    }
  }
  if (current) chunks.push(current);

  return { chunks: chunks.length > 0 ? chunks : [""], truncated };
}
