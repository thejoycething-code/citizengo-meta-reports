#!/usr/bin/env node
'use strict';
// Loads the daily Looker pull into link_signature_days (scripts/link-signatures-mini.sh).
//
//   node scripts/load-link-signature-days.js <stream.jsonl> [--dry-run]
//
// Sign-ups per tracked link, per arrival source (fb, ig, tw) and per day, for
// the last DAYS days: what lets lib/post-signups.js credit each day's sign-ups
// to the post that was live that day. Same safety rule as
// load-link-signatures.js: rows from older pulls are cleared only when this
// pull looks complete, so a broken or truncated pull never wipes good data.

const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../lib/graph');
const { rowsFromStream } = require('./load-link-signatures');
const { makeSink } = require('../collector/lib/sinks');

const LIMIT = 50000; // the limit the query asks for (link-signatures-mini.sh)
const SOURCES = new Set(['fb', 'ig', 'tw']);
const F = 'petitions_signatures_3_0.';

function toDayRows(lookerRows, pulledAt) {
  const out = new Map();
  for (const r of lookerRows) {
    const code = String(r[F + 'utm_campaign'] || '').trim().toLowerCase();
    const source = String(r[F + 'source'] || '').trim().toLowerCase();
    const day = String(r[F + 'date_date'] || '').slice(0, 10);
    if (!code || !SOURCES.has(source) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const num = (k) => (r[F + k] === null || r[F + k] === undefined ? null : Number(r[F + k]));
    const key = `${code}|${source}|${day}`;
    const prev = out.get(key);
    const row = { campaign_code: code, source, day, signatures: num('sum_signatures'), new_members: num('sum_new_members'),
      reactivated_members: num('sum_reactivated_members'), pulled_at: pulledAt };
    // The two queries overlap; the same key twice is the same figure.
    if (!prev) out.set(key, row);
  }
  return [...out.values()];
}

async function main() {
  loadEnv();
  const file = process.argv[2];
  const dry = process.argv.includes('--dry-run');
  if (!file) { console.error('Usage: node scripts/load-link-signature-days.js <stream.jsonl> [--dry-run]'); process.exit(2); }
  const pulledAt = new Date().toISOString();
  const looker = rowsFromStream(fs.readFileSync(file, 'utf8'));
  const rows = toDayRows(looker, pulledAt);
  const truncated = (looker.perQuery || [looker.length]).some((c) => c >= LIMIT);
  console.log(`${pulledAt} Looker returned ${(looker.perQuery || [looker.length]).join(' + ')} rows; ${rows.length} link-day rows${truncated ? ' (HIT THE ROW LIMIT: older rows kept)' : ''}`);
  if (!rows.length) { console.log('nothing to load; existing rows kept'); return; }
  const sink = makeSink({ dryRun: dry, dir: path.join(__dirname, '..', 'data') });
  for (let i = 0; i < rows.length; i += 500) await sink.upsert('link_signature_days', rows.slice(i, i + 500));
  await sink.flush();
  if (!dry && !truncated) {
    const base = process.env.SUPABASE_URL.trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
    const key = process.env.SUPABASE_SERVICE_KEY;
    const r = await fetch(`${base}/rest/v1/link_signature_days?pulled_at=lt.${encodeURIComponent(pulledAt)}`, { method: 'DELETE', headers: { apikey: key, Authorization: 'Bearer ' + key, Prefer: 'return=minimal' } });
    if (!r.ok) throw new Error(`clearing older rows failed: HTTP ${r.status}`);
  }
  console.log(`loaded ${rows.length} rows`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { toDayRows };
