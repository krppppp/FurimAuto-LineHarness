export type AdminColumnType = 'text' | 'integer' | 'real';

export interface AdminColumn {
  name: string;
  type: AdminColumnType;
  editable: boolean;
  searchable?: boolean;
}

export type AdminKeyKind = 'line_user_id' | 'friend_id' | 'stripe_customer_id' | 'key_code';

export interface AdminVirtualColumn {
  name: string;
  label: string;
  type: AdminColumnType;
  featureKey?: string;
  flag?: 'bool' | 'text';
}

export interface AdminKey {
  column: string;
  kind: AdminKeyKind;
}

export interface AdminTable {
  name: string;
  label: string;
  /** 主キー。複合主キー（furim_feature_flags / furim_master）は配列。行 id は rowIdOf() で 1 文字列にする（#246） */
  pk: string | string[];
  orderBy: string;
  touchUpdatedAt: boolean;
  columns: AdminColumn[];
  keys: AdminKey[];
  /** 一覧で friends を LEFT JOIN して _friend_created_at を付け、友だち登録の新しい順に並べる（#253 追加要望・顧客のみ） */
  joinFriends?: boolean;
  /** 一覧をページ分けせず全件返す（ブラウザ検索で表示名を探すため） */
  allRows?: boolean;
  /** 追加（POST）を許すか。省略時は true。主キーが 'id' 1 列のテーブルは省略時に UUID を採番する */
  insertable?: boolean;
  /** 削除（DELETE）を許すか。省略時は true */
  deletable?: boolean;
  /** 基準日時（その行の出来事が起きた時刻）。一覧で LINE 表示名の次に出す（#253 decision #372） */
  timeColumn?: string;
  /** D1 が付与した内部 ID。一覧では出さず、行ドロワーでは末尾の「内部情報」に入れる */
  internal?: string[];
  idColumns?: string[];
  /** このテーブルだけの日本語ラベル（COLUMN_LABELS より優先） */
  labels?: Record<string, string>;
  virtualColumns?: AdminVirtualColumn[];
  listOrder?: string[];
  hidden?: string[];
  /** CSV に furim_feature_flags を 1 機能 1 列（_flag_<feature_key>）で横持ちにして付ける。一覧では行ドロワーの「機能」で出す（Capsec #261・顧客のみ） */
  featureFlags?: boolean;
}

export const DISPLAY_NAME_COLUMN = '_display_name';
export const FRIEND_CREATED_AT_COLUMN = '_friend_created_at';
export const FEATURE_FLAG_PREFIX = '_flag_';

/** シート「顧客情報-サブスク情報-キーコード」（ヘッダー 3 行目）の機能列の並び（2026-09-14 本番シートを getData で読んだ順）。ここに無い機能はマスタの順で後ろに付ける */
export const FEATURE_FLAG_ORDER = [
  'mChangePrice', 'mSetBottomPrice', 'mComment', 'mDeleteComment', 'mBackup', 'mRelist', 'mAuction', 'mDeleteProduct', 'mAttributeCheckbox',
  'mLoadAdditionalInfo', 'mTimeReservation', 'mAutoComment', 'mAutoTransaction', 'mProfileOptions', 'mSoldCSV',
  'mCopyMShopsListing', 'mCopyRakumaListing', 'mCopyYahooAuctionListing', 'mCopyYahooFleamarketListing',
  'msChangePrice', 'msSetBottomPrice', 'msDeleteProduct', 'msAttributeCheckbox', 'msListingModification', 'msTimeReservation', 'msRelist',
  'rChangePrice', 'rSetBottomPrice', 'rComment', 'rDeleteComment', 'rRelist', 'rDeleteProduct', 'rAttributeCheckbox', 'rListingModification',
  'rTimeReservation', 'rAutoComment', 'rAutoTransaction', 'rSoldCSV',
  'yfChangePrice', 'yfSetBottomPrice', 'yfRelist', 'yfDeleteProduct', 'yfChangeShipping', 'yfAttributeCheckbox', 'yfListingModification',
  'yfTimeReservation', 'yfAutoTransaction', 'yfProfileOptions', 'yfSoldCSV',
  'InventorySheet', 'AutoMultiChannel',
];

/** 機能マスタの site → 見出しの接頭語（マスタの日本語名はサイト名を含まず「値段変更」が 4 サイトで重なるため） */
export const FEATURE_SITE_NAMES: Record<string, string> = { mercari: 'メルカリ', mercariShops: 'メルカリShops', rakuma: 'ラクマ', yahooFlea: 'ヤフフリ' };

export function pkColumns(table: AdminTable): string[] {
  return Array.isArray(table.pk) ? table.pk : [table.pk];
}

