// Chrome 拡張の認証（GAS getKeyCodeSet の移植・Capsec #245・2026-09-14）。
//
// D1 furim_customers（key_code 索引）＋furim_feature_flags が正で、KV FURIM_EXT_CACHE は 60 秒の写し。
// 判定の順序・救済条件・エラー文字列は GAS getKeyCodeSet.js と同じ（content.js / popup.js の判定を変えないため）。
import { jstNow } from '@line-crm/db';
import { parseJstDateTime, type FurimCustomer, type FurimCustomerPatch } from './customer-store.js';

export const EXT_CACHE_TTL_SECONDS = 60;

export type ExtCustomerBundle = { customer: FurimCustomer; flags: Record<string, string> };

export type ExtCache = Pick<KVNamespace, 'get' | 'put' | 'delete'>;

const cacheKey = (keyCode: string) => `kc:${keyCode}`;

async function readCustomerFromDb(db: D1Database, keyCode: string): Promise<ExtCustomerBundle | null> {
  const customer = await db.prepare('SELECT * FROM furim_customers WHERE key_code = ? ORDER BY updated_at DESC LIMIT 1').bind(keyCode).first<FurimCustomer>();
  if (!customer) return null;
  const rows = await db
    .prepare('SELECT feature_key, value FROM furim_feature_flags WHERE line_user_id = ?')
    .bind(customer.line_user_id)
    .all<{ feature_key: string; value: string }>();
  const flags: Record<string, string> = {};
  for (const r of rows.results ?? []) flags[r.feature_key] = r.value;
  return { customer, flags };
}

/** KV → D1 の順で顧客行＋機能フラグを読む。fresh=true なら KV を飛ばして D1 を読み、KV を更新する */
export async function loadCustomerByKeyCode(
  db: D1Database,
  kv: ExtCache | undefined,
  keyCode: string,
  opts: { fresh?: boolean } = {},
): Promise<{ bundle: ExtCustomerBundle | null; fromCache: boolean }> {
  if (kv && !opts.fresh) {
    try {
      const cached = await kv.get(cacheKey(keyCode), 'json');
      if (cached && typeof cached === 'object' && (cached as ExtCustomerBundle).customer) {
        return { bundle: cached as ExtCustomerBundle, fromCache: true };
      }
    } catch (e) {
      console.warn('[ext-auth] KV get failed (fallback to D1):', String(e));
    }
  }
  const bundle = await readCustomerFromDb(db, keyCode);
  if (kv && bundle) {
    try {
      await kv.put(cacheKey(keyCode), JSON.stringify(bundle), { expirationTtl: EXT_CACHE_TTL_SECONDS });
    } catch (e) {
      console.warn('[ext-auth] KV put failed:', String(e));
    }
  }
  return { bundle, fromCache: false };
}

export async function invalidateExtCache(kv: ExtCache | undefined, keyCode: string | null | undefined): Promise<void> {
  if (!kv || !keyCode) return;
  try {
    await kv.delete(cacheKey(keyCode));
  } catch (e) {
    console.warn('[ext-auth] KV delete failed:', String(e));
  }
}

/** GAS の Math.random().toString(36).slice(-16) と同じ見た目（base36・16 文字）。乱数だけ crypto */
export function generateDeviceCode(): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}

/** 'YYYY-MM-DD HH:MM:SS'（JST）→ '...T...+09:00'。空・解釈不能は ''（GAS は空セルを "" で返していた） */
export function formatExpiredDate(subscriptionEndAt: string | null | undefined): string {
  const ms = parseJstDateTime(subscriptionEndAt);
  if (ms == null) return subscriptionEndAt ? String(subscriptionEndAt) : '';
  return new Date(ms + 9 * 60 * 60_000).toISOString().replace('Z', '+09:00');
}

/** furim_feature_flags の値 → GAS funcObject と同じ形（'1'/'0' は bool・それ以外は文字列） */
export function flagsToFuncObject(flags: Record<string, string>): Record<string, boolean | string> {
  const out: Record<string, boolean | string> = {};
  for (const [k, v] of Object.entries(flags)) out[k] = v === '1' ? true : v === '0' ? false : v;
  return out;
}

