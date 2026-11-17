#!/usr/bin/env node
'use strict';
// Fill meta_ig_account_weeks for past Monday-Sunday weeks, for every Instagram
// account linked to a Page the tokens can see. The nightly collection only
// reads this week and the last (collector/instagram.js collectAccountWeeks);
// Meta serves these weekly totals for a year or more, so missed or earlier
// weeks can be filled here.
//
//   node scripts/ig-weeks-backfill.js [--weeks 12] [--only citizengo] [--dry-run]
//
// Reads Meta; writes only meta_ig_account_weeks (or data/ with --dry-run).

const path = require('path');
const { loadEnv, makeClient } = require('../lib/graph');
const { makeSink } = require('../collector/lib/sinks');
const { collectAccountWeeks } = require('../collector/instagram');
loadEnv();

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i === -1 ? fallback : args[i + 1]; };
const WEEKS = Math.min(Math.max(Number(opt('weeks', 12)) || 12, 1), 60);
const ONLY = opt('only', null);
const DRY_RUN = args.includes('--dry-run');
const TOKENS = String(process.env.META_TOKENS || process.env.META_TOKEN || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
if (!TOKENS.length) { console.error('No token. Set META_TOKENS.'); process.exit(2); }
const VERSION = process.env.GRAPH_VERSION || 'v23.0';
const sink = makeSink({ dryRun: DRY_RUN, dir: path.join(__dirname, '..', 'data') });

(async () => {
  const runStarted = new Date();
  const seen = new Set();
  let failed = 0;
  for (const token of TOKENS) {
    const client = makeClient({ token, version: VERSION });
    const call = (p, params, o) => client.get(p, params, o);
    let after = null;
    do {
      const r = await call('/me/accounts', { fields: 'id,access_token,instagram_business_account{id,username}', limit: 100, after });
      if (!r.ok) { console.log(`me/accounts failed: ${r.error ? r.error.message : 'unknown'}`); break; }
      for (const p of r.body.data || []) {
        const ig = p.instagram_business_account;
        if (!ig || seen.has(ig.id) || (ONLY && ig.username !== ONLY)) continue;
        seen.add(ig.id);
        const { rows, errorCount } = await collectAccountWeeks({
          ig, page: { page_id: p.id }, as: { token: p.access_token }, call, runStarted, weeksBack: WEEKS,
        });
        // One shape per upsert, as upsertByShape in collect.js: a metric that
        // failed is left out rather than written as null over a stored value.
        const groups = new Map();
        for (const row of rows) { const k = Object.keys(row).sort().join(); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(row); }
        try {
          for (const g of groups.values()) await sink.upsert('meta_ig_account_weeks', g);
          console.log(`@${ig.username}: ${rows.length} week(s)${errorCount ? `, ${errorCount} with errors` : ''}`);
        } catch (e) {
          failed++;
          console.log(`@${ig.username}: not saved — ${String(e.message).slice(0, 160)}`);
        }
      }
      after = r.body.paging && r.body.paging.next && r.body.paging.cursors ? r.body.paging.cursors.after : null;
    } while (after);
  }
  console.log(`${seen.size} account(s)${failed ? `, ${failed} not saved` : ''}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
