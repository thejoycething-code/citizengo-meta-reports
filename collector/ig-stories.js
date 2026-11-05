#!/usr/bin/env node
'use strict';
// Instagram Stories, read while they are live (5 Nov 2026).
//
//   node collector/ig-stories.js [--dry-run]
//
// A Story and its insights last 24 hours. The nightly collection reads the
// Stories live at 04:30 (collector/instagram.js collectStories), which catches
// each one once but part-way through its life; run hourly, this keeps each
// Story's figures to within an hour of final. Every reading overwrites the
// day's row, so the last one before expiry is what stays.
//
// The accounts are the ones the nightly already found linked to our Pages
// (meta_ig_account_metrics), read with the same System User tokens.

const path = require('path');
const { loadEnv, makeClient } = require('../lib/graph');

loadEnv();

const { makePageTokens } = require('../lib/pagetokens');
const { collectStories } = require('./instagram');
const { makeSink } = require('./lib/sinks');

const DRY_RUN = process.argv.includes('--dry-run');
const VERSION = process.env.GRAPH_VERSION || 'v23.0';
const TOKENS = String(process.env.META_TOKENS || process.env.META_TOKEN || '').split(/[\n,]/).map((t) => t.trim()).filter(Boolean);
const SB = String(process.env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY || '';

async function accounts() {
  const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const r = await fetch(`${SB}/rest/v1/meta_ig_account_metrics?select=ig_user_id,page_id,ig_username&metric_date=gte.${since}&limit=5000`,
    { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`accounts: HTTP ${r.status}`);
  const seen = new Map();
  for (const a of await r.json()) if (!seen.has(a.ig_user_id)) seen.set(a.ig_user_id, a);
  return [...seen.values()];
}

(async () => {
  if (!TOKENS.length) { console.error('No token. Set META_TOKENS.'); process.exit(1); }
  const client = makeClient({ token: TOKENS[0], version: VERSION });
  const pages = makePageTokens(client, TOKENS);
  await pages.enumeratePages();
  const sink = makeSink({ dryRun: DRY_RUN, dir: path.join(__dirname, '..', 'data') });
  const runStarted = new Date();
  const collectedDate = runStarted.toISOString().slice(0, 10);
  const call = (p, params, opts) => client.get(p, params, opts || {});
  let stories = 0; let failed = 0;
  for (const a of await accounts()) {
    const token = await pages.tokenFor(a.page_id);
    if (!token) { console.log(`@${a.ig_username}: no page token`); failed++; continue; }
    try {
      const s = await collectStories({
        ig: { id: a.ig_user_id, username: a.ig_username }, page: { page_id: a.page_id },
        as: { token }, call, runStarted, collectedDate,
      });
      if (s.error) { console.log(`@${a.ig_username}: ${String(s.error.message).slice(0, 100)}`); failed++; continue; }
      if (s.media.length) {
        await sink.upsert('meta_ig_media', s.media);
        // One shape per batch: see upsertByShape in collect.js.
        const groups = new Map();
        for (const m of s.metrics) { const k = Object.keys(m).sort().join(); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); }
        for (const g of groups.values()) await sink.upsert('meta_ig_media_metrics', g);
      }
      stories += s.media.length;
      if (s.media.length) console.log(`@${a.ig_username}: ${s.media.length} live`);
    } catch (e) {
      console.log(`@${a.ig_username}: failed — ${String(e.message).slice(0, 150)}`);
      failed++;
    }
  }
  console.log(`${stories} live stor${stories === 1 ? 'y' : 'ies'} read${failed ? `, ${failed} account(s) failed` : ''}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
