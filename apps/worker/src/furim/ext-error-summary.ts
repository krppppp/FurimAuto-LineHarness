import {
  EXT_ERROR_BY_DESIGN_REASONS,
  EXT_ERROR_METHOD_LABELS,
  extErrorReasonLabel,
} from './ext-error-labels.js';

/**
 * トップの異常区画に出す「認証エラーと監視の記録」（直近 24 時間）を、記録の種類で分ける（2026-09-17 くろさん OK）。
 * 以前は method を問わず 1 項目「拡張のエラー」に数えていたため、何の記録か分からず、collectSkip は専用項目と二重に数えていた。
 *
 * - キーコード認証（getKeyCodeSet）: 理由ごとの内訳。仕組みどおり（有効期限切れ・無料期間終了・プランキャンセル済み）だけなら出さない
 * - 記録の送信で会員が見つからない（stackExecutionData・updateCopyCredit）: 認証ではない
 * - LINE bot の処理失敗（botHandler）: 返信が届いていない可能性があるので赤
 * - AI チャットの説明書取得失敗（aiChatHowto）: faq.md だけで回答した
 * - collectSkip は「巡回キューの取りこぼし」だけに出すので、ここでは数えない
 */

export type ExtErrorAnomaly = {
  kind: string;
  label: string;
  count: number;
  since: string | null;
  href: string;
  severity: 'red' | 'yellow';
  details: Array<{ label: string; sub: string; href: string }>;
  note?: string;
};

type Row = { method: string; error: string; n: number; people: number; since: string | null };
type PeopleRow = { method: string; people: number };

const DATA_HREF = '/data/table?name=furim_ext_errors';
const searchHref = (q: string) => `${DATA_HREF}&q=${encodeURIComponent(q)}`;
const secOf = (col: string) => `substr(replace(${col}, ' ', 'T'), 1, 19)`;
const personOf = "COALESCE(NULLIF(line_user_id, ''), NULLIF(key_code, ''))";

function minSince(rows: Row[]): string | null {
  const vs = rows.map((r) => r.since).filter((v): v is string => Boolean(v)).sort();
  return vs[0] ?? null;
}

const sum = (rows: Row[]) => rows.reduce((a, r) => a + Number(r.n), 0);