export function pkLabel(table: AdminTable): string {
  return pkColumns(table).join(',');
}

const ROW_ID_SEP = '|';

/** 行を 1 文字列の id にする（単一主キーはそのまま、複合主キーは各値を encodeURIComponent して | で連結） */
export function rowIdOf(table: AdminTable, row: Record<string, unknown>): string {
  const cols = pkColumns(table);
  const text = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : String(v));
  if (cols.length === 1) return text(row[cols[0]]);
  return cols.map((c) => encodeURIComponent(text(row[c]))).join(ROW_ID_SEP);
}

/** rowIdOf の逆。列数と合わなければ null */
export function parseRowId(table: AdminTable, id: string): Record<string, string> | null {
  const cols = pkColumns(table);
  if (cols.length === 1) return { [cols[0]]: id };
  const parts = id.split(ROW_ID_SEP);
  if (parts.length !== cols.length) return null;
  const out: Record<string, string> = {};
  cols.forEach((c, i) => {
    try {
      out[c] = decodeURIComponent(parts[i]);
    } catch {
      out[c] = parts[i];
    }
  });
  return out;
}

export function isInsertable(table: AdminTable): boolean {
  if (table.insertable !== undefined) return table.insertable;
  return table.columns.some((c) => c.editable);
}

export function isDeletable(table: AdminTable): boolean {
  return table.deletable !== false;
}

const VIRTUAL_LABELS: Record<string, string> = {
  [DISPLAY_NAME_COLUMN]: 'LINE表示名',
  [FRIEND_CREATED_AT_COLUMN]: '友だち登録日時',
};

export const COLUMN_LABELS: Record<string, string> = {
  id: '内部ID',
  line_user_id: 'LINEユーザーID',
  stripe_customer_id: 'Stripe顧客ID',
  key_code: 'キーコード',
  key_code_issued: 'キーコード発行済み',
  device_activated: '端末判定済み',
  survey_answer: 'アンケート回答',
  free30_ticket: 'Free30チケット',
  youtube_coupon: 'YouTubeクーポン',
  extend_keyword: '延長キーワード',
  subscription_id: 'サブスクID',
  subscription_start_at: 'サブスク開始日時',
  subscription_end_at: 'サブスク終了日時',
  subscription_price: 'サブスク金額',
  plan_label: 'プラン名',
  packages: 'パッケージ',
  features: '機能',
  multi_channel_sites: '多チャネル出品先',
  subscription_source: '契約経路',
  copy_tickets: 'コピー出品チケット残数',
  mercari_url: 'メルカリURL',
  device_code: '端末判定文字列',
  inventory_sheet_url: '在庫管理シート',
  inventory_sheet_created_at: '在庫管理シート作成日時',
  canceled_at: '解約日時',
  sheet_synced_at: 'シート同期日時',
  created_at: '作成日時',
  updated_at: '更新日時',
  invoice_id: '請求書ID',
  stripe_event_id: 'StripeイベントID',
  plan_name: 'プラン名',
  billing_reason: '請求理由',
  discount_amount: '割引額',
  price_excl_tax: '税抜金額',
  tax_amount: '消費税額',
  actual_paid_amount: '実支払額',
  paid_at: '決済日時',
  delta: '増減',
  reason: '理由',
  idempotency_key: '重複防止キー',
  payment_intent_id: 'PaymentIntent ID',
  amount: '金額',
  currency: '通貨',
  display_name: '表示名',
  side_job_judgment: '副業継続判定',
  affiliate_id: 'アンバサダー内部ID',
  ambassador_friend_id: 'アンバサダー友だち内部ID',
  introduced_friend_id: '被紹介者友だち内部ID',
  ref_code: '紹介コード',
  source: '経路',
  ambassador_plan_name: 'アンバサダーのプラン',
  reward_coupon_name: '報酬クーポン名',
  reward_coupon_id: '報酬クーポンID',
  reward_applied_at: '報酬適用日時',
  introduced_coupon_id: '被紹介者クーポンID',
  trial_extended_days: '試用延長日数',
  name: '名前',
  code: 'コード',
  commission_rate: '報酬率',
  is_active: '有効',
  friend_id: '友だち内部ID',
  coupon_id: 'クーポンID',
  service: 'サービス',
  account_url: 'アカウントURL',
  mypage_info_updated_date: 'マイページ情報更新日時',
  count_rating: '評価数',
  sales_amount: '売上',
  total_target_count: '対象件数',
  options: 'オプション',
  client: 'クライアント',
  payload: 'ペイロード',
  method: '処理',
  error: 'エラー',
  discrimination_code: '端末判定コード',
  install_id: 'インストールID',
  rakuma_url: 'ラクマURL',
  yahoo_flea_url: 'ヤフフリURL',
  yahoo_auction_url: 'ヤフオクURL',
  shops_url: 'ShopsURL',
  item_id: '商品ID',
  item_name: '商品名',
  target: '出品先',
  status: '状態',
  target_url: '出品先URL',
  source_url: 'コピー元URL',
  started_at: '開始日時',
  completed_at: '完了日時',
  my_mercari_url: '自分のメルカリURL',
  is_free: '無料',
  remaining_tickets: '残りチケット',
  processed_at: '処理日時',
  imported_at: '取り込み日時',
  answer: '回答',
  coupon_name: 'クーポン名',
  route: '適用経路',
  occurred_at: '発生日時',
  introduced_display_name: '被紹介者の表示名',
  introduced_line_user_id: '被紹介者LINEユーザーID',
  price: '金額',
  ambassador_display_name: 'アンバサダーの表示名',
  ambassador_line_user_id: 'アンバサダーLINEユーザーID',
  cashback_amount: 'キャッシュバック額',
  feature_key: '機能キー',
  value: '値',
  kind: '種別',
  key: 'キー',
  stripe_price_id: 'Stripe価格ID',
  monthly_price: '月額',
  active: '有効',
  fetched_at: '取得日時',
};

