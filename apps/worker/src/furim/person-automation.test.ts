import { describe, expect, it } from 'vitest';
import { automationSince, describeAutomation, listPersonAutomation } from './person-automation.js';

type Call = { sql: string; binds: unknown[] };

function makeDb(rows: Array<Record<string, unknown>>, total: number) {
  const calls: Call[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind: (...binds: unknown[]) => {
          calls.push({ sql, binds });
          return {
            first: async () => ({ n: total }),
            all: async () => ({ results: rows }),
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, calls };
}

describe('自動化処理履歴の種類と結果（TB-3562）', () => {
  it('値下げの予約実行は「値段変更（-100円）」・予約・対象件数', () => {
    expect(
      describeAutomation({
        options: '{"isReservation":true,"m_changePrice":["-100","円","1500","0"]}',
        payload: '{}',
        total_target_count: '1270',
      }),
    ).toEqual({ kinds: ['値段変更（-100円）'], reservation: true, result: '対象 1270 件' });
  });

  it('サイトの接頭辞を外して同じ名前にする・偽の値は数えない', () => {
    expect(describeAutomation({ options: '{"yf_delete":true,"yf_relist":false}', payload: '{}', total_target_count: '20' }).kinds).toEqual(['削除']);
    expect(describeAutomation({ options: '{"r_bottomPrice":{"bottomPrice":"300"},"ms_deleteComment":{"target":"myComment"}}', payload: '{}', total_target_count: null }).kinds).toEqual(['底値設定', 'コメント削除']);
  });

  it('商品一覧（copy_listing_info_array）は再出品やコピー先があれば種類に出さない', () => {
    expect(describeAutomation({ options: '{"m_copy_listing_info_array":[{"id":"m1"}],"m_relist":true}', payload: '{}', total_target_count: '3' }).kinds).toEqual(['再出品']);
    expect(describeAutomation({ options: '{"m_copyRakumaListing":true,"m_copy_listing_info_array":[]}', payload: '{}', total_target_count: '3' }).kinds).toEqual(['ラクマへコピー出品']);
    expect(describeAutomation({ options: '{"m_copy_listing_info_array":[{"id":"m1"}]}', payload: '{}', total_target_count: '1' }).kinds).toEqual(['コピー出品']);
  });

  it('知らないキーはそのまま出す・件数が無ければ「開始」', () => {
    expect(describeAutomation({ options: '{"m_newThing":true}', payload: '{}', total_target_count: null })).toEqual({ kinds: ['m_newThing'], reservation: false, result: '開始' });
  });

  it('下書きの予約出品は payload の event を結果にする', () => {
    const d = (event: string) => describeAutomation({ options: null, payload: JSON.stringify({ feature: 'draftScheduledListing', event }), total_target_count: null });
    expect(d('listed')).toEqual({ kinds: ['下書きの予約出品'], reservation: false, result: '出品済み' });
    expect(d('scheduled').result).toBe('予約を登録');
    expect(d('skipped').result).toBe('見送り');
  });

  it('壊れた JSON でも落ちない', () => {
    expect(describeAutomation({ options: '{', payload: 'x', total_target_count: '5' })).toEqual({ kinds: [], reservation: false, result: '対象 5 件' });
  });
});

describe('1 人分の自動化処理履歴を直近 N 日で引く（TB-3562）', () => {
  it('起点は JST の N 日前の同じ時刻', () => {
    expect(automationSince(new Date('2026-11-17T08:00:00Z'), 7)).toBe('2026-11-10T17:00:00');
  });

  it('その人の line_user_id と起点で絞り、新しい順・件数と中身を返す（options・payload の原文は返さない）', async () => {
    const { db, calls } = makeDb(
      [
        { id: 'a', created_at: '2026-11-17T17:07:36.720+09:00', service: 'メルカリ', client: 'ext/4.3.9', total_target_count: '49', options: '{"m_changePrice":["-100","円","0","0"]}', payload: '{"keyCode":"pb_x"}' },
      ],
      1,
    );
    const r = await listPersonAutomation(db, 'U1', '2026-11-10T17:00:00', 100);
    expect(r).toEqual({
      total: 1,
      items: [{ id: 'a', created_at: '2026-11-17T17:07:36.720+09:00', service: 'メルカリ', client: 'ext/4.3.9', kinds: ['値段変更（-100円）'], reservation: false, result: '対象 49 件' }],
    });
    expect(calls.every((c) => c.sql.includes('FROM furim_execution_logs') && c.sql.includes('line_user_id = ?'))).toBe(true);
    expect(calls.map((c) => c.binds.slice(0, 2))).toEqual([['U1', '2026-11-10T17:00:00'], ['U1', '2026-11-10T17:00:00']]);
    expect(calls[1].sql).toContain('DESC');
    expect(calls[1].binds[2]).toBe(100);
  });
});
