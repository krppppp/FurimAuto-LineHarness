// 更新 7 日前の全機能開放（TB-1009 / TB-25・2026-10-05）。
//
// 下位プラン（PB 有料・premium 以外）の会員に、サブスク更新日の 7 日前から更新日まで trial パッケージ相当を開ける。
// - furim_feature_flags は書き換えない。furim_renewal_unlocks に期限付きで記録し、ext-auth が読むときだけ上乗せする
//   （30 分のシート取り込み・更新日の applyPlanBuilderSync と取り合わない。キーコードの再発行もしない）
// - 1 人につき更新 1 回ぶんに 1 回（cycle の UNIQUE）。試用・premium・解約予約（Stripe で確認）は対象外
// - 案内は 3 通: 開放時（7 日前）・4 日前・前日。送るのは 9〜23 時 JST だけ
// - cron は env.FURIM_RENEWAL_UNLOCK === 'on' のときだけ動く（本番は文面の OK が出るまで off のまま）
// - env.FURIM_RENEWAL_UNLOCK_EXCLUDE_SUBS（subscription_id のカンマ区切り）の人には開けず、案内も送らない
//   （TB-1014: 二重課金の 2 名を Stripe で修正が効いたと確かめるまで外す）
import { expandFeatureSet, loadFurimMaster } from './feature-flags.js';
import { formatJstDateTime, formatJstIso, parseJstDateTime, TRIAL_KEYCODE_PREFIX } from './customer-store.js';
import { invalidateExtCache, type ExtCache } from './ext-auth.js';
import { isJstMinuteWindow } from './cron-window.js';

const DAY_MS = 24 * 60 * 60_000;
// subscription_end_at は更新日時 +24h のバッファ込み（stripe-processor）
const END_BUFFER_MS = DAY_MS;
export const UNLOCK_LEAD_DAYS = 7;
const MSG2_LEAD_DAYS = 4;
const MSG3_LEAD_DAYS = 1;
// 残りがこれより短い人には開けない（案内が届く前に戻ってしまうため）
const MIN_GRANT_LEAD_MS = 2 * DAY_MS;
const MAX_GRANTS_PER_RUN = 10;
const SEND_HOURS = { from: 9, to: 23 };
const PROD_PLAN_BUILDER_LIFF_URL = 'https://liff.line.me/1660804123-ZfTZnrBV';

export type RenewalUnlockEnv = {
  FURIM_RENEWAL_UNLOCK?: string;
  STRIPE_SECRET_KEY?: string;
  PLAN_BUILDER_LIFF_URL?: string;
  FURIM_RENEWAL_UNLOCK_EXCLUDE_SUBS?: string;
};

type LineClientLike = { pushMessage(to: string, messages: unknown[]): Promise<unknown> };

export type UnlockCandidate = {
  line_user_id: string;
  subscription_id: string | null;
  subscription_end_at: string | null;
  packages: string | null;
  key_code: string | null;
  plan_label: string | null;
};

type UnlockRow = {
  id: string;
  line_user_id: string;
  cycle: string;
  until_ms: number;
  granted_at: string;
  msg1_sent_at: string | null;
  msg2_sent_at: string | null;
  msg3_sent_at: string | null;
};

export function jstHour(nowMs: number): number {
  return new Date(nowMs + 9 * 60 * 60_000).getUTCHours();
}

export function isSendHour(nowMs: number): boolean {
  const h = jstHour(nowMs);
  return h >= SEND_HOURS.from && h < SEND_HOURS.to;
}

/** 更新日時（subscription_end_at − 24h）。読めなければ null */
export function renewalAtMs(subscriptionEndAt: string | null | undefined): number | null {
  const end = parseJstDateTime(subscriptionEndAt);
  return end == null ? null : end - END_BUFFER_MS;
}

export function cycleKey(subscriptionId: string, renewalMs: number): string {
  return `${subscriptionId}:${formatJstDateTime(renewalMs).slice(0, 10)}`;
}

/** 下位プランの有料会員か（D1 だけで分かる部分。解約予約は Stripe で別に見る） */
export function isEligibleCustomer(c: UnlockCandidate): boolean {
  const pkgs = String(c.packages ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (pkgs.length === 0) return false;
  if (pkgs.includes('premium') || pkgs.includes('trial')) return false;
  if (!c.subscription_id) return false;
  if (!String(c.plan_label ?? '').startsWith('PBプラン:')) return false;
  if (String(c.key_code ?? '').startsWith(TRIAL_KEYCODE_PREFIX)) return false;
  return true;
}

/** 開放の窓（更新 7 日前〜2 日前）に入っているか */
export function isInGrantWindow(renewalMs: number, nowMs: number): boolean {
  const lead = renewalMs - nowMs;
  return lead <= UNLOCK_LEAD_DAYS * DAY_MS && lead > MIN_GRANT_LEAD_MS;
}

/** 上乗せするフラグ（trial パッケージを展開した値。'1' か AutoMultiChannel の巡回サイト文字列） */
export function unlockFlagsFromMaster(master: Awaited<ReturnType<typeof loadFurimMaster>>): Record<string, string> {
  const set = expandFeatureSet(master, { packages: 'trial', features: '', multiChannelSites: '' });
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(set)) out[k] = v === true ? '1' : String(v);
  return out;
}

