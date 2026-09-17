// ステップ配信のセグメント判定とクロージング配信対象を D1 furim_customers から出す
// （GAS listSegments / listActiveTrials / sendStepMessages の置き換え・Capsec #250・2026-09-14）。
// 判定式は GAS sheetHelper.getSegment と同じ（列 → D1 の対応: アンケート回答=survey_answer・初回発行=key_code_issued・
// 端末判定文字列=device_code(または device_activated)・メルカリURL=mercari_url・Free30=free30_ticket・Youtube=youtube_coupon・延長KW=extend_keyword）
import { parseJstDateTime, type FurimCustomer } from './customer-store.js';

// 検証用アカウント（テストのたびに新規の友だちに作り直すもの・Capsec #301 統括決定 2026-09-17）。
// 数字の集計（トップのダッシュボード・自動化の区画・有料転換）、広告のオフライン CV 送信、シートと D1 の突き合わせから除く。
// クロージング配信の除外（下の EXCLUDED_LINE_IDS）には入れない（配信の検証ができなくなるため）。
// 2026-09-17 16:07 にあじゃぱーの実機テストが広告の成果として Google に送られた（#305 で取り消し）
export const TEST_LINE_IDS: ReadonlySet<string> = new Set([
  'Ue4941a030cb2ec8758095fb0fffff344', // あじゃぱー（くろさんの検証用・reset-test-friend の既定）
]);

// 社内・検証用アカウント（GAS separateLineIdsBySituation.js の EXCLUDED_LINE_IDS の写し）。クロージング配信から除外する
export const EXCLUDED_LINE_IDS: ReadonlySet<string> = new Set([
  'Uf467cf4dbd2e89a98b18b1858badb910', 'U3ad68664c60716e18bd4d28e8e74fa79', 'U965a787efd9095b0d0c3078076040ff3', 'Ucb5fd3373546b708bb2a15d6d3126aa3',
  'U295e62aee7b071d09b7bc1e56604b5f7', 'Uc3c84d1e03e7a694f19db35a83c97de2', 'U0fd6c60ac3d927c6dcbcdf4c3478475d', 'U43165193c4eed74e388c2adc07762059',
  'U0358ed5cff39276184148a0c1624c123', 'Ufa5a7b20dbaeffc57c6387ca0388857b', 'U1a1dae0b623db06bee91183c74f7070e', 'U6e64118d088e12abcb007aefa45e3ec6',
  'U81cd16b2b370e1614b32ffb737517e9a', 'U3fd69c35b116f6d330fd26eef1e6eeaf', 'U94e5d7d55d17b5e0a084fa951db04e88', 'Uae18e70e6fb07a34311eabba3f4a8705',
  'Ub8e0297ec8ece8e12f9723f6f35b6ad7', 'Uc9d99448628c77f1225ff473935aa68c', 'U3af076219d25bdd35b21385b63f356a6', 'Ubb78b67fbd5d1edfdc5e7e904dff4887',
  'Uecdaaccf5b65aad7ea744652c3d9155e', 'U41fb75774dbf2cfadb7ebbad1a25ec7f', 'U41fb29d3c2d42f6cabc7f20415eb44ce', 'U5fe66e3ff43419a1a9c960f0d1ada3f2',
  'U5e7b239cf3fa0910b8e107cfe36ef6cf', 'U06f7fbadabd11ca1db2444568e0dfa98', 'Ud937dccc23f391dc6a063bf9e141ec94', 'U6fe322c11d10e2c1241872374d62e0c4',
  'Uce1e4f8508fd6e80fceedb9a5335d883', 'U57dfb20d8a35b57c38808194859f4bd5', 'U6cd9a00e793a3dadbff4837c998e6109', 'U2530a77957990d1232f980c20d146dee',
  'U871f23eabf01b192db4e508711517bed', 'Ud6847ad4ebabcfb611654c4a517977f6', 'Ua5740829bd31449bcca3aee01cb783e3', 'Uc14cf4457138016c2824ab9ff7985a19',
  'Ua0fa79607d72374ca2c6fe1cfca9bf43', 'U52174d60e0c47ff3c37afbadc4a377a1', 'U19ea5e826ba7e340f6a3b81e1314c57e', 'U98ccb61161579726f3bab50abbecbeb0',
  'Uc3c118ed8022213c6c10e52dba7a7557', 'Ua8802655047d4b4a5500c21ccbe04afd', 'U19f791884108dd8654ea170524497fb5', 'Ua415438dd99047be3eb930732cf23d68',
  'U7c9c0ae827bd5b40f013b99c2b49567e', 'U6492edd38a5b9523a3e337496e09fce9', 'U9e4554016a4854174e501878ec1ea9ea', 'U94690e5d92e3511aebb642fc5f7cf300',
  'Uae518fba76e93e35550db9b532b48fd8', 'Uc495e528b2036619bb28b1b83b46080d', 'Uc55e8ae3d0609e1cc263379548933337', 'Uc06ee4cc6acd18668ffc7f5b71893e93',
  'U314ec0b655e335366d85baa0673416c5', 'Ubd851efde9fb151bc7565602781cc49d', 'Ua143db76848734ef13811520209cbb13', 'U75bb6e782f0fa00761fd29932a117e66',
  'Ufc41787b62e0b067d7771fb6a17b02bc', 'U8308f7ac94e74e1c7450f9319a99e322', 'U15389944acd1d5856a46982befc7edf7', 'U8a3f84f8373334595f6ac82f9ae13319',
  'Uf27767ab3b641aa9295907e9aa540580', 'Ucf3e2789753989248b272e5a18215ee8', 'Ubb408b43759e3c7370e53e2c33a79f03', 'Ub796f7e6c34911a0c7d8773569a9fd92',
]);

