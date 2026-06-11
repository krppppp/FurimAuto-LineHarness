#!/usr/bin/env node
/**
 * FurimAuto 顧客一括流し込みスクリプト
 *
 * 使い方:
 *   WORKER_URL=https://... API_KEY=xxx \
 *   node scripts/import-customers.mjs \
 *     --master=./master.tsv \
 *     [--referrals=./referrals.tsv] \
 *     [--enrich]  # LINE APIでプロフィールを取得（LINE_CHANNEL_ACCESS_TOKEN 要）
 *     [--dry-run] # DBに書き込まず判定結果だけ出力
 *
 * TSVフォーマット:
 *   master.tsv    : 顧客情報-サブスク情報-キーコード シートのエクスポート（ヘッダー行あり）
 *   referrals.tsv : LINE紹介履歴 シートのエクスポート（ヘッダー行あり）
 *                   必須列: LINE_ID(ア)、LINE_ID(友)
 *                   ※ GASエクスポートの2行目の型情報行（"String..."）は自動スキップ
 *                   ※ このファイル1つからアンバサダー紹介数も自動集計する
 */

import { readFileSync } from 'fs';

// ────────────── 設定 ──────────────

const BASE_URL = process.env.WORKER_URL || 'https://line-crm-worker.line-crm-api.workers.dev';
const API_KEY = process.env.API_KEY;
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ENRICH = args.includes('--enrich');

const masterFile = args.find((a) => a.startsWith('--master='))?.split('=')[1];
const referralsFile = args.find((a) => a.startsWith('--referrals='))?.split('=')[1];
const OFFSET = parseInt(args.find((a) => a.startsWith('--offset='))?.split('=')[1] ?? '0', 10);
const LIMIT = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '0', 10);

if (!API_KEY) { console.error('Error: API_KEY 未設定'); process.exit(1); }
if (!masterFile) { console.error('Error: --master=<file> が必要'); process.exit(1); }
if (ENRICH && !LINE_TOKEN) { console.error('Error: --enrich には LINE_CHANNEL_ACCESS_TOKEN が必要'); process.exit(1); }

// ────────────── TSVパーサー ──────────────

function parseTsv(filePath) {
  const text = readFileSync(filePath, 'utf-8');
  const lines = text.split('\n').filter((l) => l.trim());
  const headers = lines[0].split('\t').map((h) => h.trim());
  return lines.slice(1).filter((line) => {
    // GASエクスポートの型情報行（"String\tString\t..."）をスキップ
    const first = line.split('\t')[0].trim();
    return first !== 'String' && first !== 'Number' && first !== 'Date';
  }).map((line) => {
    const values = line.split('\t');
    const row = {};
    headers.forEach((h, i) => { row[h] = (values[i] ?? '').trim(); });
    return row;
  });
}