/** 契約のフラグに開放ぶんを重ねる。開放側が OFF にすることはない */
export function overlayUnlockFlags(flags: Record<string, string>, unlock: Record<string, string>): Record<string, string> {
  const out = { ...flags };
  for (const [k, v] of Object.entries(unlock)) {
    if (!v || v === '0') continue;
    out[k] = v;
  }
  return out;
}

/** 期限内の開放があれば、そのフラグを返す（ext-auth から呼ぶ） */
export async function loadActiveUnlockFlags(db: D1Database, lineUserId: string, nowMs = Date.now()): Promise<Record<string, string> | null> {
  try {
    const row = await db
      .prepare('SELECT flags FROM furim_renewal_unlocks WHERE line_user_id = ? AND until_ms > ? ORDER BY until_ms DESC LIMIT 1')
      .bind(lineUserId, nowMs)
      .first<{ flags: string }>();
    if (!row) return null;
    return JSON.parse(row.flags) as Record<string, string>;
  } catch (e) {
    console.warn('[furim/renewal-unlock] load failed (no overlay):', String(e));
    return null;
  }
}

type StripeSubCheck = { ok: true } | { ok: false; reason: string };

async function checkStripeSubscription(env: RenewalUnlockEnv, subscriptionId: string): Promise<StripeSubCheck> {
  if (!env.STRIPE_SECRET_KEY) return { ok: false, reason: 'noStripeKey' };
  const res = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (!res.ok) return { ok: false, reason: `stripe${res.status}` };
  const sub = (await res.json()) as { status?: string; cancel_at_period_end?: boolean; cancel_at?: number | null };
  if (sub.status !== 'active') return { ok: false, reason: `status:${sub.status}` };
  if (sub.cancel_at_period_end || sub.cancel_at) return { ok: false, reason: 'cancelScheduled' };
  return { ok: true };
}