// ── 業務エラーの文言（GAS getKeyCodeSet.js と同一） ──
export const KEY_CODE_ERROR = {
  NOT_FOUND: '該当レコードなし',
  KEY_CODE_RENEWED: 'キーコードが更新されました',
  PLAN_CANCELED: 'プランキャンセル済み',
  EXPIRED: '有効期限切れ',
  TRIAL_ENDED: '無料期間終了',
  DEVICE_MISMATCH: '端末判定文字列が一致しないので不正利用',
  MERCARI_URL_MISMATCH: 'メルカリURL不一致',
  MERCARI_URL_DUPLICATE: 'メルカリURL重複',
} as const;

export function keyCodeErrorMessage(error: string, ctx: { currentMercariUrl: string | null; mercariAccountUrl: string | null }): string {
  switch (error) {
    case KEY_CODE_ERROR.NOT_FOUND:
      return '入力されたキーコードは登録されていません。公式LINEを確認した上で正しいキーコードをご確認ください。';
    case KEY_CODE_ERROR.KEY_CODE_RENEWED:
      return 'ご利用中のプランが更新され、キーコードが新しく発行されています。お手数ですが、\n公式LINEにてキーコード発行をタップして新しいキーコードを発行した上で\n丸っとコピペにて入力をお願いいたします。';
    case KEY_CODE_ERROR.PLAN_CANCELED:
      return 'このプランは既にキャンセルされています。利用を再開したい場合は、再度サブスクリプション契約が必要です。';
    case KEY_CODE_ERROR.EXPIRED:
      return 'このキーコードの有効期限が切れています。サブスクリプションを更新してください。';
    case KEY_CODE_ERROR.TRIAL_ENDED:
      return '無料期間は終了しました。継続してご利用希望の場合は有料プランへご登録ください。';
    case KEY_CODE_ERROR.DEVICE_MISMATCH:
      return 'このキーコードは別の端末で既に使用されているか、以前の入力時に紐付けが正常に処理できませんでした。\nお手数ですが、\n【キーワード】キーコードリセット\nこちらをカッコ含めて丸っとコピペにてLINEへ一度送信して下さい。';
    case KEY_CODE_ERROR.MERCARI_URL_MISMATCH:
      return '登録されているメルカリアカウントと異なるアカウントからのアクセスです。このキーコードは「' + (ctx.currentMercariUrl ?? '') + '」に紐づけられています。';
    case KEY_CODE_ERROR.MERCARI_URL_DUPLICATE:
      return 'このメルカリアカウント（' + (ctx.mercariAccountUrl || 'URL不明') + '）は既に別のキーコードで使用されています。1つのキーコードはメルカリアカウント1つでのみ利用可能です。\n'
        + (ctx.currentMercariUrl
          ? '今回入力されたキーコードには「' + ctx.currentMercariUrl + '」のメルカリアカウントが紐づけられています。こちらのアカウントでご利用ください。'
          : '今回入力されたキーコードには、まだメルカリアカウントが紐づけられていません。');
    default:
      return 'エラーが発生しました。しばらく時間をおいて再度お試しください。';
  }
}

export type KeyCodeSetInput = {
  keyCode: string;
  discriminationCode: string | null;
  mercariAccountUrl: string | null;
};

export type KeyCodeSetSuccess = {
  success: true;
  keyCode: string;
  expiredDate: string;
  discriminationCode: string;
  copyCredit: number;
  funcObject: Record<string, boolean | string>;
};

export type KeyCodeSetOutcome =
  | { ok: true; response: KeyCodeSetSuccess; patch: FurimCustomerPatch; cacheDirty: boolean }
  | { ok: false; error: string; currentMercariUrl: string | null };

/**
 * GAS getKeyCodeSet の判定部（純粋関数）。
 * mercariUrlOwnedByOther: 送られてきたメルカリURLを他の顧客行が持っているか（呼び出し側が D1 で引く）
 */