// シートの日時 "2025/06/29 23:24:44" → JST ISO "2025-06-29T23:24:44.000+09:00"（friends.created_at 形式）
function toJstIso(s) {
  // シートは月日・時分秒が1桁になる場合がある（例 "2023/06/10 0:29:35"）→ 1〜2桁許容しゼロ埋め
  const m = (s || '').match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})/);
  if (!m) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${m[1]}-${p(m[2])}-${p(m[3])}T${p(m[4])}:${p(m[5])}:${p(m[6])}.000+09:00`;
}

// ────────────── タグ判定 ──────────────

function getSegment(row) {
  const アンケート = row['アンケート回答'] || '';
  const 初回発行 = row['初回発行'] === 'TRUE';
  const 端末判定文字列 = row['端末判定文字列'] || '';
  const メルカリURL = row['メルカリURL'] || '';
  const Free30チケット = row['Free30チケット'] === 'TRUE' || row['Free30チケット'] === true;
  const Youtubeクーポン = (row['Youtubeクーポン'] || '').toString().trim();
  const 延長キーワード  = (row['延長キーワード']  || '').toString().trim();

  if (アンケート.trim() === 'サブアカウント') return null;
  if (!アンケート && !初回発行) return 1;
  if (アンケート && !初回発行) return 2;
  if (初回発行 && !端末判定文字列) return 3;
  if (端末判定文字列 && !メルカリURL) return 4;
  if (端末判定文字列 && メルカリURL && Free30チケット && Youtubeクーポン && 延長キーワード) return 8;
  if (端末判定文字列 && メルカリURL && Free30チケット && Youtubeクーポン) return 7;
  if (端末判定文字列 && メルカリURL && Free30チケット) return 6;
  if (端末判定文字列 && メルカリURL) return 5;
  return null;
}

function determineTags(row, introducedIds, ambassadorCounts) {
  const tags = [];

  const lineId = row['LINE_ID'] || '';
  const アンケート = row['アンケート回答'] || '';
  const 端末判定文字列 = row['端末判定文字列'] || '';
  const プラン名 = row['プラン名'] || '';
  const Youtubeクーポン = (row['Youtubeクーポン'] || '').toString().trim();
  const 延長キーワード  = (row['延長キーワード']  || '').toString().trim();
  const rawEnd = row['サブスク終了日時'];
  const サブスク終了日時 = rawEnd ? new Date(rawEnd) : null;
  const 月額金額Raw = row['サブスク価格'] || '0';
  const 月額金額 = parseInt(月額金額Raw.replace(/[^0-9]/g, ''), 10) || 0;
  const now = new Date();

  const isSubAccount = アンケート.trim() === 'サブアカウント';
  const isCancelled = プラン名.includes('キャンセル済み');
  const isSubDevice = プラン名.includes('2台目以降');
  const hasPlan = プラン名.includes('プラン');
  const isTrialActive = !hasPlan && !isCancelled && !!サブスク終了日時 && サブスク終了日時 > now;
  const isTrialExpired = !hasPlan && !isCancelled && !!サブスク終了日時 && サブスク終了日時 <= now;

  if (isSubAccount) tags.push('サブ垢');
  if (isCancelled) tags.push('キャンセル済み');
  if (isSubDevice) tags.push('サブ垢');
  if (isTrialActive) tags.push('無料試用期間中');

  // セグメントタグ（月額会員・キャンセル済み以外の全ユーザー）
  if (!hasPlan && !isCancelled && !isSubAccount) {
    const seg = getSegment(row);
    if (seg) tags.push(`セグメント${seg}`);
  }

  // 流入・アクション
  if (introducedIds.has(lineId)) tags.push('紹介経由');
  if (Youtubeクーポン) tags.push('Furimanです');
  if (延長キーワード) tags.push('解説見た');

  // 課金
  if (hasPlan && 月額金額 > 0) {
    tags.push('月額会員');
    const tier = [3000, 5000, 8000, 10000, 15000, 19800].find((t) => 月額金額 <= t);
    if (tier) tags.push(`月額${tier}`);
  }

  // アンバサダーLv（最高Lvのみ）
  const count = ambassadorCounts.get(lineId) || 0;
  if (count >= 10) {
    tags.push('アンバサダーLv.10');
  } else if (count >= 5) {
    tags.push('アンバサダーLv.5');
  } else if (count >= 1) {
    tags.push('アンバサダーLv.1');
  }

  // 試用終了後分類
  if (isTrialExpired) {
    tags.push(端末判定文字列 ? '見込客' : '未使用ユーザー');
  }

  return tags;
}

// ────────────── LINE API ──────────────

async function fetchLineProfile(lineUserId) {
  const res = await fetch(`https://api.line.me/v2/bot/profile/${lineUserId}`, {
    headers: { Authorization: `Bearer ${LINE_TOKEN}` },
  });
  if (!res.ok) return null;
  return res.json();
}

// ────────────── LineHarness API ──────────────

const apiHeaders = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${API_KEY}`,
};

async function upsertFriend(lineUserId, displayName, pictureUrl, createdAt) {
  const res = await fetch(`${BASE_URL}/api/furim/upsert-friend`, {
    method: 'POST',
    headers: apiHeaders,
    body: JSON.stringify({ lineUserId, displayName, pictureUrl, createdAt }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(`upsertFriend failed: ${JSON.stringify(json)}`);
  return json.data;
}

async function getAllTags() {
  const res = await fetch(`${BASE_URL}/api/tags`, { headers: apiHeaders });
  const json = await res.json();
  if (!json.success) throw new Error(`getTags failed: ${JSON.stringify(json)}`);
  return json.data; // Tag[]
}

async function addTag(friendId, tagId) {
  const res = await fetch(`${BASE_URL}/api/friends/${friendId}/tags`, {
    method: 'POST',
    headers: apiHeaders,
    body: JSON.stringify({ tagId }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(`addTag failed: ${JSON.stringify(json)}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ────────────── メイン処理 ──────────────

