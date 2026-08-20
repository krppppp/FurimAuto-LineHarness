import { sendPushToAll, type PushEnv } from './push-notify.js';

/**
 * LIFF ID の環境取り違え検知 (FurimAuto fork 独自)。
 *
 * 2026-07-20 と 2026-08-18 に、prod ビルドへ DEV の LIFF ID が焼かれて
 * 「Invalid LIFF ID」となり、モバイルからの友だち追加が全経路で停止した。
 * 8/18 の事故は丸2日気づかれず（広告費を出しながら受け皿が死んでいた）、
 * くろさんが自分でリンクを踏むまで誰も検知できなかった。
 *
 * 友だち追加は「案内する URL (env.LIFF_URL)」と「その先で動くフロントに焼かれた
 * LIFF ID (VITE_LIFF_ID)」が一致して初めて成立する。ビルド時のガード
 * (vite.config.ts) は手順ミスを止めるが、secret 側だけ差し替わった場合は
 * 素通りするため、稼働中の worker 自身にも突き合わせをさせる。
 *
 * 検査はビルドへ焼かれた定数と env の文字列比較のみで、外部通信は無い。
 */

export type LiffHealthEnv = PushEnv & { LIFF_URL?: string };

/** env.LIFF_URL (https://liff.line.me/xxxx-yyyy) から LIFF ID を取り出す */
function extractLiffId(liffUrl: string): string {
  return liffUrl.split('?')[0].replace(/\/+$/, '').split('/').pop() ?? '';
}

export async function checkLiffIdConsistency(
  db: D1Database,
  env: LiffHealthEnv,
  opts: { notify?: boolean } = {},
): Promise<'ok' | 'mismatch' | 'skipped'> {
  // worker の tsconfig には vite/client の型が無いので実体だけ取り出す。
  // ビルド時に define / Vite の env 置換で literal になる。
  const bakedLiffId = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
    ?.VITE_LIFF_ID;
  if (!env.LIFF_URL || !bakedLiffId) return 'skipped';

  const servedLiffId = extractLiffId(env.LIFF_URL);
  if (servedLiffId === bakedLiffId) return 'ok';

  console.error(
    `[liff-health] LIFF ID MISMATCH: LIFF_URL=${servedLiffId} but bundle has ${bakedLiffId}. ` +
      '友だち追加が「Invalid LIFF ID」で全断している可能性があります。',
  );

  if (opts.notify) {
    try {
      await sendPushToAll(db, env, {
        title: '🚨 友だち追加が停止している可能性',
        body: `LIFF IDが不一致です（案内先: ${servedLiffId} / アプリ: ${bakedLiffId}）。モバイルからの友だち追加が全経路で止まります。本番値でビルドし直してデプロイしてください。`,
        url: '/notifications',
      });
    } catch (err) {
      console.error('[liff-health] alert push failed:', err);
    }
  }
  return 'mismatch';
}