const DAY_MS = 24 * 60 * 60_000;

type SegmentSource = Pick<FurimCustomer, 'survey_answer' | 'key_code_issued' | 'device_activated' | 'device_code' | 'mercari_url' | 'free30_ticket' | 'youtube_coupon' | 'extend_keyword'>;

/** GAS getSegment と同じ判定。サブアカウントは null */
export function segmentOf(c: SegmentSource): number | null {
  const survey = (c.survey_answer ?? '').trim();
  if (survey === 'サブアカウント') return null;
  const answered = survey !== '';
  const issued = c.key_code_issued === 1;
  const device = !!(c.device_code ?? '').trim() || c.device_activated === 1;
  const mercari = !!(c.mercari_url ?? '').trim();
  const free30 = c.free30_ticket === 1;
  const youtube = (c.youtube_coupon ?? '').trim() !== '';
  const extend = (c.extend_keyword ?? '').trim() !== '';
  if (!answered && !issued) return 1;
  if (answered && !issued) return 2;
  if (issued && !device) return 3;
  if (device && !mercari) return 4;
  if (device && mercari && free30 && youtube && extend) return 8;
  if (device && mercari && free30 && youtube) return 7;
  if (device && mercari && free30) return 6;
  if (device && mercari) return 5;
  return null;
}

export type SegmentUser = { lineUserId: string; segment: number; isReferral: boolean };

/** ステップ配信対象（登録 0〜21 日・プラン名に「プラン」を含まない）の現在セグメント（GAS listSegments と同じ絞り込み） */
export async function listSegmentsFromD1(db: D1Database, nowMs = Date.now()): Promise<SegmentUser[]> {
  const rows = await db.prepare('SELECT * FROM furim_customers WHERE subscription_start_at IS NOT NULL').all<FurimCustomer>();
  const users: SegmentUser[] = [];
  for (const c of rows.results ?? []) {
    if (!c.line_user_id) continue;
    if ((c.plan_label ?? '').includes('プラン')) continue;
    const start = parseJstDateTime(c.subscription_start_at);
    if (start == null) continue;
    const daysPassed = Math.floor((nowMs - start) / DAY_MS);
    if (daysPassed < 0 || daysPassed > 21) continue;
    const segment = segmentOf(c);
    if (segment === null) continue;
    const end = parseJstDateTime(c.subscription_end_at);
    const isReferral = end != null && end - start >= 21 * DAY_MS;
    users.push({ lineUserId: c.line_user_id, segment, isReferral });
  }
  return users;
}

export type ActiveTrial = { lineUserId: string; trialEnd: string; remainingDays: number };

/** JST の日付通し番号（日単位の差を取るため） */
function jstDayIndex(ms: number): number {
  return Math.floor((ms + 9 * 60 * 60_000) / DAY_MS);
}

function jstDateString(ms: number): string {
  return new Date(ms + 9 * 60 * 60_000).toISOString().slice(0, 10);
}

/** 無料試用中（プラン名が空）で終了が今日〜windowDays 日後の顧客（GAS listActiveTrials と同じ） */
export async function listActiveTrialsFromD1(db: D1Database, opts: { windowDays?: number; nowMs?: number } = {}): Promise<ActiveTrial[]> {
  const windowDays = opts.windowDays ?? 8;
  const nowMs = opts.nowMs ?? Date.now();
  const today = jstDayIndex(nowMs);
  const rows = await db
    .prepare("SELECT line_user_id, plan_label, subscription_end_at FROM furim_customers WHERE subscription_end_at IS NOT NULL AND (plan_label IS NULL OR TRIM(plan_label) = '')")
    .all<{ line_user_id: string; plan_label: string | null; subscription_end_at: string }>();
  const trials: ActiveTrial[] = [];
  for (const r of rows.results ?? []) {
    if (!r.line_user_id || EXCLUDED_LINE_IDS.has(r.line_user_id)) continue;
    const end = parseJstDateTime(r.subscription_end_at);
    if (end == null) continue;
    const remaining = jstDayIndex(end) - today;
    if (remaining < 0 || remaining > windowDays) continue;
    trials.push({ lineUserId: r.line_user_id, trialEnd: jstDateString(end), remainingDays: remaining });
  }
  return trials;
}
