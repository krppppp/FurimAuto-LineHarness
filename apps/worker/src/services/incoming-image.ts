const LINE_CONTENT_API_BASE = 'https://api-data.line.me/v2/bot/message';

const CONTENT_TYPE_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-m4v': 'm4v',
};

export interface FetchAndStoreOptions {
  r2: R2Bucket;
  /** workers 環境では globalThis.fetch を使う。テスト時に注入する。 */
  fetch?: typeof fetch;
  /** 公開 URL のベース (例: https://your-worker.your-subdomain.workers.dev) */
  workerUrl: string;
  channelAccessToken: string;
  accountId: string;
  messageId: string;
}

export interface IncomingImageRefs {
  originalContentUrl: string;
  previewImageUrl: string;
}

function sanitizeKeyPart(part: string): string {
  // accountId / messageId は実質 UUID / LINE 数字 ID で安全だが、念のため
  // R2 キーに不正な文字（スラッシュ等）が混入しないよう sanitize する。
  return part.replace(/[^a-zA-Z0-9-]/g, '_');
}

async function putResponseToR2(
  r2: R2Bucket,
  key: string,
  res: Response,
  contentType: string,
): Promise<void> {
  // 動画は最大200MB級で arrayBuffer だと Workers のメモリ上限に当たり得るため、
  // Content-Length が分かる場合は FixedLengthStream 経由でストリーム PUT する。
  const len = Number(res.headers.get('Content-Length') ?? '');
  const FLS = (globalThis as { FixedLengthStream?: new (n: number) => { readable: ReadableStream; writable: WritableStream } }).FixedLengthStream;
  if (res.body && Number.isFinite(len) && len > 0 && FLS) {
    const fls = new FLS(len);
    const pipe = res.body.pipeTo(fls.writable);
    await Promise.all([r2.put(key, fls.readable, { httpMetadata: { contentType } }), pipe]);
    return;
  }
  const data = await res.arrayBuffer();
  await r2.put(key, data, { httpMetadata: { contentType } });
}

/**
 * LINE Content API から incoming 画像/動画バイナリを取得し R2 に保存して URL を返す。
 * 動画は /content/preview のサムネイルも保存し previewImageUrl に使う。
 * 失敗時は null を返し、呼び出し元は `[画像]` / `[動画]` ラベルフォールバックを使う。
 */
export async function fetchAndStoreIncomingMedia(
  opts: FetchAndStoreOptions & { messageType?: 'image' | 'video' },
): Promise<IncomingImageRefs | null> {
  const fetcher = opts.fetch ?? fetch;
  const messageType = opts.messageType ?? 'image';

  let res: Response;
  try {
    res = await fetcher(`${LINE_CONTENT_API_BASE}/${opts.messageId}/content`, {
      headers: { Authorization: `Bearer ${opts.channelAccessToken}` },
    });
  } catch (err) {
    console.error('incoming-image: fetch failed', { err, messageId: opts.messageId, accountId: opts.accountId });
    return null;
  }

  if (!res.ok) {
    console.error('incoming-image: non-200', { status: res.status, messageId: opts.messageId, accountId: opts.accountId });
    return null;
  }

  const contentType = res.headers.get('Content-Type')?.split(';')[0].trim() ?? 'application/octet-stream';
  const ext = CONTENT_TYPE_TO_EXT[contentType];
  if (!ext) {
    console.error('incoming-image: unsupported content-type', { contentType, messageId: opts.messageId, accountId: opts.accountId });
    return null;
  }
  const safeAccountId = sanitizeKeyPart(opts.accountId);
  const safeMessageId = sanitizeKeyPart(opts.messageId);
  const key = `incoming-${safeAccountId}-${safeMessageId}.${ext}`;

  try {
    await putResponseToR2(opts.r2, key, res, contentType);
  } catch (err) {
    console.error('incoming-image: R2 put failed', { err, messageId: opts.messageId, accountId: opts.accountId });
    return null;
  }

  const base = opts.workerUrl.replace(/\/$/, '');
  const url = `${base}/images/${key}`;

  // 動画: LINE の preview エンドポイントからサムネ JPEG を取得して保存。
  // 失敗しても動画本体は使えるので originalContentUrl でフォールバック。
  let previewUrl = url;
  if (messageType === 'video') {
    try {
      const previewRes = await fetcher(`${LINE_CONTENT_API_BASE}/${opts.messageId}/content/preview`, {
        headers: { Authorization: `Bearer ${opts.channelAccessToken}` },
      });
      if (previewRes.ok) {
        const previewKey = `incoming-${safeAccountId}-${safeMessageId}-preview.jpg`;
        const previewType = previewRes.headers.get('Content-Type')?.split(';')[0].trim() ?? 'image/jpeg';
        await putResponseToR2(opts.r2, previewKey, previewRes, previewType);
        previewUrl = `${base}/images/${previewKey}`;
      }
    } catch (err) {
      console.error('incoming-image: preview fetch failed', { err, messageId: opts.messageId, accountId: opts.accountId });
    }
  }

  return { originalContentUrl: url, previewImageUrl: previewUrl };
}

/**
 * 後方互換の画像専用ラッパー。
 */
export async function fetchAndStoreIncomingImage(
  opts: FetchAndStoreOptions,
): Promise<IncomingImageRefs | null> {
  return fetchAndStoreIncomingMedia({ ...opts, messageType: 'image' });
}