export function excludedSubscriptions(env: RenewalUnlockEnv): Set<string> {
  return new Set(String(env.FURIM_RENEWAL_UNLOCK_EXCLUDE_SUBS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

function planBuilderUrl(env: RenewalUnlockEnv): string {
  return env.PLAN_BUILDER_LIFF_URL || PROD_PLAN_BUILDER_LIFF_URL;
}

/** 'M/D'（JST） */
function monthDay(ms: number): string {
  const s = formatJstDateTime(ms);
  return `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;
}

// 文面は案（TB-25 でくろさんの OK をもらってから本番で動かす）。数字は誇張しない
export function renewalUnlockMessages(stage: 1 | 2 | 3, untilMs: number, env: RenewalUnlockEnv): Array<{ type: 'text'; text: string }> {
  const until = monthDay(untilMs);
  if (stage === 1) {
    return [{
      type: 'text',
      text:
        `更新日の前の1週間限定でFurimAuto内の全機能を開放させていただきました！\n` +
        `この機会にメルカリの全自動化の体験に加え\n` +
        `・メルカリだけでない多販路での自動化\n` +
        `・在庫管理シートを使った自動在庫管理\n` +
        `も体験してみてください！\n\n` +
        `キーコードの認証ボタンを一度クリックすることでご利用可能です。\n\n` +
        `年末年始に向けてイベントが続く間が商戦です。\n` +
        `今のうちから先取って先取って、アカウントのレベルアップに役立ててください。`,
    }];
  }
  if (stage === 2) {
    return [{
      type: 'text',
      text:
        `全プラットフォーム全機能の開放は${until}までです！\n\n` +
        `多販路販売は売上UPが唯一の目的ではありません。\n\n` +
        `去年と同じようにメルカリの利用規約が発生したら？\n` +
        `アルゴリズムがガラッと変わったら？\n\n` +
        `強いアカウントを各サイトで並行して作っていくリスクヘッジを先回りして行っておくことが事業の鉄則です。\n\n` +
        `また、販路ごとにポイント還元やクーポンの時期が違うので、\n` +
        `その時期に合わせてコメントセールでオファーを出す。\n\n` +
        `広告費もいらない、SEOを考えてコンテンツを作る必要がない。\n` +
        `一般的な事業を運営するより楽に稼げる場所を大手企業が作ってれてるのですから、いろんな所に跨りましょう。\n` +
        `先行者が先を行ける単純な業界です。\n\n` +
        `同じ商品を複数の販路に出しておくと、売れる場所が増えます。\n` +
        `FurimAutoはどこかで1つ売れたら、それを検知して他の販路の出品は自動で取り下げます。\n\n` +
        `売り越しの心配や、手で消して回る手間はありません。\n` +
        `オンラインで済むことは全て自動化できています！`,
    }];
  }
  return [{
    type: 'text',
    text:
      `全機能の開放は明日（${until}）で終わりです。\n\n` +
      `便利だな、作業が減ったなと実感できた機能があれば、\n` +
      `こちらから追加できます！\n${planBuilderUrl(env)}`,
  }];
}

export type RenewalUnlockResult = {
  skipped?: 'disabled' | 'outsideHours';
  granted: string[];
  rejected: Array<{ lineUserId: string; reason: string }>;
  sent: Array<{ lineUserId: string; stage: number }>;
  dryRun: boolean;
};

/**
 * 5 分 cron から呼ぶ。開放（窓に入った人）→ 案内の送信（段階ごと）の順。
 * onlyLineUserId: 手動実行で 1 人だけ対象にする。skipStripeCheck: dev の確認用（実在しない subscription で試すとき）。
 * push=false: 開放だけして送らない
 */
export async function runRenewalUnlock(
  db: D1Database,
  lineClient: LineClientLike | null,
  kv: ExtCache | undefined,
  env: RenewalUnlockEnv,
  opts: { nowMs?: number; manual?: boolean; dryRun?: boolean; onlyLineUserId?: string; skipStripeCheck?: boolean; push?: boolean } = {},
): Promise<RenewalUnlockResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const dryRun = !!opts.dryRun;
  const result: RenewalUnlockResult = { granted: [], rejected: [], sent: [], dryRun };
  if (!opts.manual && env.FURIM_RENEWAL_UNLOCK !== 'on') return { ...result, skipped: 'disabled' };
  if (!isSendHour(nowMs)) return { ...result, skipped: 'outsideHours' };

  // 1. 開放（cron は毎時 :00 の tick だけ。解約予約の人を 5 分ごとに Stripe へ聞き直さない）
  if (opts.manual || isJstMinuteWindow(nowMs, 0)) await grantUnlocks(db, kv, env, nowMs, opts, result);

  // 2. 案内（期限内の開放ごとに、届いていない段階を 1 通だけ）
  if (opts.push === false || dryRun || !lineClient) return result;
  const rowsStmt = db.prepare(
    `SELECT id, line_user_id, cycle, until_ms, granted_at, msg1_sent_at, msg2_sent_at, msg3_sent_at FROM furim_renewal_unlocks
     WHERE until_ms > ? AND (msg1_sent_at IS NULL OR msg2_sent_at IS NULL OR msg3_sent_at IS NULL)${opts.onlyLineUserId ? ' AND line_user_id = ?' : ''}`,
  );
  const rows = await (opts.onlyLineUserId ? rowsStmt.bind(nowMs, opts.onlyLineUserId) : rowsStmt.bind(nowMs)).all<UnlockRow>();
  const excluded = excludedSubscriptions(env);
  for (const r of rows.results ?? []) {
    if (excluded.has(r.cycle.split(':')[0])) continue;
    const stage = nextStage(r, nowMs);
    if (!stage) continue;
    const col = `msg${stage}_sent_at`;
    // 先に枠を取る（cron が重なっても 2 通送らない）
    const claim = await db.prepare(`UPDATE furim_renewal_unlocks SET ${col} = ? WHERE id = ? AND ${col} IS NULL`).bind(formatJstIso(nowMs), r.id).run();
    if (!claim.meta?.changes) continue;
    const messages = renewalUnlockMessages(stage, r.until_ms, env);
    try {
      await lineClient.pushMessage(r.line_user_id, messages);
      result.sent.push({ lineUserId: r.line_user_id, stage });
      await logPush(db, r.line_user_id, messages[0].text, nowMs);
    } catch (err) {
      // ブロック等。再送はしない（印は 'error:' で残す）
      await db.prepare(`UPDATE furim_renewal_unlocks SET ${col} = ? WHERE id = ?`).bind(`error:${formatJstIso(nowMs)}`, r.id).run();
      console.error('[furim/renewal-unlock] push failed', r.line_user_id, stage, String(err));
    }
  }
  return result;
}

async function grantUnlocks(
  db: D1Database,
  kv: ExtCache | undefined,
  env: RenewalUnlockEnv,
  nowMs: number,
  opts: { dryRun?: boolean; onlyLineUserId?: string; skipStripeCheck?: boolean },
  result: RenewalUnlockResult,
): Promise<void> {
  const dryRun = !!opts.dryRun;
  const where = opts.onlyLineUserId ? 'WHERE line_user_id = ?' : "WHERE subscription_source = 'plan-builder' AND subscription_id IS NOT NULL";
  const stmt = db.prepare(`SELECT line_user_id, subscription_id, subscription_end_at, packages, key_code, plan_label FROM furim_customers ${where}`);
  const candidates = await (opts.onlyLineUserId ? stmt.bind(opts.onlyLineUserId) : stmt).all<UnlockCandidate>();
  let unlockFlags: Record<string, string> | null = null;
  const excluded = excludedSubscriptions(env);
  for (const c of candidates.results ?? []) {
    if (result.granted.length >= MAX_GRANTS_PER_RUN) break;
    if (!isEligibleCustomer(c)) {
      if (opts.onlyLineUserId) result.rejected.push({ lineUserId: c.line_user_id, reason: 'notEligible' });
      continue;
    }
    if (excluded.has(c.subscription_id!)) {
      result.rejected.push({ lineUserId: c.line_user_id, reason: 'excluded' });
      continue;
    }
    const renewalMs = renewalAtMs(c.subscription_end_at);
    if (renewalMs == null || !isInGrantWindow(renewalMs, nowMs)) {
      if (opts.onlyLineUserId) result.rejected.push({ lineUserId: c.line_user_id, reason: 'outsideWindow' });
      continue;
    }
    const cycle = cycleKey(c.subscription_id!, renewalMs);
    const exists = await db.prepare('SELECT 1 FROM furim_renewal_unlocks WHERE line_user_id = ? AND cycle = ?').bind(c.line_user_id, cycle).first();
    if (exists) continue;
    if (!opts.skipStripeCheck) {
      const check = await checkStripeSubscription(env, c.subscription_id!);
      if (!check.ok) {
        result.rejected.push({ lineUserId: c.line_user_id, reason: check.reason });
        continue;
      }
    }
    if (dryRun) {
      result.granted.push(c.line_user_id);
      continue;
    }
    unlockFlags ??= unlockFlagsFromMaster(await loadFurimMaster(db));
    const ins = await db
      .prepare(
        `INSERT OR IGNORE INTO furim_renewal_unlocks (id, line_user_id, cycle, until_ms, until_at, flags, packages, granted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), c.line_user_id, cycle, renewalMs, formatJstIso(renewalMs), JSON.stringify(unlockFlags), c.packages ?? null, formatJstIso(nowMs))
      .run();
    if (!ins.meta?.changes) continue;
    await invalidateExtCache(kv, c.key_code);
    result.granted.push(c.line_user_id);
    console.log('[furim/renewal-unlock] granted', JSON.stringify({ lineUserId: c.line_user_id, cycle, until: formatJstDateTime(renewalMs) }));
  }
}

/** 次に送る段階。1 通目が済んでから 4 日前・前日。開放直後に 2 通目が重ならないよう 1 通目から 1 日空ける */
export function nextStage(r: Pick<UnlockRow, 'until_ms' | 'msg1_sent_at' | 'msg2_sent_at' | 'msg3_sent_at'>, nowMs: number): 1 | 2 | 3 | null {
  const lead = r.until_ms - nowMs;
  if (lead <= 0) return null;
  if (!r.msg1_sent_at) return 1;
  const msg1Ms = parseJstDateTime(r.msg1_sent_at.replace(/^error:/, ''));
  if (lead <= MSG3_LEAD_DAYS * DAY_MS) return r.msg3_sent_at ? null : 3;
  if (lead <= MSG2_LEAD_DAYS * DAY_MS && !r.msg2_sent_at && msg1Ms != null && nowMs - msg1Ms >= DAY_MS) return 2;
  return null;
}

async function logPush(db: D1Database, lineUserId: string, text: string, nowMs: number): Promise<void> {
  try {
    const friend = await db.prepare('SELECT id FROM friends WHERE line_user_id = ?').bind(lineUserId).first<{ id: string }>();
    if (!friend) return;
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, created_at)
         VALUES (?, ?, 'outgoing', 'text', ?, NULL, NULL, 'push', 'renewal-unlock', ?)`,
      )
      .bind(crypto.randomUUID(), friend.id, text, formatJstIso(nowMs))
      .run();
  } catch (err) {
    console.error('[furim/renewal-unlock] messages_log insert failed', lineUserId, err);
  }
}