/** 列の日本語ラベル。未定義なら英名のまま */
export function columnLabel(table: AdminTable, name: string): string {
  return table.labels?.[name] ?? virtualColumnOf(table, name)?.label ?? VIRTUAL_LABELS[name] ?? COLUMN_LABELS[name] ?? name;
}

export function virtualColumnOf(table: AdminTable, name: string): AdminVirtualColumn | undefined {
  return table.virtualColumns?.find((v) => v.name === name);
}

export function isHiddenColumn(table: AdminTable, name: string): boolean {
  return (table.hidden ?? []).includes(name);
}

export function visibleColumns(table: AdminTable): AdminColumn[] {
  return table.columns.filter((c) => !isHiddenColumn(table, c.name));
}

export function isInternalColumn(table: AdminTable, name: string): boolean {
  return (table.internal ?? []).includes(name) || (table.idColumns ?? []).includes(name);
}

function orderedColumnNames(table: AdminTable, excluded: (name: string) => boolean): string[] {
  const names = [...visibleColumns(table).map((c) => c.name), ...(table.virtualColumns ?? []).map((v) => v.name)].filter(
    (n) => n !== table.timeColumn && !excluded(n),
  );
  const order = (table.listOrder ?? []).filter((n) => names.includes(n));
  const rest = [...order, ...names.filter((n) => !order.includes(n))];
  return table.timeColumn ? [table.timeColumn, ...rest] : rest;
}

/** 一覧の列順: 基準日時 → 残り（内部 ID を除く）。LINE 表示名はこの前に付ける */
export function listColumnNames(table: AdminTable): string[] {
  return orderedColumnNames(table, (n) => isInternalColumn(table, n));
}

/** CSV の列順: LINE 表示名 → 一覧と同じ列 → 内部 ID */
export function csvColumnNames(table: AdminTable): string[] {
  const isOldInternal = (n: string) => (table.internal ?? []).includes(n);
  const internal = visibleColumns(table).map((c) => c.name).filter(isOldInternal);
  return [DISPLAY_NAME_COLUMN, ...orderedColumnNames(table, isOldInternal), ...internal];
}

/**
 * 日時の保存形式（D1 の実データで確認・2026-09-14）
 * jst: 2026-09-13T23:45:43.193+09:00（jstNow）／ jst_naive: 2026-09-13T19:54:32.847（JST・オフセット無し）／
 * space: 2026-09-13 23:45:43（JST）／ utc: 2026-09-13T14:45:43.000Z ／ slash: 2026/09/13 23:45:43
 */
export type DateTimeStorage = 'jst' | 'jst_naive' | 'space' | 'utc' | 'slash';

const DATETIME_DEFAULTS: Record<string, DateTimeStorage> = {
  mypage_info_updated_date: 'utc',
};

/** 日時列なら、値が空のときに使う保存形式。日時列でなければ null */
export function datetimeStorageOf(name: string): DateTimeStorage | null {
  if (DATETIME_DEFAULTS[name]) return DATETIME_DEFAULTS[name];
  return name.endsWith('_at') ? 'jst' : null;
}

type DateParts = { y: number; mo: number; d: number; h: number; mi: number; s: number };

const JST_OFFSET_MS = 9 * 60 * 60_000;
const STORED_RE = /^(\d{4})-(\d{2})-(\d{2})([T ])(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?$/;
const DISPLAY_RE = /^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function jstMsOf(p: DateParts): number {
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - JST_OFFSET_MS;
}

function partsOfJst(ms: number): DateParts {
  const t = new Date(ms + JST_OFFSET_MS);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds() };
}

