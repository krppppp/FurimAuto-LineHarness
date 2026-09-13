export type AdminColumnType = 'text' | 'integer' | 'real';

export interface AdminColumn {
  name: string;
  type: AdminColumnType;
  editable: boolean;
  searchable?: boolean;
}

export interface AdminTable {
  name: string;
  label: string;
  pk: string;
  orderBy: string;
  touchUpdatedAt: boolean;
  columns: AdminColumn[];
}

const t = (name: string, editable = true, searchable = false): AdminColumn => ({ name, type: 'text', editable, searchable });
const i = (name: string, editable = true): AdminColumn => ({ name, type: 'integer', editable });
const ro = (name: string, searchable = false): AdminColumn => ({ name, type: 'text', editable: false, searchable });

export const ADMIN_TABLES: AdminTable[] = [
  {
    name: 'furim_customers',
    label: '顧客',
    pk: 'line_user_id',
    orderBy: 'updated_at DESC',
    touchUpdatedAt: true,
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
    ],
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
  },
];

export function getAdminTable(name: string): AdminTable | undefined {
  return ADMIN_TABLES.find((x) => x.name === name);
}