export async function summarizeExtErrors(db: D1Database, sinceJst: string): Promise<ExtErrorAnomaly[]> {
  const [byReason, byMethod] = await Promise.all([
    db
      .prepare(
        `SELECT method, error, COUNT(*) AS n, COUNT(DISTINCT ${personOf}) AS people, MIN(created_at) AS since
         FROM furim_ext_errors
         WHERE ${secOf('created_at')} >= ? AND method <> 'collectSkip'
         GROUP BY method, error`,
      )
      .bind(sinceJst)
      .all<Row>(),
    db
      .prepare(
        `SELECT method, COUNT(DISTINCT ${personOf}) AS people
         FROM furim_ext_errors
         WHERE ${secOf('created_at')} >= ? AND method <> 'collectSkip'
         GROUP BY method`,
      )
      .bind(sinceJst)
      .all<PeopleRow>(),
  ]);
  const rows = (byReason.results ?? []).map((r) => ({ ...r, n: Number(r.n), people: Number(r.people) }));
  const peopleOf = (methods: string[]) =>
    (byMethod.results ?? []).filter((r) => methods.includes(r.method)).reduce((a, r) => a + Number(r.people), 0);
  const items: ExtErrorAnomaly[] = [];

  // キーコード認証
  const auth = rows.filter((r) => r.method === 'getKeyCodeSet');
  const authProblem = auth.filter((r) => !EXT_ERROR_BY_DESIGN_REASONS.has(r.error));
  if (authProblem.length > 0) {
    const ordered = [...authProblem.sort((a, b) => b.n - a.n), ...auth.filter((r) => EXT_ERROR_BY_DESIGN_REASONS.has(r.error)).sort((a, b) => b.n - a.n)];
    items.push({
      kind: 'ext_auth_rejected',
      label: `キーコード認証で弾かれた（直近 24 時間）・${peopleOf(['getKeyCodeSet'])} 人`,
      count: sum(auth),
      since: minSince(authProblem),
      href: searchHref('getKeyCodeSet'),
      severity: 'yellow',
      details: ordered.map((r) => ({
        label: extErrorReasonLabel(r.error),
        sub: `${r.n} 件・${r.people} 人${EXT_ERROR_BY_DESIGN_REASONS.has(r.error) ? '・仕組みどおり' : ''}`,
        href: searchHref(r.error),
      })),
      note: 'ポップアップの認証ボタン・自動化を始める前の自動チェック・ページ内の移動ボタンの、どこかで行われた認証。どこで押したかは記録に残らない',
    });
  }

  // 記録の送信で会員が見つからない（認証ではない）
  const recordMethods = ['stackExecutionData', 'updateCopyCredit'];
  const record = rows.filter((r) => recordMethods.includes(r.method));
  if (record.length > 0) {
    items.push({
      kind: 'ext_record_unmatched',
      label: `記録の送信で会員が見つからない（直近 24 時間）・${peopleOf(recordMethods)} 人`,
      count: sum(record),
      since: minSince(record),
      href: searchHref(record[0].method),
      severity: 'yellow',
      details: recordMethods
        .map((m) => ({ m, rs: record.filter((r) => r.method === m) }))
        .filter((x) => x.rs.length > 0)
        .map((x) => ({ label: EXT_ERROR_METHOD_LABELS[x.m] ?? x.m, sub: `${sum(x.rs)} 件`, href: searchHref(x.m) })),
      note: '認証ではない。自動化の処理が始まったあとに送る記録（処理履歴・チケットの消費）で、送られたキーコードの会員が見つからなかった。プラン変更直後の古いキーコードで起きやすい',
    });
  }

  // LINE bot の処理失敗
  const bot = rows.filter((r) => r.method === 'botHandler');
  if (bot.length > 0) {
    const byHandler = new Map<string, number>();
    for (const r of bot) {
      const handler = r.error.split(' / ')[0] || '(不明)';
      byHandler.set(handler, (byHandler.get(handler) ?? 0) + r.n);
    }
    items.push({
      kind: 'bot_handler_failed',
      label: `LINE bot の処理失敗（直近 24 時間）・${peopleOf(['botHandler'])} 人`,
      count: sum(bot),
      since: minSince(bot),
      href: searchHref('botHandler'),
      severity: 'red',
      details: [...byHandler.entries()].sort((a, b) => b[1] - a[1]).map(([h, n]) => ({ label: h, sub: `${n} 件`, href: searchHref(h) })),
      note: '会員に返信が届いていない可能性がある。未返信に残っていないかチャットで確認する',
    });
  }

  // AI チャットの説明書取得失敗
  const howto = rows.filter((r) => r.method === 'aiChatHowto');
  if (howto.length > 0) {
    items.push({
      kind: 'ai_chat_howto_failed',
      label: 'AI チャットの説明書取得失敗（直近 24 時間）',
      count: sum(howto),
      since: minSince(howto),
      href: searchHref('aiChatHowto'),
      severity: 'yellow',
      details: howto.sort((a, b) => b.n - a.n).map((r) => ({ label: r.error.slice(0, 60), sub: `${r.n} 件`, href: searchHref(r.error.slice(0, 40)) })),
      note: 'その間の AI の回答は faq.md だけを根拠にした',
    });
  }

  // 想定外の method（sheet など）が直近に入った場合も黙って消さない
  const known = new Set(['getKeyCodeSet', ...recordMethods, 'botHandler', 'aiChatHowto']);
  const other = rows.filter((r) => !known.has(r.method));
  if (other.length > 0) {
    items.push({
      kind: 'ext_other_records',
      label: 'その他の認証エラーと監視の記録（直近 24 時間）',
      count: sum(other),
      since: minSince(other),
      href: DATA_HREF,
      severity: 'yellow',
      details: [...new Set(other.map((r) => r.method))].map((m) => ({ label: EXT_ERROR_METHOD_LABELS[m] ?? m, sub: `${sum(other.filter((r) => r.method === m))} 件`, href: searchHref(m) })),
    });
  }

  return items;
}