function validParts(p: DateParts): boolean {
  const q = partsOfJst(jstMsOf(p));
  return q.y === p.y && q.mo === p.mo && q.d === p.d && q.h === p.h && q.mi === p.mi && q.s === p.s;
}

function sameParts(a: DateParts, b: DateParts): boolean {
  return jstMsOf(a) === jstMsOf(b);
}

function parseStoredDateTime(value: string): { parts: DateParts; storage: DateTimeStorage; ms: boolean } | null {
  const m = STORED_RE.exec(value);
  if (m) {
    const naive: DateParts = { y: +m[1], mo: +m[2], d: +m[3], h: +m[5], mi: +m[6], s: m[7] ? +m[7] : 0 };
    if (!validParts(naive)) return null;
    const ms = Boolean(m[8]);
    const tz = m[9];
    if (!tz) return { parts: naive, storage: m[4] === ' ' ? 'space' : 'jst_naive', ms };
    let offsetMin = 0;
    if (tz !== 'Z') {
      const sign = tz[0] === '-' ? -1 : 1;
      const digits = tz.slice(1).replace(':', '');
      offsetMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
    }
    const utcMs = Date.UTC(naive.y, naive.mo - 1, naive.d, naive.h, naive.mi, naive.s) - offsetMin * 60_000;
    return { parts: partsOfJst(utcMs), storage: offsetMin === 540 ? 'jst' : 'utc', ms };
  }
  const parts = parseDisplayDateTime(value);
  return parts ? { parts, storage: 'slash', ms: false } : null;
}

function parseDisplayDateTime(value: string): DateParts | null {
  const d = DISPLAY_RE.exec(value);
  if (!d) return null;
  const parts: DateParts = { y: +d[1], mo: +d[2], d: +d[3], h: +d[4], mi: +d[5], s: d[6] ? +d[6] : 0 };
  return validParts(parts) ? parts : null;
}

