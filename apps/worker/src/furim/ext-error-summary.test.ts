import { describe, expect, it } from 'vitest';
import { summarizeExtErrors } from './ext-error-summary.js';

type Row = { method: string; error: string; n: number; people: number; since: string | null };

function makeDb(rows: Row[]) {
  const sqls: string[] = [];
  const db = {
    prepare(sql: string) {
      sqls.push(sql);
      return {
        bind: () => ({
          all: async () => {
            if (/GROUP BY method, error/.test(sql)) return { results: rows };
            const byMethod = new Map<string, number>();
            for (const r of rows) byMethod.set(r.method, (byMethod.get(r.method) ?? 0) + r.people);
            return { results: [...byMethod.entries()].map(([method, people]) => ({ method, people })) };
          },
        }),
      };
    },
  } as unknown as D1Database;
  return { db, sqls };
}

const at = '2026-09-17T10:00:00.000+09:00';

describe('トップの異常区画: 認証エラーと監視の記録を種類で分ける（2026-09-17）', () => {
  it('仕組みどおり（有効期限切れ・無料期間終了・プランキャンセル済み）だけなら出さない', async () => {
    const { db } = makeDb([
      { method: 'getKeyCodeSet', error: '有効期限切れ', n: 3, people: 2, since: at },
      { method: 'getKeyCodeSet', error: '無料期間終了', n: 1, people: 1, since: at },
    ]);
    expect(await summarizeExtErrors(db, '2026-09-16T10:00:00')).toEqual([]);
  });

  it('キーコード認証は理由ごとの内訳を日本語で出し、仕組みどおりの理由は後ろに注記付きで並べる', async () => {
    const { db } = makeDb([
      { method: 'getKeyCodeSet', error: '有効期限切れ', n: 4, people: 2, since: at },
      { method: 'getKeyCodeSet', error: '該当レコードなし', n: 2, people: 1, since: at },
      { method: 'getKeyCodeSet', error: '端末判定文字列が一致しないので不正利用', n: 3, people: 1, since: at },
    ]);
    const [item] = await summarizeExtErrors(db, '2026-09-16T10:00:00');
    expect(item.kind).toBe('ext_auth_rejected');
    expect(item.label).toBe('キーコード認証で弾かれた（直近 24 時間）・4 人');
    expect(item.count).toBe(9);
    expect(item.severity).toBe('yellow');
    expect(item.details.map((d) => d.label)).toEqual([
      '別の端末で使用中（キーコードリセットで解消）',
      'キーコードが見つからない（打ち間違い・古いキーコード・解約で消えた）',
      '有効期限切れ',
    ]);
    expect(item.details[2].sub).toBe('4 件・2 人・仕組みどおり');
    expect(item.note).toContain('自動化を始める前の自動チェック');
  });

  it('処理履歴の送信は「認証ではない」別の項目にする', async () => {
    const { db } = makeDb([{ method: 'stackExecutionData', error: '該当レコードなし', n: 3, people: 1, since: at }]);
    const [item] = await summarizeExtErrors(db, '2026-09-16T10:00:00');
    expect(item.kind).toBe('ext_record_unmatched');
    expect(item.details).toEqual([{ label: '処理履歴の送信', sub: '3 件', href: '/data/table?name=furim_ext_errors&q=stackExecutionData' }]);
    expect(item.note).toContain('認証ではない');
  });

  it('Worker 側: bot の処理失敗は赤でハンドラー別、AI チャットの説明書取得失敗は黄', async () => {
    const { db } = makeDb([
      { method: 'botHandler', error: 'handleFurimAction:限定特典GET / handler / Firebase 503', n: 2, people: 2, since: at },
      { method: 'aiChatHowto', error: 'howto fetch 503', n: 1, people: 0, since: at },
    ]);
    const items = await summarizeExtErrors(db, '2026-09-16T10:00:00');
    const bot = items.find((i) => i.kind === 'bot_handler_failed')!;
    expect(bot.severity).toBe('red');
    expect(bot.details[0]).toMatchObject({ label: 'handleFurimAction:限定特典GET', sub: '2 件' });
    expect(items.find((i) => i.kind === 'ai_chat_howto_failed')!.severity).toBe('yellow');
  });

  it('巡回キューの取りこぼし（collectSkip）は専用の項目にだけ出すので、ここでは SQL で除く', async () => {
    const { db, sqls } = makeDb([]);
    await summarizeExtErrors(db, '2026-09-16T10:00:00');
    expect(sqls.every((q) => q.includes("method <> 'collectSkip'"))).toBe(true);
  });
});
