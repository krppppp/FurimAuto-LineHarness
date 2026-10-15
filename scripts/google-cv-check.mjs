#!/usr/bin/env node
// Google 広告のオフライン CV（Data Manager API）を、本番 D1 の ad_conversion_logs から手で確かめる（TB-1694）。
//
//   node scripts/google-cv-check.mjs status <ad_conversion_logs.id>   # response_body の requestId で requestStatus を引く
//   node scripts/google-cv-check.mjs status --request-id <requestId>
//   node scripts/google-cv-check.mjs validate <ad_conversion_logs.id> # request_body から本文を組み直し validateOnly: true で投げる
//
// 本番 D1 は読むだけ。validate は validateOnly: true 固定で、本送信に切り替える引数は持たない（架空 CV を送らないため）。
// 鍵は ad_platforms.config から読み、画面にもファイルにも出さない。
// 実行は apps/worker を作業ディレクトリにした wrangler（--env prod --remote）を使う。HOME は /Users/kuroiwayuya-m5 にしておく。

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const workerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/worker');

function d1(sql) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'line-crm-prod', '--remote', '--env', 'prod', '--json', '--command', sql],
    { cwd: workerDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  return JSON.parse(out)[0].results;
}

const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

function readGoogleConfig() {
  const rows = d1("SELECT config FROM ad_platforms WHERE name = 'google' AND is_active = 1 LIMIT 1");
  if (!rows.length) throw new Error('有効な google の ad_platforms がありません');
  return JSON.parse(rows[0].config);
}

function readLog(id) {
  const rows = d1(`SELECT id, status, click_id_type, request_body, response_body, error_message, created_at FROM ad_conversion_logs WHERE id = ${quote(id)}`);
  if (!rows.length) throw new Error(`ad_conversion_logs に ${id} がありません`);
  return rows[0];
}

async function accessToken(config) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: config.refresh_token,
      client_id: config.client_id,
      client_secret: config.client_secret,
    }),
  });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status}`);
  return (await res.json()).access_token;
}

// apps/worker/src/services/ad-conversion.ts の buildGoogleConversionEvent と同じ形に戻す。consent は Worker が常に両方 GRANTED で送っている
function rebuildBody(record) {
  const destination = {
    reference: 'd1',
    operatingAccount: { product: 'GOOGLE_ADS', accountId: record.customerId },
    productDestinationId: record.conversionActionId,
  };
  if (record.loginCustomerId) destination.loginAccount = { product: 'GOOGLE_ADS', accountId: record.loginCustomerId };
  const adIdentifiers = {};
  for (const k of ['gclid', 'gbraid', 'wbraid']) if (record[k]) adIdentifiers[k] = record[k];
  const event = {
    destinationReferences: ['d1'],
    eventSource: record.eventSource ?? 'WEB',
    eventTimestamp: record.eventTimestamp,
    adIdentifiers,
    consent: { adUserData: 'CONSENT_GRANTED', adPersonalization: 'CONSENT_GRANTED' },
  };
  if (record.transactionId) event.transactionId = record.transactionId;
  if (record.conversionValue) {
    event.conversionValue = record.conversionValue;
    event.currency = record.currency ?? 'JPY';
  }
  return { destinations: [destination], events: [event], validateOnly: true };
}

async function validate(logId) {
  const log = readLog(logId);
  const body = rebuildBody(JSON.parse(log.request_body));
  body.validateOnly = true;
  const token = await accessToken(readGoogleConfig());
  const res = await fetch('https://datamanager.googleapis.com/v1/events:ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  console.log(JSON.stringify({ log: { id: log.id, status: log.status, created_at: log.created_at }, request: body }, null, 2));
  console.log(`HTTP ${res.status}`);
  console.log(await res.text());
}

async function status(args) {
  let requestId;
  if (args[0] === '--request-id') {
    requestId = args[1];
  } else {
    const log = readLog(args[0]);
    requestId = log.response_body ? JSON.parse(log.response_body).requestId : null;
    console.log(JSON.stringify({ id: log.id, status: log.status, created_at: log.created_at, response_body: log.response_body }));
    if (!requestId) throw new Error('この行の response_body に requestId がありません（TB-1694 より前の送信は保存していない）');
  }
  const token = await accessToken(readGoogleConfig());
  const res = await fetch(`https://datamanager.googleapis.com/v1/requestStatus:retrieve?requestId=${encodeURIComponent(requestId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log(`HTTP ${res.status}`);
  console.log(await res.text());
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'validate' && rest[0]) await validate(rest[0]);
else if (cmd === 'status' && rest[0]) await status(rest);
else {
  console.error('usage: google-cv-check.mjs validate <log_id> | status <log_id> | status --request-id <id>');
  process.exit(1);
}
