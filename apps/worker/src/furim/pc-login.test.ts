import { describe, expect, it } from 'vitest';
import {
  buildPcLoginHref,
  buildRetryLoginUrl,
  fetchFriendFlag,
  notFriendPage,
  pcLoginBlockHtml,
} from './pc-login.js';

describe('buildPcLoginHref', () => {
  it('ref・広告ID・sid を /auth/oauth に引き継ぎ via=pc_qr を付ける', () => {
    const href = buildPcLoginHref(
      'https://w.example',
      { ref: 'org_seo', gclid: 'G1', utm_campaign: 'c', sid: 'old', junk: 'x' },
      'S1',
    );
    const u = new URL(href);
    expect(u.origin + u.pathname).toBe('https://w.example/auth/oauth');
    expect(u.searchParams.get('ref')).toBe('org_seo');
    expect(u.searchParams.get('gclid')).toBe('G1');
    expect(u.searchParams.get('utm_campaign')).toBe('c');
    expect(u.searchParams.get('sid')).toBe('S1');
    expect(u.searchParams.get('via')).toBe('pc_qr');
    expect(u.searchParams.has('junk')).toBe(false);
  });

  it('xh: の ref は URL に出さない', () => {
    const u = new URL(buildPcLoginHref('https://w.example', { ref: 'xh:secret' }, 'S1'));
    expect(u.searchParams.has('ref')).toBe(false);
  });

  it('WORKER_PUBLIC_URL が無ければ相対パス', () => {
    expect(buildPcLoginHref(undefined, {}, '')).toBe('/auth/oauth?via=pc_qr');
  });
});

describe('pcLoginBlockHtml', () => {
  it('ボタンの href を属性用にエスケープし data-gate を持つ', () => {
    const html = pcLoginBlockHtml('/auth/oauth?a=1&b="2"');
    expect(html).toContain('href="/auth/oauth?a=1&amp;b=&quot;2&quot;"');
    expect(html).toContain('data-gate="pc_login"');
    expect(html).toContain('このパソコンで LINE にログイン');
  });
});

describe('fetchFriendFlag', () => {
  const res = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('friendFlag をそのまま返す', async () => {
    expect(await fetchFriendFlag('t', res(200, { friendFlag: true }))).toBe(true);
    expect(await fetchFriendFlag('t', res(200, { friendFlag: false }))).toBe(false);
  });

  it('聞けなかったときは null', async () => {
    expect(await fetchFriendFlag('t', res(401, { message: 'x' }))).toBeNull();
    expect(await fetchFriendFlag('t', res(200, {}))).toBeNull();
    const boom = (async () => { throw new Error('net'); }) as unknown as typeof fetch;
    expect(await fetchFriendFlag('t', boom)).toBeNull();
  });
});

describe('buildRetryLoginUrl', () => {
  it('同じ state で同意画面を出し直す', () => {
    const u = new URL(buildRetryLoginUrl({ channelId: '123', callbackUrl: 'https://w.example/auth/callback', state: 'STATE' }));
    expect(u.searchParams.get('client_id')).toBe('123');
    expect(u.searchParams.get('bot_prompt')).toBe('aggressive');
    expect(u.searchParams.get('prompt')).toBe('consent');
    expect(u.searchParams.get('state')).toBe('STATE');
    expect(u.searchParams.get('redirect_uri')).toBe('https://w.example/auth/callback');
  });
});

describe('notFriendPage', () => {
  it('友だち追加を飛ばした人とやめた人で文を分ける', () => {
    expect(notFriendPage('https://x', 'not_friend')).toContain('友だち追加がまだです');
    expect(notFriendPage('https://x', 'canceled')).toContain('途中で止まりました');
  });
});
