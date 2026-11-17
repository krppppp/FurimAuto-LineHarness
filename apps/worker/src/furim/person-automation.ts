/**
 * 1 人分の自動化処理履歴（TB-3562）。個別チャットの顧客パネルに直近 1 週間を出す。
 * 元は furim_execution_logs（拡張が自動化を始めたときの 1 行・下書きの予約出品は出品/予約/見送りごとの 1 行）。
 * 処理の種類は options のキー（m_changePrice 等）から、名前は拡張の実行画面の表記に合わせる。
 * options には商品一覧が丸ごと入るので、画面へは種類と結果だけ返す。
 */

const SITE_PREFIX = /^(m|yf|r|ms|ya)_/;

const KIND_LABELS: Record<string, string> = {
  changePrice: '値段変更',
  bottomPrice: '底値設定',
  relist: '再出品',
  delete: '削除',
  deleteComment: 'コメント削除',
  comment: 'コメント投稿',
  auto_comment: '自動コメント',
  copyRakumaListing: 'ラクマへコピー出品',
  copyYahooFleamarketListing: 'ヤフフリへコピー出品',
  copyYahooAuctionListing: 'ヤフオクへコピー出品',
  copyMShopsListing: 'Shopsへコピー出品',
  inventorySheetSync: '在庫管理シート連携',
  backup: 'バックアップ',
  promotion: 'プロモーション',
  auction: 'オークション',
  getProductInfo: '商品情報の取得',
  ChangeShipping: '配送方法の変更',
};

const COPY_LIST = 'copy_listing_info_array';

const DRAFT_EVENTS: Record<string, string> = {
  listed: '出品済み',
  scheduled: '予約を登録',
  skipped: '見送り',
};

export type AutomationSource = {
  options: string | null;
  payload: string | null;
  total_target_count: string | null;
};

export type AutomationDescription = {
  kinds: string[];
  reservation: boolean;
  result: string;
};

export type PersonAutomationItem = AutomationDescription & {
  id: string;
  created_at: string;
  service: string | null;
  client: string | null;
};

function parseObject(s: string | null): Record<string, unknown> {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function describeAutomation(src: AutomationSource): AutomationDescription {
  const payload = parseObject(src.payload);
  if (payload.feature === 'draftScheduledListing') {
    const event = String(payload.event ?? '');
    return { kinds: ['下書きの予約出品'], reservation: false, result: DRAFT_EVENTS[event] ?? (event || '—') };
  }

  const options = parseObject(src.options);
  const kinds: string[] = [];
  let hasCopyList = false;
  for (const [key, value] of Object.entries(options)) {
    if (key === 'isReservation' || !value) continue;
    const name = key.replace(SITE_PREFIX, '');
    if (name === COPY_LIST) {
      hasCopyList = true;
      continue;
    }
    const label = KIND_LABELS[name];
    if (!label) {
      kinds.push(key);
    } else if (name === 'changePrice' && Array.isArray(value) && value[0] !== undefined) {
      kinds.push(`${label}（${value[0]}${value[1] ?? ''}）`);
    } else {
      kinds.push(label);
    }
  }
  if (hasCopyList && kinds.length === 0) kinds.push('コピー出品');

  const count = src.total_target_count?.trim();
  return { kinds, reservation: options.isReservation === true, result: count ? `対象 ${count} 件` : '開始' };
}

/** JST で now の days 日前（YYYY-MM-DDTHH:MM:SS）。created_at の頭 19 文字と比べる */
export function automationSince(now: Date, days: number): string {
  return new Date(now.getTime() + 9 * 3600_000 - days * 86400_000).toISOString().slice(0, 19);
}

export async function listPersonAutomation(
  db: D1Database,
  lineUserId: string,
  since: string,
  limit: number,
): Promise<{ total: number; items: PersonAutomationItem[] }> {
  const where = `FROM furim_execution_logs WHERE line_user_id = ? AND substr(replace(created_at, ' ', 'T'), 1, 19) >= ?`;
  const count = await db.prepare(`SELECT COUNT(*) AS n ${where}`).bind(lineUserId, since).first<{ n: number }>();
  const rows = await db
    .prepare(
      `SELECT id, created_at, service, client, total_target_count, options, payload ${where}
       ORDER BY substr(replace(created_at, ' ', 'T'), 1, 23) DESC
       LIMIT ?`,
    )
    .bind(lineUserId, since, limit)
    .all<{ id: string; created_at: string; service: string | null; client: string | null } & AutomationSource>();
  return {
    total: count?.n ?? 0,
    items: (rows.results ?? []).map(({ options, payload, total_target_count, ...r }) => ({
      ...r,
      ...describeAutomation({ options, payload, total_target_count }),
    })),
  };
}
