#!/usr/bin/env node
'use strict';
// Probe GET /2/tweets/analytics: per-post metrics for a time window, which is
// the basis X Analytics uses (activity DURING the window, on any post), unlike
// public_metrics (lifetime totals). Asks for one account's posts from the
// window and the month before, so carry-over views are counted too.
//
//   node scripts/probe-x-analytics.js --account CitizenGO --from 2026-08-01 --to 2026-09-01 [--lookback 62]
//
// Writes redacted fixtures to fixtures/x-<date>-analytics-*.json. Costs cents.

const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../lib/graph');
const xapi = require('../lib/xapi');

loadEnv();
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf('--' + k); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const ACCOUNT = arg('account', 'CitizenGO');
const FROM = arg('from', '2026-08-01');
const TO = arg('to', '2026-09-01');
const LOOKBACK = Number(arg('lookback', 62));
const FIELDS = ['impressions', 'engagements', 'likes', 'retweets', 'quote_tweets', 'replies', 'bookmarks', 'shares',
  'url_clicks', 'user_profile_clicks', 'detail_expands'];

const stamp = new Date().toISOString().slice(0, 10);
const save = (name, obj) => {
  const dir = path.join(__dirname, '..', 'fixtures'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `x-${stamp}-analytics-${name}.json`), JSON.stringify(xapi.redact(obj), null, 2));
};

async function main() {
  const { loadAccounts, accessTokenFor } = require('../collector/x');
  const acc = (await loadAccounts()).filter((a) => !a.inline).find((a) => [a.account_id, a.username, a.label].includes(ACCOUNT));
  if (!acc) { console.error(`No enrolled account ${ACCOUNT}`); process.exit(2); }
  const cred = await accessTokenFor(acc, (m) => console.log(m));
  if (cred.error) { console.error(cred.error); process.exit(1); }
  const client = xapi.makeClient({ token: cred.token });

  const u = process.env.SUPABASE_URL; const k = process.env.SUPABASE_SERVICE_KEY;
  const since = new Date(Date.parse(FROM) - LOOKBACK * 86400e3).toISOString();
  const r = await fetch(`${u}/rest/v1/x_posts?select=post_id,created_at&account_id=eq.${acc.account_id}&created_at=gte.${since}&created_at=lt.${TO}&order=created_at.asc&limit=1000`,
    { headers: { apikey: k, Authorization: `Bearer ${k}` } });
  const ids = (await r.json()).map((p) => p.post_id);
  console.log(`${ids.length} posts from ${since.slice(0, 10)} to ${TO}`);

  const totals = {}; const daily = {}; let calls = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const res = await client.get('/2/tweets/analytics', {
      ids: ids.slice(i, i + 100).join(','), start_time: `${FROM}T00:00:00Z`, end_time: `${TO}T00:00:00Z`,
      granularity: 'daily', 'analytics.fields': [...FIELDS, 'timestamped_metrics'].join(','),
    });
    calls++;
    save(`${ACCOUNT}-${i / 100}`, res);
    console.log(`call ${calls}: HTTP ${res.status}${res.detail ? ' ' + res.detail : ''}${res.errors ? ` errors=${res.errors.length}` : ''} rate=${JSON.stringify(res.rate)}`);
    if (!res.ok) { console.log(JSON.stringify(res.errors || res.title).slice(0, 600)); continue; }
    if (calls === 1) console.log('shape:', JSON.stringify(res.body).slice(0, 900));
    for (const post of (res.body && res.body.data) || []) {
      for (const tm of post.timestamped_metrics || []) {
        const day = String(tm.timestamp).slice(0, 10);
        for (const f of FIELDS) {
          const v = Number((tm.metrics || tm)[f]) || 0;
          totals[f] = (totals[f] || 0) + v;
          if (f === 'impressions') daily[day] = (daily[day] || 0) + v;
        }
      }
    }
  }
  console.log('totals', JSON.stringify(totals));
  console.log('daily impressions', JSON.stringify(daily));
}
main().catch((e) => { console.error(e.stack); process.exit(1); });