function displayOf(p: DateParts): string {
  return `${pad(p.y, 4)}/${pad(p.mo)}/${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
}

/** 保存値 → 表示「2026/09/13 23:45:43」（JST）。日時として読めない値はそのまま */
export function toDisplayDateTime(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : String(value);
  const parsed = parseStoredDateTime(text.trim());
  return parsed ? displayOf(parsed.parts) : text;
}

/**
 * 表示形式の入力 → その列の現在の保存形式。元の値と同じ時刻なら元の値をそのまま返す（ミリ秒を落とさない）。
 * 元の値が空か読めないときは fallback の形式。表示形式として読めない入力はそのまま返す
 */
export function toStorageDateTime(input: string, original: unknown, fallback: DateTimeStorage): string {
  const text = input.trim();
  if (text === '') return '';
  const orig = original === null || original === undefined ? '' : String(original);
  const parts = parseDisplayDateTime(text);
  if (!parts) return orig !== '' && toDisplayDateTime(orig) === text ? orig : input;
  const before = orig !== '' ? parseStoredDateTime(orig.trim()) : null;
  if (before && sameParts(before.parts, parts)) return orig;
  const storage = before ? before.storage : fallback;
  const ms = before ? before.ms : storage !== 'space' && storage !== 'slash';
  const date = `${pad(parts.y, 4)}-${pad(parts.mo)}-${pad(parts.d)}`;
  const time = `${pad(parts.h)}:${pad(parts.mi)}:${pad(parts.s)}`;
  const frac = ms ? '.000' : '';
  switch (storage) {
    case 'jst':
      return `${date}T${time}${frac}+09:00`;
    case 'jst_naive':
      return `${date}T${time}${frac}`;
    case 'space':
      return `${date} ${time}`;
    case 'slash':
      return displayOf(parts);
    case 'utc': {
      const iso = new Date(jstMsOf(parts)).toISOString();
      return ms ? iso : iso.replace(/\.\d{3}Z$/, 'Z');
    }
  }
}

const t = (name: string, editable = true, searchable = false): AdminColumn => ({ name, type: 'text', editable, searchable });
const i = (name: string, editable = true): AdminColumn => ({ name, type: 'integer', editable });
const ro = (name: string, searchable = false): AdminColumn => ({ name, type: 'text', editable: false, searchable });
const roi = (name: string): AdminColumn => ({ name, type: 'integer', editable: false });
const k = (column: string, kind: AdminKeyKind): AdminKey => ({ column, kind });

export const ADMIN_TABLES: AdminTable[] = [
  {
    name: 'furim_customers',
    label: '顧客',
    pk: 'line_user_id',
    orderBy: 'updated_at DESC',
    touchUpdatedAt: true,
    timeColumn: FRIEND_CREATED_AT_COLUMN,
    joinFriends: true,
    allRows: true,
    featureFlags: true,
    labels: { subscription_price: 'サブスク価格' },
    hidden: [
      'subscription_source',
      'multi_channel_sites',
      'features',
      'packages',
      'device_activated',
    ],
    idColumns: ['inventory_sheet_created_at'],
    virtualColumns: [
      { name: '_last_paid_amount', label: '支払い金額', type: 'integer' },
      { name: '_payment_count', label: '通算支払い回数', type: 'integer' },
      { name: '_payment_total', label: '通算支払い総額', type: 'integer' },
    ],
    listOrder: [
      'line_user_id',
      'stripe_customer_id',
      'mercari_url',
      'shops_url',
      'rakuma_url',
      'yahoo_flea_url',
      'plan_label',
      'subscription_id',
      'subscription_start_at',
      'subscription_end_at',
      'subscription_price',
      '_last_paid_amount',
      '_payment_count',
      '_payment_total',
      'youtube_coupon',
      'extend_keyword',
      'survey_answer',
      'key_code_issued',
      'key_code',
      'device_code',
      'free30_ticket',
      'copy_tickets',
      'inventory_sheet_url',
    ],
    columns: [
      ro('line_user_id', true),
      t('stripe_customer_id', true, true),
      t('mercari_url', true, true),
      t('shops_url', true, true),
      t('rakuma_url', true, true),
      t('yahoo_flea_url', true, true),
      t('plan_label', true, true),
      t('subscription_id', true, true),
      t('subscription_start_at'),
      t('subscription_end_at'),
      i('subscription_price'),
      t('youtube_coupon'),
      t('extend_keyword'),
      t('survey_answer'),
      i('key_code_issued'),
      t('key_code', true, true),
      ro('device_code'),
      i('device_activated'),
      i('free30_ticket'),
      i('copy_tickets'),
      ro('inventory_sheet_url'),
      ro('inventory_sheet_created_at'),
      t('packages'),
      t('features'),
      t('multi_channel_sites'),
      t('subscription_source'),
      ro('sheet_synced_at'),
      ro('created_at'),
      ro('updated_at'),
    ],
    keys: [k('line_user_id', 'line_user_id'), k('stripe_customer_id', 'stripe_customer_id'), k('key_code', 'key_code')],
  },
  {
    name: 'furim_payments',
    label: 'サブスク取引',
    pk: 'invoice_id',
    orderBy: 'paid_at DESC',
    touchUpdatedAt: false,
    timeColumn: 'paid_at',
    idColumns: ['invoice_id', 'stripe_event_id', 'line_user_id', 'stripe_customer_id', 'subscription_id'],
    listOrder: ['plan_name', 'billing_reason', 'subscription_price', 'discount_amount', 'price_excl_tax', 'tax_amount', 'actual_paid_amount'],
    columns: [
      ro('invoice_id', true),
      ro('stripe_event_id'),
      t('line_user_id', true, true),
      t('stripe_customer_id', true, true),
      t('subscription_id', true, true),
      t('plan_name', true, true),
      t('billing_reason'),
      i('subscription_price'),
      i('discount_amount'),
      i('price_excl_tax'),
      i('tax_amount'),
      i('actual_paid_amount'),
      t('customer_email', true, true),
      t('paid_at'),
      ro('created_at'),
    ],
    keys: [k('line_user_id', 'line_user_id'), k('stripe_customer_id', 'stripe_customer_id')],
  },
  {
    name: 'furim_ticket_ledger',
    label: 'チケット取引（購入・付与）',
    pk: 'id',
    orderBy: 'created_at DESC',
    touchUpdatedAt: false,
    timeColumn: 'created_at',
    internal: ['id'],
    idColumns: ['line_user_id', 'idempotency_key', 'payment_intent_id'],
    labels: { delta: '付与枚数', reason: '付与の種類', created_at: '付与日時' },
    columns: [
      ro('id'),
      t('line_user_id', true, true),
      i('delta'),
      t('reason', true, true),
      ro('idempotency_key'),
      t('payment_intent_id', true, true),
      i('amount'),
      t('currency'),
      ro('created_at'),
    ],
    keys: [k('line_user_id', 'line_user_id')],
  },
  {
    name: 'furim_cancellations',
    label: '解約履歴',
    pk: 'id',
    orderBy: 'canceled_at DESC',
    touchUpdatedAt: false,
    timeColumn: 'canceled_at',
    internal: ['id'],
    idColumns: ['line_user_id', 'stripe_event_id', 'subscription_id'],
    labels: { display_name: 'LINE表示名（解約時点）' },
    columns: [
      ro('id'),
      t('line_user_id', true, true),
      ro('stripe_event_id'),
      t('subscription_id', true, true),
      t('plan_name', true, true),
      t('mercari_url', true, true),
      t('canceled_at'),
      ro('display_name', true),
      // 副業継続判定（旧 GAS setCancelJudgment のG列。段階4 で管理画面から直接編集・Capsec #246）
      t('side_job_judgment', true, true),
    ],
    keys: [k('line_user_id', 'line_user_id')],
  },
  {
    name: 'furim_referrals',
    label: '紹介履歴',
    pk: 'id',
    orderBy: 'created_at DESC',
    touchUpdatedAt: false,
    timeColumn: 'created_at',
    internal: ['id', 'affiliate_id', 'ambassador_friend_id', 'introduced_friend_id'],
    idColumns: ['_ambassador_line_user_id', '_introduced_line_user_id', 'ref_code', 'reward_coupon_id', 'introduced_coupon_id'],
    labels: {
      _display_name: '被紹介者LINE表示名',
      created_at: '紹介日時',
      ambassador_plan_name: 'プラン名（アンバサダー）',
      reward_coupon_name: 'クーポン名（アンバサダー報酬）',
      reward_applied_at: 'クーポン適用日時',
    },
    virtualColumns: [
      { name: '_ambassador_display_name', label: 'アンバサダーLINE表示名', type: 'text' },
      { name: '_ambassador_line_user_id', label: 'アンバサダーLINE_ID', type: 'text' },
      { name: '_introduced_line_user_id', label: '被紹介者LINE_ID', type: 'text' },
    ],
    listOrder: ['_ambassador_display_name', '_ambassador_line_user_id', 'ambassador_plan_name', 'reward_coupon_name', 'reward_applied_at', '_introduced_line_user_id'],
    columns: [
      ro('id'),
      t('affiliate_id', true, true),
      t('ambassador_friend_id', true, true),
      t('introduced_friend_id', true, true),
      t('ref_code', true, true),
      t('source'),
      t('ambassador_plan_name'),
      t('reward_coupon_name'),
      t('reward_coupon_id'),
      t('reward_applied_at'),
      t('introduced_coupon_id'),
      i('trial_extended_days'),
      ro('created_at'),
    ],
    keys: [k('introduced_friend_id', 'friend_id'), k('ambassador_friend_id', 'friend_id')],
  },
  {
    name: 'affiliates',
    label: 'アンバサダー',
    pk: 'id',
    orderBy: 'created_at DESC',
    touchUpdatedAt: false,
    timeColumn: 'created_at',
    internal: ['id', 'friend_id', 'name', 'commission_rate', 'is_active'],
    idColumns: ['_line_user_id'],
    labels: { name: 'アンバサダー名', code: 'アンバサダーコード', created_at: '登録日時' },
    virtualColumns: [
      { name: '_line_user_id', label: 'LINE_ID', type: 'text' },
      { name: '_referral_count', label: '紹介数', type: 'integer' },
      { name: '_reward_coupon_count', label: 'クーポン付与数', type: 'integer' },
      { name: '_applied_coupon_count', label: '適用済み数', type: 'integer' },
      { name: '_cashback_count', label: 'キャッシュバック件数', type: 'integer' },
      { name: '_cashback_total', label: 'キャッシュバック合計', type: 'integer' },
    ],
    listOrder: ['_line_user_id', 'code'],
    columns: [
      ro('id'),
      t('name', true, true),
      t('code', true, true),
      { name: 'commission_rate', type: 'real', editable: true },
      i('is_active'),
      t('friend_id', true, true),
      ro('created_at'),
    ],
    keys: [k('friend_id', 'friend_id')],
  },
  {
    name: 'furim_coupons',
    label: 'クーポン',
    pk: 'name',
    orderBy: 'name ASC',
    touchUpdatedAt: false,
    idColumns: ['coupon_id'],
    labels: { name: 'クーポン名' },
    columns: [
      ro('name', true),
      t('coupon_id', true, true),
      i('is_active'),
    ],
    keys: [],
  },
  {
    name: 'furim_execution_logs',
    label: '自動化処理履歴',
    pk: 'id',
    orderBy: 'created_at DESC',
    touchUpdatedAt: false,
    timeColumn: 'created_at',
    internal: ['id'],
    idColumns: ['line_user_id', 'key_code'],
    columns: [
      ro('id'),
      ro('line_user_id', true),
      ro('key_code', true),
      ro('service', true),
      ro('account_url', true),
      ro('mypage_info_updated_date'),
      ro('count_rating'),
      ro('sales_amount'),
      ro('total_target_count'),
      ro('options'),
      ro('client'),
      ro('payload'),
      ro('created_at'),
    ],
    keys: [k('line_user_id', 'line_user_id'), k('key_code', 'key_code')],
  },
  {
    name: 'furim_ext_errors',
    label: '拡張エラー',
    pk: 'id',
    orderBy: 'created_at DESC',
    touchUpdatedAt: false,
    timeColumn: 'created_at',
    internal: ['id'],
    idColumns: ['line_user_id', 'key_code', 'discrimination_code'],
    columns: [
      ro('id'),
      ro('line_user_id', true),
      ro('key_code', true),
      ro('method', true),
      ro('error', true),
      ro('mercari_url', true),
      ro('discrimination_code'),
      ro('client'),
      ro('created_at'),
    ],
    keys: [k('line_user_id', 'line_user_id'), k('key_code', 'key_code')],
  },
  {
    name: 'furim_free_accounts',
    label: '無料アカウント台帳',
    pk: 'install_id',
    orderBy: 'updated_at DESC',
    touchUpdatedAt: false,
    timeColumn: 'created_at',
    idColumns: ['install_id', 'key_code'],
    columns: [
      ro('install_id', true),
      ro('mercari_url', true),
      ro('rakuma_url', true),
      ro('yahoo_flea_url', true),
      ro('yahoo_auction_url', true),
      ro('shops_url', true),
      ro('key_code', true),
      ro('created_at'),
      ro('updated_at'),
    ],
    keys: [k('key_code', 'key_code')],
  },
  {
    name: 'furim_manual_copy_logs',
    label: '手動コピー出品履歴',
    pk: 'id',
    orderBy: 'started_at DESC',
    touchUpdatedAt: false,
    timeColumn: 'started_at',
    internal: ['id'],
    idColumns: ['install_id', 'key_code', 'line_user_id', 'item_id'],
    columns: [
      ro('id'),
      ro('install_id', true),
      ro('key_code', true),
      ro('line_user_id', true),
      ro('item_id', true),
      ro('item_name', true),
      ro('target'),
      ro('status'),
      ro('target_url'),
      ro('source_url'),
      ro('started_at'),
      ro('completed_at'),
      ro('created_at'),
    ],
    keys: [k('line_user_id', 'line_user_id'), k('key_code', 'key_code')],
  },
  {
    name: 'furim_shop_research_logs',
    label: 'ショップ調査履歴',
    pk: 'id',
    orderBy: 'created_at DESC',
    touchUpdatedAt: false,
    timeColumn: 'created_at',
    internal: ['id'],
    idColumns: ['install_id', 'key_code', 'line_user_id'],
    labels: { target_url: '調査先URL' },
    columns: [
      ro('id'),
      ro('install_id', true),
      ro('key_code', true),
      ro('line_user_id', true),
      ro('my_mercari_url', true),
      ro('target_url', true),
      roi('is_free'),
      ro('created_at'),
    ],
    keys: [k('line_user_id', 'line_user_id'), k('key_code', 'key_code')],
  },
  // 段階4-B（Capsec #252）: シート過去分の取り込み先。読み取り専用
  {
    name: 'furim_auto_copy_logs',
    label: '自動コピー出品履歴',
    pk: 'id',
    orderBy: 'processed_at DESC',
    touchUpdatedAt: false,
    timeColumn: 'processed_at',
    internal: ['id', 'idempotency_key'],
    idColumns: ['line_user_id'],
    labels: { display_name: 'LINE表示名（記録時点）', target_url: 'コピー先URL', remaining_tickets: '残チケット数（消費後）', delta: '使った枚数', imported_at: '記録日時' },
    columns: [
      ro('id'),
      ro('line_user_id', true),
      ro('display_name', true),
      ro('source_url', true),
      ro('target_url', true),
      roi('remaining_tickets'),
      roi('delta'),
      ro('processed_at'),
      ro('imported_at'),
      ro('idempotency_key'),
    ],
    keys: [k('line_user_id', 'line_user_id')],
  },
  {
    name: 'furim_survey_answers',
    label: 'アンケート回答',
    pk: 'id',
    orderBy: 'created_at DESC',
    touchUpdatedAt: false,
    timeColumn: 'created_at',
    internal: ['id'],
    idColumns: ['line_user_id'],
    labels: { display_name: 'LINE表示名（回答時点）' },
    columns: [
      ro('id'),
      ro('line_user_id', true),
      ro('display_name', true),
      ro('answer', true),
      ro('created_at'),
    ],
    keys: [k('line_user_id', 'line_user_id')],
  },
  {
    name: 'furim_coupon_applications',
    label: 'クーポン適用履歴',
    pk: 'id',
    orderBy: 'created_at DESC',
    touchUpdatedAt: false,
    timeColumn: 'created_at',
    internal: ['id'],
    idColumns: ['line_user_id', 'stripe_customer_id', 'coupon_id'],
    columns: [
      ro('id'),
      ro('line_user_id', true),
      ro('stripe_customer_id', true),
      ro('coupon_name', true),
      ro('coupon_id', true),
      ro('route'),
      ro('created_at'),
    ],
    keys: [k('line_user_id', 'line_user_id'), k('stripe_customer_id', 'stripe_customer_id')],
  },
  {
    name: 'furim_referral_cashbacks',
    label: '紹介キャッシュバック履歴',
    pk: 'id',
    orderBy: 'occurred_at DESC',
    touchUpdatedAt: false,
    timeColumn: 'occurred_at',
    internal: ['id'],
    idColumns: ['introduced_line_user_id', 'stripe_customer_id', 'ambassador_line_user_id'],
    columns: [
      ro('id'),
      ro('occurred_at'),
      ro('introduced_display_name', true),
      ro('introduced_line_user_id', true),
      ro('stripe_customer_id', true),
      roi('price'),
      ro('ambassador_display_name', true),
      ro('ambassador_line_user_id', true),
      roi('cashback_amount'),
      ro('imported_at'),
    ],
    keys: [k('introduced_line_user_id', 'line_user_id'), k('ambassador_line_user_id', 'line_user_id')],
  },
  // 段階4 本体（Capsec #246）: 複合主キーのテーブル
  {
    name: 'furim_feature_flags',
    label: '機能フラグ',
    pk: ['line_user_id', 'feature_key'],
    orderBy: 'updated_at DESC',
    touchUpdatedAt: true,
    timeColumn: 'updated_at',
    idColumns: ['line_user_id'],
    labels: { source: '設定元' },
    columns: [
      ro('line_user_id', true),
      ro('feature_key', true),
      t('value', true, true),
      t('source'),
      ro('updated_at'),
    ],
    keys: [k('line_user_id', 'line_user_id')],
  },
  {
    name: 'furim_master',
    label: 'マスタ（機能/パッケージ/プラン/チケット単価）・閲覧のみ',
    pk: ['kind', 'key'],
    insertable: false,
    deletable: false,
    orderBy: 'kind ASC',
    touchUpdatedAt: false,
    timeColumn: 'fetched_at',
    idColumns: ['stripe_price_id'],
    columns: [
      ro('kind', true),
      ro('key', true),
      ro('display_name', true),
      ro('stripe_price_id', true),
      roi('monthly_price'),
      roi('active'),
      ro('payload'),
      ro('fetched_at'),
    ],
    keys: [],
  },
  // 広告費（Capsec #282 段階2 / #285）。取り込みは GoogleAds/ad_spend_to_d1.py が
  // POST /api/furim/ad-spend/import に流す。手入力・修正もここからできる
  {
    name: 'furim_ad_spend',
    label: '広告費（日次）',
    pk: ['date', 'source', 'campaign_id'],
    orderBy: 'date DESC',
    touchUpdatedAt: false,
    timeColumn: 'date',
    idColumns: ['campaign_id'],
    labels: {
      date: '日付', source: '媒体', campaign_id: 'キャンペーンID', campaign_name: 'キャンペーン名',
      cost_yen: '費用（円）', clicks: 'クリック', impressions: '表示回数', imported_at: '取り込み日時',
    },
    columns: [
      t('date', true, true),
      t('source', true, true),
      t('campaign_id', true, true),
      t('campaign_name', true, true),
      i('cost_yen'),
      i('clicks'),
      i('impressions'),
      ro('imported_at'),
    ],
    keys: [],
  },
  // 手で片づけた操作の記録（Capsec #289 追加）。確認済み（見た記録）とは別に、
  // 「何を何件、なぜ完了扱いにしたか」を残す。閲覧のみ
  {
    name: 'furim_ops_log',
    label: '手作業の記録',
    pk: ['id'],
    insertable: false,
    deletable: false,
    orderBy: 'acted_at DESC',
    touchUpdatedAt: false,
    timeColumn: 'acted_at',
    idColumns: ['id'],
    labels: {
      acted_at: '実行日時', actor: '実行した人', action: '操作', target: '対象',
      target_count: '件数', goal: '根拠', note: '理由',
    },
    columns: [
      ro('id', true),
      ro('acted_at'),
      ro('actor', true),
      ro('action', true),
      ro('target', true),
      roi('target_count'),
      ro('goal', true),
      ro('note', true),
    ],
    keys: [],
  },
];

export function getAdminTable(name: string): AdminTable | undefined {
  return ADMIN_TABLES.find((x) => x.name === name);
}
