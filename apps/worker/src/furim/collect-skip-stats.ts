/**
 * 在庫巡回キューの記録（furim_ext_errors の method='collectSkip'）を理由ごとに数える（Capsec #294）。
 *
 * 拡張 399578b 以降は、キューを落とした・落とさなかった事実を理由つきで送ってくる。
 * 理由によって意味がまったく違うので、まとめて「取りこぼし」と数えてはいけない。
 *
 * - timeout_skipped … 60 秒で打ち切って先頭を落とした。**本当の取りこぼし**（その販路の売却検知が 1 周分飛ぶ）
 * - no_owner        … タブの担当の控えが無かった。拡張の再読み込み等で単発なら問題ないが、
 *                     **同じキーコードで続く**なら担当の記録が壊れている
 * - not_mine        … 先頭が自分の担当と違うので落とさなかった。**直した仕組みが効いた正常な印**。異常に数えない
 * - empty           … キューがもう空だった。正常
 *
 * error 列は『queue / reason / 販路 / detail』の形（routes/ext-api.ts の collect-skip）。2 つ目が理由。
 */

/** no_owner をこの回数以上、同じキーコードで直近 24 時間に受けたら「続いている」とみなす。
 *  拡張は同じ事象を 10 分に 1 回までに間引いて送るので、3 回はおおよそ 20〜30 分以上続いた目安 */
export const NO_OWNER_PERSIST_MIN = 3;

export type CollectSkipStats = {
  /** 本当の取りこぼし（異常に数える） */
  timeoutSkipped: number;
  /** 続いている no_owner の件数（異常に数える） */
  noOwnerPersistent: number;
  /** no_owner が続いている会員の数 */
  noOwnerPersistentUsers: number;
  /** 直した仕組みが効いた回数（異常には数えない。効果の確認用） */
  notMine: number;
  /** 異常に数える件数の最古（timeout_skipped と続く no_owner の中で） */
  since: string | null;
};

/** error 列から理由を取り出す（『collect / timeout_skipped / メルカリ / …』の 2 つ目） */
export function reasonOf(error: string | null | undefined): string {
  const parts = String(error ?? '').split(' / ');
  return (parts[1] ?? '').trim();
}

export function summarizeCollectSkipRows(rows: Array<{ key_code: string | null; error: string | null; created_at: string }>): CollectSkipStats {
  let timeoutSkipped = 0;
  let notMine = 0;
  let since: string | null = null;
  const noOwnerByKey = new Map<string, Array<string>>();
  const earlier = (a: string | null, b: string) => (a === null || b.replace(' ', 'T') < a.replace(' ', 'T') ? b : a);

  for (const r of rows) {
    const reason = reasonOf(r.error);
    if (reason === 'timeout_skipped') {
      timeoutSkipped++;
      since = earlier(since, r.created_at);
    } else if (reason === 'not_mine') {
      notMine++;
    } else if (reason === 'no_owner') {
      const key = r.key_code ?? '(キーコードなし)';
      const list = noOwnerByKey.get(key) ?? [];
      list.push(r.created_at);
      noOwnerByKey.set(key, list);
    }
  }

  let noOwnerPersistent = 0;
  let noOwnerPersistentUsers = 0;
  for (const list of noOwnerByKey.values()) {
    if (list.length < NO_OWNER_PERSIST_MIN) continue;
    noOwnerPersistent += list.length;
    noOwnerPersistentUsers++;
    for (const at of list) since = earlier(since, at);
  }

  return { timeoutSkipped, noOwnerPersistent, noOwnerPersistentUsers, notMine, since };
}

export async function summarizeCollectSkips(db: D1Database, sinceJst: string): Promise<CollectSkipStats> {
  const res = await db
    .prepare(
      `SELECT key_code, error, created_at FROM furim_ext_errors
       WHERE method = 'collectSkip' AND substr(replace(created_at, ' ', 'T'), 1, 19) >= ?`,
    )
    .bind(sinceJst)
    .all<{ key_code: string | null; error: string | null; created_at: string }>();
  return summarizeCollectSkipRows(res.results ?? []);
}