async function main() {
  console.log(`[config] BASE_URL=${BASE_URL} DRY_RUN=${DRY_RUN} ENRICH=${ENRICH}`);

  // 1. TSV読み込み
  const masterRows = parseTsv(masterFile);
  console.log(`[master] ${masterRows.length} 行`);

  // 2. 紹介履歴 → introducedIds と ambassadorCounts
  const introducedIds = new Set();
  const ambassadorCounts = new Map();

  if (referralsFile) {
    const referralRows = parseTsv(referralsFile);
    console.log(`[referrals] ${referralRows.length} 行`);
    for (const r of referralRows) {
      const friendId = r['LINE_ID(友)'];
      const ambassadorId = r['LINE_ID(ア)'];
      if (friendId) introducedIds.add(friendId);
      // 紹介数はこのファイルのLINE_ID(ア)出現回数から集計
      if (ambassadorId) ambassadorCounts.set(ambassadorId, (ambassadorCounts.get(ambassadorId) || 0) + 1);
    }
  }

  console.log(`[referrals] introducedIds=${introducedIds.size} ambassadors=${ambassadorCounts.size}`);

  // 3. タグ名→ID マップを取得
  let tagNameToId = new Map();
  if (!DRY_RUN) {
    const allTags = await getAllTags();
    for (const t of allTags) {
      tagNameToId.set(t.name, t.id);
    }
    console.log(`[tags] ${tagNameToId.size} タグをロード`);
  }

  // 4. 各顧客を処理
  const sliced = LIMIT > 0 ? masterRows.slice(OFFSET, OFFSET + LIMIT) : masterRows.slice(OFFSET);
  console.log(`[range] ${OFFSET + 1}〜${OFFSET + sliced.length} 件目を処理`);
  let ok = 0, skip = 0, err = 0;
  for (let i = 0; i < sliced.length; i++) {
    const row = sliced[i];
    const lineId = row['LINE_ID'] || '';

    if (!lineId) {
      skip++;
      continue;
    }

    let displayName = row['LINE表示名'] || null;
    let pictureUrl = null;
    const createdAt = toJstIso(row['友達登録日時']); // 元の登録日時を引き継ぐ（無効ならnull→サーバ側でnow）

    // LINE API でプロフィール取得
    let isBlocked = false;
    if (ENRICH) {
      try {
        const profile = await fetchLineProfile(lineId);
        if (profile) {
          displayName = profile.displayName ?? displayName;
          pictureUrl = profile.pictureUrl ?? null;
        } else {
          isBlocked = true;
        }
      } catch (e) {
        isBlocked = true;
      }
      await sleep(300); // LINE API レート制限対応
    }

    const tags = determineTags(row, introducedIds, ambassadorCounts);
    if (isBlocked) tags.push('ブロック');

    if (DRY_RUN) {
      console.log(`[dry-run][${OFFSET + i + 1}/${masterRows.length}] ${lineId} "${displayName}" tags=[${tags.join(', ')}]`);
      ok++;
      continue;
    }

    try {
      const friend = await upsertFriend(lineId, displayName, pictureUrl, createdAt);

      // タグ付与
      const missingTags = [];
      for (const tagName of tags) {
        const tagId = tagNameToId.get(tagName);
        if (!tagId) {
          missingTags.push(tagName);
          continue;
        }
        await addTag(friend.id, tagId);
      }

      if (missingTags.length > 0) {
        console.warn(`[warn][${i + 1}] ${lineId} タグ未登録: ${missingTags.join(', ')}`);
      }

      console.log(`[ok][${OFFSET + i + 1}/${masterRows.length}] ${lineId} "${friend.displayName}" tags=[${tags.join(', ')}]`);
      ok++;
    } catch (e) {
      console.error(`[error][${OFFSET + i + 1}] ${lineId}:`, e.message);
      err++;
    }

    // API レート制限対応（enrich なしでも少し待つ）
    if (!ENRICH && i % 10 === 9) await sleep(100);
  }

  console.log(`\n[完了] ok=${ok} skip=${skip} error=${err}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