export function evaluateKeyCodeSet(
  bundle: ExtCustomerBundle,
  input: KeyCodeSetInput,
  opts: { nowMs: number; mercariUrlOwnedByOther: boolean; deviceCode?: () => string },
): KeyCodeSetOutcome {
  const { customer, flags } = bundle;
  const currentMercariUrl = customer.mercari_url ?? null;
  const genDevice = opts.deviceCode ?? generateDeviceCode;

  // 1. 有効期限（解約者もここで弾く。GAS と同じく終了日時に一本化）
  const expiresMs = parseJstDateTime(customer.subscription_end_at);
  if (expiresMs != null && expiresMs < opts.nowMs) {
    const plan = customer.plan_label ?? '';
    if (plan.indexOf('キャンセル済み') === 0) return { ok: false, error: KEY_CODE_ERROR.PLAN_CANCELED, currentMercariUrl };
    if (plan.includes('プラン')) return { ok: false, error: KEY_CODE_ERROR.EXPIRED, currentMercariUrl };
    return { ok: false, error: KEY_CODE_ERROR.TRIAL_ENDED, currentMercariUrl };
  }

  // 2. 端末判定文字列（初回は発行。不一致は「クライアント未保持 かつ 登録メルカリURL一致」だけ再発行で救済）
  const patch: FurimCustomerPatch = {};
  let cacheDirty = false;
  let deviceCode = customer.device_code ?? '';
  if (!deviceCode) {
    deviceCode = genDevice();
    patch.device_code = deviceCode;
    patch.device_activated = 1;
    cacheDirty = true;
  } else if (deviceCode !== (input.discriminationCode ?? '')) {
    if (!input.discriminationCode && input.mercariAccountUrl && currentMercariUrl && currentMercariUrl === input.mercariAccountUrl) {
      deviceCode = genDevice();
      patch.device_code = deviceCode;
      patch.device_activated = 1;
      cacheDirty = true;
    } else {
      return { ok: false, error: KEY_CODE_ERROR.DEVICE_MISMATCH, currentMercariUrl };
    }
  }

  // 3. メルカリURL（登録済みと違えば不一致・他の行が持っていれば重複・未登録なら保存）
  if (input.mercariAccountUrl) {
    if (currentMercariUrl && currentMercariUrl !== input.mercariAccountUrl) {
      return { ok: false, error: KEY_CODE_ERROR.MERCARI_URL_MISMATCH, currentMercariUrl };
    }
    if (opts.mercariUrlOwnedByOther) {
      return { ok: false, error: KEY_CODE_ERROR.MERCARI_URL_DUPLICATE, currentMercariUrl };
    }
    if (currentMercariUrl !== input.mercariAccountUrl) {
      patch.mercari_url = input.mercariAccountUrl;
      cacheDirty = true;
    }
  }

  patch.ext_last_seen_at = jstNow();

  return {
    ok: true,
    cacheDirty,
    patch,
    response: {
      success: true,
      keyCode: customer.key_code ?? input.keyCode,
      expiredDate: formatExpiredDate(customer.subscription_end_at),
      discriminationCode: deviceCode,
      copyCredit: Number(customer.copy_tickets ?? 0) || 0,
      funcObject: flagsToFuncObject(flags),
    },
  };
}

export type ExtErrorInput = {
  method: string;
  error: string;
  lineUserId?: string | null;
  keyCode?: string | null;
  mercariUrl?: string | null;
  discriminationCode?: string | null;
  client?: string | null;
};

/** 旧: シート「Error」への追記。ヘルス巡回はここを読む */
export async function recordExtError(db: D1Database, input: ExtErrorInput): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO furim_ext_errors (id, line_user_id, key_code, method, error, mercari_url, discrimination_code, client, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        input.lineUserId ?? null,
        input.keyCode ?? null,
        input.method,
        input.error,
        input.mercariUrl ?? null,
        input.discriminationCode ?? null,
        input.client ?? null,
        jstNow(),
      )
      .run();
  } catch (e) {
    console.error('[ext-auth] recordExtError failed:', String(e));
  }
}

/** メルカリURL → line_user_id（GAS resolveLineNameForError の逆引き。末尾スラッシュは無視） */
export async function findLineUserIdByMercariUrl(db: D1Database, url: string | null | undefined, excludeLineUserId?: string | null): Promise<string | null> {
  const norm = String(url ?? '').trim().replace(/\/+$/, '');
  if (!norm) return null;
  const row = await db
    .prepare(
      `SELECT line_user_id FROM furim_customers
       WHERE (mercari_url = ? OR mercari_url = ?) AND (? IS NULL OR line_user_id <> ?)
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .bind(norm, norm + '/', excludeLineUserId ?? null, excludeLineUserId ?? null)
    .first<{ line_user_id: string }>();
  return row?.line_user_id ?? null;
}
