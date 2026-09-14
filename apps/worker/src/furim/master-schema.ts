export type MasterKind = 'feature' | 'package' | 'plan' | 'ticket_price';

export type MasterFieldType = 'text' | 'integer' | 'money' | 'bool' | 'select' | 'feature_keys' | 'plan_features';

export interface MasterField {
  name: string;
  label: string;
  type: MasterFieldType;
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  list?: boolean;
  help?: string;
}

export interface MasterKindDef {
  kind: MasterKind;
  label: string;
  sheet: string;
  keyField: string;
  hasActive: boolean;
  fields: MasterField[];
}

const SITE_OPTIONS = [
  { value: 'mercari', label: 'メルカリ' },
  { value: 'mercariShops', label: 'メルカリShops' },
  { value: 'rakuma', label: 'ラクマ' },
  { value: 'yahooFlea', label: 'ヤフフリ' },
];

export const MASTER_KINDS: MasterKindDef[] = [
  {
    kind: 'feature',
    label: '機能マスタ',
    sheet: '機能マスタ',
    keyField: 'feature_key',
    hasActive: true,
    fields: [
      { name: 'feature_key', label: '機能キー', type: 'text', required: true, list: true, help: '英数字と _ だけ。追加後は変えられません' },
      { name: 'service', label: 'サービス', type: 'select', required: true, list: true, options: [
        { value: '1_automation', label: '自動化' },
        { value: '2_copy', label: 'コピー出品' },
        { value: '3_inventory', label: '在庫管理' },
      ] },
      { name: 'site', label: 'サイト', type: 'select', required: true, list: true, options: [...SITE_OPTIONS, { value: 'cross', label: 'サイト横断' }] },
      { name: 'display_name', label: '表示名', type: 'text', required: true, list: true },
      { name: 'description', label: '説明', type: 'text' },
      { name: 'value_type', label: '値の種類', type: 'select', required: true, options: [
        { value: 'bool', label: '有効/無効' },
        { value: 'sitelist', label: '巡回サイト（文字列）' },
      ] },
      { name: 'billing_type', label: '課金方式', type: 'select', required: true, list: true, options: [
        { value: 'subscription', label: '月額' },
        { value: 'ticket', label: 'チケット制' },
      ] },
      { name: 'monthly_price', label: '月額（税抜・円）', type: 'money', list: true, help: '課金方式が月額なら必須' },
      { name: 'stripe_price_id', label: 'Stripe 価格 ID', type: 'text' },
      { name: 'requires', label: '前提の機能', type: 'feature_keys' },
      { name: 'excludes', label: '同時に選べない機能', type: 'feature_keys' },
      { name: 'ui_group', label: '料金画面のグループ', type: 'text', list: true },
      { name: 'sort_order', label: '並び順', type: 'integer', required: true, list: true },
      { name: 'active', label: '有効', type: 'bool', list: true },
    ],
  },
  {
    kind: 'package',
    label: 'パッケージマスタ',
    sheet: 'パッケージマスタ',
    keyField: 'package_key',
    hasActive: true,
    fields: [
      { name: 'package_key', label: 'パッケージキー', type: 'text', required: true, list: true, help: '英数字と _ だけ。追加後は変えられません' },
      { name: 'site', label: 'サイト', type: 'select', required: true, list: true, options: [...SITE_OPTIONS, { value: 'all', label: '全サイト' }] },
      { name: 'plan_type', label: 'プランの種類', type: 'select', required: true, list: true, options: [
        { value: 'full', label: '全自動化' },
        { value: 'semi', label: '半自動化' },
        { value: 'basic', label: '基本' },
        { value: 'premium', label: 'プレミアム' },
        { value: 'trial', label: 'トライアル' },
      ] },
      { name: 'display_name', label: '表示名', type: 'text', required: true, list: true },
      { name: 'monthly_price', label: '月額（税抜・円）', type: 'money', required: true, list: true },
      { name: 'combo_discount', label: '併用割引（円）', type: 'money', required: true, list: true },
      { name: 'stripe_price_id', label: 'Stripe 価格 ID', type: 'text' },
      { name: 'features', label: '含む機能', type: 'feature_keys' },
      { name: 'sort_order', label: '並び順', type: 'integer', required: true, list: true },
      { name: 'active', label: '有効', type: 'bool', list: true },
    ],
  },
  {
    kind: 'plan',
    label: 'プラン一覧（旧プラン）',
    sheet: 'プラン一覧',
    keyField: 'プラン名',
    hasActive: false,
    fields: [
      { name: 'プラン名', label: 'プラン名', type: 'text', required: true, list: true, help: '追加後は変えられません' },
      { name: '価格', label: '価格（円）', type: 'money', required: true, list: true },
      { name: 'PriceID', label: 'Stripe 価格 ID', type: 'text', list: true },
      { name: 'トライアル期間', label: 'トライアル期間（日）', type: 'integer', required: true, list: true },
      { name: 'キーコード接頭語', label: 'キーコード接頭語', type: 'text', list: true },
      { name: 'features', label: '機能', type: 'plan_features' },
    ],
  },
  {
    kind: 'ticket_price',
    label: 'チケット単価',
    sheet: 'チケット単価一覧',
    keyField: '単価',
    hasActive: false,
    fields: [
      { name: '単価', label: '単価（円/枚）', type: 'integer', required: true, list: true, help: '追加後は変えられません' },
      { name: 'PriceID', label: 'Stripe 価格 ID', type: 'text', required: true, list: true },
    ],
  },
];

