import { describe, it, expect, vi } from 'vitest';

vi.mock('@line-crm/db', () => ({ jstNow: () => '2026-09-13T12:00:00.000+09:00' }));

const {
  generateTrialKeyCode,
  TRIAL_KEYCODE_PREFIX,
  buildUpsertStatement,
  absorbGasKeyCode,
  deriveGiftStatus,
  resolveStripeCustomerId,
} = await import('./customer-store.js');

type Write = { sql: string; args: unknown[] };

function makeDb(opts: { customer?: Record<string, unknown> | null; friendMeta?: string } = {}) {
  const writes: Write[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            run: async () => { writes.push({ sql, args }); return {}; },
            first: async () => {
              if (/FROM furim_customers WHERE line_user_id/.test(sql)) return opts.customer ?? null;
              if (/SELECT metadata FROM friends/.test(sql)) return opts.friendMeta != null ? { metadata: opts.friendMeta } : null;
              return null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, writes };
}

describe('generateTrialKeyCode', () => {
  it('GAS setKeyCode と同じ形（接頭語 2weektrial_ + 英数小文字 8 文字）', () => {
    for (let i = 0; i < 50; i++) {
      const kc = generateTrialKeyCode();
      expect(kc).toMatch(/^2weektrial_[0-9a-z]{8}$/);
      expect(kc.startsWith(TRIAL_KEYCODE_PREFIX)).toBe(true);
    }
  });
});

describe('buildUpsertStatement', () => {
  it('渡した列だけ ON CONFLICT で上書きする', async () => {
    const { db, writes } = makeDb();
    await buildUpsertStatement(db, 'U1', { key_code: 'pb_x', device_activated: 0 }).run();
    expect(writes).toHaveLength(1);
    expect(writes[0].sql).toContain('INSERT INTO furim_customers (line_user_id, key_code, device_activated, created_at, updated_at)');
    expect(writes[0].sql).toContain('key_code = excluded.key_code');
    expect(writes[0].sql).not.toContain('survey_answer = excluded');
    expect(writes[0].args).toEqual(['U1', 'pb_x', 0, '2026-09-13T12:00:00.000+09:00', '2026-09-13T12:00:00.000+09:00']);
  });

  it('undefined の列は含めない（null は含める）', async () => {
    const { db, writes } = makeDb();
    await buildUpsertStatement(db, 'U1', { key_code: null, survey_answer: undefined }).run();
    expect(writes[0].sql).toContain('(line_user_id, key_code, created_at, updated_at)');
    expect(writes[0].args[1]).toBeNull();
  });
});

describe('absorbGasKeyCode', () => {
  it('keyCode が D1 と異なれば key_code を更新し device_activated=0', async () => {
    const { db, writes } = makeDb({ customer: { key_code: 'old', device_activated: 1 } });
    await absorbGasKeyCode(db, 'U1', { success: true, keyCode: 'pb_new12345' });
    expect(writes).toHaveLength(1);
    expect(writes[0].sql).toContain('key_code = excluded.key_code');
    expect(writes[0].sql).toContain('device_activated = excluded.device_activated');
    expect(writes[0].args.slice(1, 3)).toEqual(['pb_new12345', 0]);
  });

  it('keyCode が同じで keyCodeIssued も無ければ何も書かない', async () => {
    const { db, writes } = makeDb({ customer: { key_code: 'pb_same', device_activated: 1 } });
    await absorbGasKeyCode(db, 'U1', { keyCode: 'pb_same', keyCodeIssued: false });
    expect(writes).toHaveLength(0);
  });

  it('keyCodeIssued=true なら key_code_issued=1・device_activated=0・device_code=NULL', async () => {
    const { db, writes } = makeDb({ customer: { key_code: 'pb_same', device_activated: 1, key_code_issued: 0 } });
    await absorbGasKeyCode(db, 'U1', { keyCode: 'pb_same', keyCodeIssued: true });
    expect(writes).toHaveLength(1);
    expect(writes[0].sql).toContain('(line_user_id, key_code_issued, device_activated, device_code, created_at, updated_at)');
    expect(writes[0].args.slice(1, 4)).toEqual([1, 0, null]);
  });

  it('エラーコード文字列・keyCode 無し・db 無しは無視', async () => {
    const { db, writes } = makeDb({ customer: null });
    await absorbGasKeyCode(db, 'U1', { keyCode: 'エラーコード(401)' });
    await absorbGasKeyCode(db, 'U1', { success: true });
    await absorbGasKeyCode(db, null, { keyCode: 'pb_x' });
    await absorbGasKeyCode(undefined, 'U1', { keyCode: 'pb_x' });
    expect(writes).toHaveLength(0);
  });

  it('D1 の書き込みが落ちても throw しない', async () => {
    const db = {
      prepare() {
        return { bind() { return { run: async () => { throw new Error('boom'); }, first: async () => null }; } };
      },
    } as unknown as D1Database;
    await expect(absorbGasKeyCode(db, 'U1', { keyCode: 'pb_x' })).resolves.toBeUndefined();
  });
});

describe('deriveGiftStatus (GAS getLimitedGiftStatus と同じ派生式)', () => {
  it('行が無ければ全 false', () => {
    expect(Object.values(deriveGiftStatus(null)).every((v) => v === false)).toBe(true);
  });

  it('アンケート「サブアカウント」は未回答扱い・延長KW は 1w/3d のみ true', () => {
    const base = {
      line_user_id: 'U1', stripe_customer_id: null, key_code: 'pb_x', key_code_issued: 1, device_activated: 1,
      survey_answer: 'サブアカウント', free30_ticket: 1, youtube_coupon: ' ', extend_keyword: '対象外',
      sheet_synced_at: null, created_at: '', updated_at: '',
    } as unknown as import('./customer-store.js').FurimCustomer;
    const s = deriveGiftStatus(base);
    expect(s).toEqual({
      hasCompletedSurvey: false,
      hasIssuedKeycode: true,
      hasActivatedKeycode: true,
      hasFree30Ticket: true,
      hasYoutubeCoupon: false,
      hasExtendKeyword: false,
    });
    expect(deriveGiftStatus({ ...base, survey_answer: '紹介', youtube_coupon: 'Furimanです', extend_keyword: '3d' })).toMatchObject({
      hasCompletedSurvey: true,
      hasYoutubeCoupon: true,
      hasExtendKeyword: true,
    });
  });
});

describe('resolveStripeCustomerId', () => {
  it('furim_customers に無ければ friends.metadata.stripeCustomerId にフォールバック', async () => {
    const { db } = makeDb({ customer: { stripe_customer_id: null }, friendMeta: JSON.stringify({ stripeCustomerId: 'cus_meta' }) });
    expect(await resolveStripeCustomerId(db, 'U1')).toBe('cus_meta');
  });

  it('furim_customers を優先する', async () => {
    const { db } = makeDb({ customer: { stripe_customer_id: 'cus_d1' }, friendMeta: JSON.stringify({ stripeCustomerId: 'cus_meta' }) });
    expect(await resolveStripeCustomerId(db, 'U1')).toBe('cus_d1');
  });
});
