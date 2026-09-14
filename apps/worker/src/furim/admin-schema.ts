export type AdminColumnType = 'text' | 'integer' | 'real';

export interface AdminColumn {
  name: string;
  type: AdminColumnType;
  editable: boolean;
  searchable?: boolean;
}

export type AdminKeyKind = 'line_user_id' | 'friend_id' | 'stripe_customer_id' | 'key_code';

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
}

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
    joinFriends: true,
    allRows: true,
    columns: [
      ro('line_user_id', true),
      t('stripe_customer_id', true, true),
      t('key_code', true, true),
      i('key_code_issued'),
      i('device_activated'),
      t('survey_answer'),
      i('free30_ticket'),
      t('youtube_coupon'),
      t('extend_keyword'),
      t('subscription_id', true, true),
      t('subscription_start_at'),
      t('subscription_end_at'),
      i('subscription_price'),
      t('plan_label', true, true),
      t('plan_label_legacy'),
      t('packages'),
      t('features'),
      t('multi_channel_sites'),
      t('subscription_source'),
      t('subscription_status'),
      i('copy_tickets'),
      t('mercari_url', true, true),
      t('customer_email', true, true),
      t('last_invoice_id'),
      t('canceled_at'),
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
    label: 'チケット取引',
    pk: 'id',
    orderBy: 'created_at DESC',
    touchUpdatedAt: false,
    columns: [
      ro('id'),
      t('line_user_id', true, true),
      i('delta'),
      t('reason', true, true),
      ro('idempotency_key'),
      t('payment_intent_id', true, true),
      t('invoice_id', true, true),
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
    columns: [
      ro('id'),
      ro('line_user_id', true),
      ro('display_name', true),
      ro('source_url', true),
      ro('target_url', true),
      roi('remaining_tickets'),
      ro('processed_at'),
      ro('imported_at'),
    ],
    keys: [k('line_user_id', 'line_user_id')],
  },
  {
    name: 'furim_survey_answers',
    label: 'アンケート回答',
    pk: 'id',
    orderBy: 'created_at DESC',
    touchUpdatedAt: false,
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
    label: 'マスタ（機能/パッケージ/プラン/チケット単価）',
    pk: ['kind', 'key'],
    orderBy: 'kind ASC',
    touchUpdatedAt: false,
    columns: [
      ro('kind', true),
      ro('key', true),
      t('display_name', true, true),
      t('stripe_price_id', true, true),
      i('monthly_price'),
      i('active'),
      t('payload'),
      ro('fetched_at'),
    ],
    keys: [],
  },
];

export function getAdminTable(name: string): AdminTable | undefined {
  return ADMIN_TABLES.find((x) => x.name === name);
}