export function getMasterKind(kind: string): MasterKindDef | undefined {
  return MASTER_KINDS.find((k) => k.kind === kind);
}

type Payload = Record<string, unknown>;

export type MasterRecord = {
  key: string;
  display_name: string | null;
  stripe_price_id: string | null;
  monthly_price: number | null;
  active: number;
  payload: Payload;
};

export type MasterContext = { featureKeys: Set<string> };

const KEY_PATTERN = /^[A-Za-z0-9_]+$/;

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

function parseBool(v: unknown): boolean | null {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  if (typeof v === 'string') {
    const s = v.trim().toUpperCase();
    if (s === 'TRUE' || s === '1') return true;
    if (s === 'FALSE' || s === '0' || s === '') return false;
  }
  return null;
}

function parseKeyList(v: unknown): string[] | null {
  if (isEmpty(v)) return [];
  const items = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null;
  if (!items) return null;
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') return null;
    const s = item.trim();
    if (s) out.push(s);
  }
  return out;
}

function toInt(v: unknown): number | null {
  if (isEmpty(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function sameValue(field: MasterField, before: unknown, next: unknown): boolean {
  switch (field.type) {
    case 'integer':
    case 'money':
      return isEmpty(before) ? isEmpty(next) : !isEmpty(next) && Number(before) === Number(next);
    case 'bool':
      return (parseBool(before) ?? false) === next;
    case 'feature_keys':
      return (parseKeyList(before) ?? []).join(',') === next;
    case 'plan_features': {
      if (!before || typeof before !== 'object' || Array.isArray(before)) return false;
      const a = before as Payload;
      const b = next as Payload;
      const keys = Object.keys(b);
      if (keys.length !== Object.keys(a).length) return false;
      return keys.every((k) => k in a && (typeof b[k] === 'string' ? String(a[k] ?? '') === b[k] : parseBool(a[k]) === b[k]));
    }
    default:
      return String(before ?? '') === next;
  }
}

export function buildMasterRecord(
  def: MasterKindDef,
  values: Payload,
  ctx: MasterContext,
  before?: Payload,
): { record: MasterRecord | null; errors: string[] } {
  const errors: string[] = [];
  const next: Payload = {};

  for (const field of def.fields) {
    const raw = values[field.name];
    const label = field.label;
    switch (field.type) {
      case 'text':
      case 'select': {
        if (raw !== undefined && raw !== null && typeof raw !== 'string' && typeof raw !== 'number') {
          errors.push(`${label} は文字で入力してください`);
          break;
        }
        const s = isEmpty(raw) ? '' : String(raw).trim();
        if (field.required && !s) errors.push(`${label} は必須です`);
        if (s && field.type === 'select' && !field.options!.some((o) => o.value === s)) {
          errors.push(`${label} は ${field.options!.map((o) => o.value).join(' / ')} のどれかにしてください`);
        }
        next[field.name] = s;
        break;
      }
      case 'integer':
      case 'money': {
        if (isEmpty(raw)) {
          if (field.required) errors.push(`${label} は必須です`);
          next[field.name] = '';
          break;
        }
        const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
        if (!Number.isFinite(n) || !Number.isInteger(n)) {
          errors.push(`${label} は整数で入力してください`);
          break;
        }
        if (field.type === 'money' && n < 0) {
          errors.push(`${label} は 0 以上にしてください`);
          break;
        }
        next[field.name] = n;
        break;
      }
      case 'bool': {
        const b = raw === undefined ? false : parseBool(raw);
        if (b === null) {
          errors.push(`${label} は true / false で指定してください`);
          break;
        }
        next[field.name] = b;
        break;
      }
      case 'feature_keys': {
        const list = parseKeyList(raw);
        if (!list) {
          errors.push(`${label} は機能キーの配列で指定してください`);
          break;
        }
        const kept = new Set(parseKeyList(before?.[field.name]) ?? []);
        const unknown = list.filter((item) => {
          const eq = item.indexOf('=');
          return !kept.has(item) && !ctx.featureKeys.has(eq > 0 ? item.slice(0, eq) : item);
        });
        if (unknown.length) errors.push(`${label} に機能マスタに無いキーがあります: ${unknown.join(', ')}`);
        next[field.name] = list.join(',');
        break;
      }
      case 'plan_features': {
        if (raw === undefined || raw === null) {
          next[field.name] = {};
          break;
        }
        if (typeof raw !== 'object' || Array.isArray(raw)) {
          errors.push(`${label} は {機能キー: true/false} で指定してください`);
          break;
        }
        const allowed = new Set([...ctx.featureKeys, ...Object.keys((before?.[field.name] as Payload | undefined) ?? {})]);
        const out: Payload = {};
        for (const [k, v] of Object.entries(raw as Payload)) {
          if (!allowed.has(k)) {
            errors.push(`${label} に機能マスタに無いキーがあります: ${k}`);
            continue;
          }
          if (k === 'AutoMultiChannel') {
            if (v !== null && v !== undefined && typeof v !== 'string') errors.push(`${label} の AutoMultiChannel は文字で指定してください`);
            else out[k] = v ?? '';
            continue;
          }
          const b = parseBool(v);
          if (b === null) errors.push(`${label} の ${k} は true / false で指定してください`);
          else out[k] = b;
        }
        next[field.name] = out;
        break;
      }
    }
  }

  const keyField = def.fields.find((f) => f.name === def.keyField)!;
  const keyValue = next[def.keyField];
  const key = keyValue === '' || keyValue === undefined ? '' : String(keyValue);
  if (key && keyField.type === 'text' && def.kind !== 'plan' && !KEY_PATTERN.test(key)) errors.push(`${keyField.label} は英数字と _ だけにしてください`);
  if (key && keyField.type === 'integer' && Number(keyValue) <= 0) errors.push(`${keyField.label} は 1 以上にしてください`);
  if (def.kind === 'feature' && next.billing_type === 'subscription' && next.monthly_price === '') errors.push('課金方式が月額の機能は 月額（税抜・円） が必須です');
  if (before && key && String(before[def.keyField] ?? '') !== key) errors.push(`${keyField.label} は変えられません（削除して追加し直してください）`);
  if (errors.length) return { record: null, errors };

  const payload: Payload = {};
  const assign = (name: string) => {
    const field = def.fields.find((f) => f.name === name);
    if (!field) {
      payload[name] = before![name];
      return;
    }
    const value = next[name];
    if (before && name in before && sameValue(field, before[name], value)) {
      payload[name] = before[name];
      return;
    }
    if (field.type === 'bool') payload[name] = value ? 'TRUE' : 'FALSE';
    else if (field.type === 'plan_features' && before && before[name] && typeof before[name] === 'object') {
      const prev = before[name] as Payload;
      const merged: Payload = {};
      for (const k of Object.keys(prev)) if (k in (value as Payload)) merged[k] = (value as Payload)[k];
      for (const k of Object.keys(value as Payload)) if (!(k in merged)) merged[k] = (value as Payload)[k];
      payload[name] = merged;
    } else payload[name] = value;
  };
  if (before) {
    for (const name of Object.keys(before)) assign(name);
    for (const field of def.fields) if (!(field.name in payload)) assign(field.name);
  } else {
    for (const field of def.fields) assign(field.name);
  }

  const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
  let record: MasterRecord;
  if (def.kind === 'plan') {
    record = { key, display_name: key, stripe_price_id: isEmpty(payload.PriceID) ? null : String(payload.PriceID).trim(), monthly_price: toInt(payload['価格']), active: 1, payload };
  } else if (def.kind === 'ticket_price') {
    record = { key, display_name: key, stripe_price_id: isEmpty(payload.PriceID) ? null : String(payload.PriceID).trim(), monthly_price: null, active: 1, payload };
  } else {
    record = {
      key,
      display_name: str(payload.display_name),
      stripe_price_id: str(payload.stripe_price_id),
      monthly_price: toInt(payload.monthly_price),
      active: parseBool(payload.active) ? 1 : 0,
      payload,
    };
  }
  return { record, errors: [] };
}

export function masterValuesOf(def: MasterKindDef, payload: Payload): Payload {
  const out: Payload = {};
  for (const field of def.fields) {
    const v = payload[field.name];
    switch (field.type) {
      case 'integer':
      case 'money':
        out[field.name] = isEmpty(v) ? '' : Number(v);
        break;
      case 'bool':
        out[field.name] = parseBool(v) ?? false;
        break;
      case 'feature_keys':
        out[field.name] = parseKeyList(v) ?? [];
        break;
      case 'plan_features': {
        const m: Payload = {};
        for (const [k, x] of Object.entries((v as Payload | undefined) ?? {})) m[k] = typeof x === 'string' && k === 'AutoMultiChannel' ? x : parseBool(x) ?? false;
        out[field.name] = m;
        break;
      }
      default:
        out[field.name] = v === null || v === undefined ? '' : String(v);
    }
  }
  return out;
}
