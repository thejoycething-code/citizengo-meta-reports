#!/usr/bin/env node
'use strict';
// Opponent ads: the UK issue ads our opponents run, read from Meta's public Ad
// Library (Graph API ads_archive) into opponent_ads (sql/opponent-schema.sql).
// Free, official, and public by design: the Ad Library exists so anyone can see
// who is paying to push which political or social-issue message.
//
// Who is read: config/opponents-ig.json. An entry with fb_page_id is read by id;
// one with only fb_page_name is found by searching that exact phrase and keeping
// ads whose Page name matches it, and the run log names the id found so it can
// be pinned in the config. Collection authorised by Christopher Joyce on
// 31 Oct 2026 (Asana 1220076872722026); OPPONENTS_IG_ENABLED is the same switch
// as the Instagram opponent list, and without it this is a dry run.
//
// Each stored run ends by deleting opponent ads that stopped over 120 days ago.
//
// Usage: node collector/ad-library.js [--dry-run] [--days 90]
// Env: META_TOKENS (or META_TOKEN), SUPABASE_URL, SUPABASE_SERVICE_KEY, OPPONENTS_IG_ENABLED

const fs = require('fs');
const path = require('path');
const { loadEnv, makeClient } = require('../lib/graph');
const { makePg } = require('./peers-ig');

const VERSION = process.env.GRAPH_VERSION || 'v23.0';
const LIST = path.join(__dirname, '..', 'config', 'opponents-ig.json');
const FIELDS = 'id,page_id,page_name,ad_creation_time,ad_delivery_start_time,ad_delivery_stop_time,'
  + 'ad_creative_bodies,ad_creative_link_titles,ad_snapshot_url,spend,impressions,currency,publisher_platforms';
const MAX_PAGES = 20;   // 100 ads a page; a runaway guard, not a quota

function loadPages(file = LIST) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
    .filter((r) => r.fb_page_id || r.fb_page_name)
    .map((r) => ({ id: r.fb_page_id ? String(r.fb_page_id) : null, name: r.fb_page_name || r.name, label: r.name, topic: r.group || null }));
}

const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const norm = (s) => String(s || '').trim().toLowerCase();

// One Ad Library ad -> one opponent_ads row. Pure, for the tests.
function toRow(ad, page, seenAt) {
  return {
    ad_id: String(ad.id),
    page_id: String(ad.page_id),
    page_name: ad.page_name || null,
    label: page.label,
    topic: page.topic,
    created_time: ad.ad_creation_time || null,
    delivery_start: ad.ad_delivery_start_time || null,
    delivery_stop: ad.ad_delivery_stop_time || null,
    bodies: (ad.ad_creative_bodies || []).filter(Boolean).join('\n---\n') || null,
    link_titles: [...new Set((ad.ad_creative_link_titles || []).filter(Boolean))].join(' | ') || null,
    snapshot_url: ad.ad_snapshot_url || null,
    spend_lower: num(ad.spend && ad.spend.lower_bound),
    spend_upper: num(ad.spend && ad.spend.upper_bound),
    impressions_lower: num(ad.impressions && ad.impressions.lower_bound),
    impressions_upper: num(ad.impressions && ad.impressions.upper_bound),
    currency: ad.currency || null,
    platforms: ad.publisher_platforms || null,
    last_seen_at: seenAt,
  };
}

async function readAll(get, params) {
  const out = [];
  let after;
  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await get('/ads_archive', { ...params, fields: FIELDS, limit: 100, after });
    if (!res.ok) {
      const e = res.error || {};
      throw new Error(`ads_archive refused: ${e.message || res.transport_error || `HTTP ${res.status}`}`.slice(0, 300));
    }
    out.push(...((res.body && res.body.data) || []));
    after = res.body && res.body.paging && res.body.paging.cursors && res.body.paging.next ? res.body.paging.cursors.after : null;
    if (!after) break;
  }
  return out;
}

async function run({ get, upsert, purge = null, pages, opts, now = new Date(), log = console.log }) {
  const base = {
    ad_reached_countries: JSON.stringify(['GB']),
    ad_type: 'POLITICAL_AND_ISSUE_ADS',
    ad_active_status: 'ALL',
    ad_delivery_date_min: new Date(now.getTime() - opts.days * 86_400_000).toISOString().slice(0, 10),
  };
  const seenAt = now.toISOString();
  const rows = new Map();
  const counts = { pages: 0, ads: 0, notFound: 0 };

  for (const page of pages) {
    const ads = page.id
      ? await readAll(get, { ...base, search_page_ids: JSON.stringify([page.id]) })
      : (await readAll(get, { ...base, search_terms: page.name, search_type: 'KEYWORD_EXACT_PHRASE' }))
        .filter((a) => norm(a.page_name) === norm(page.name));
    if (!ads.length) { counts.notFound++; log(`  ${page.label}: no UK issue ads in ${opts.days} days`); continue; }
    counts.pages++;
    const ids = [...new Set(ads.map((a) => String(a.page_id)))];
    const live = ads.filter((a) => !a.ad_delivery_stop_time).length;
    log(`  ${page.label}: ${ads.length} ads (${live} running)${page.id ? '' : `; Page id ${ids.join(', ')} - pin it as fb_page_id`}`);
    for (const a of ads) rows.set(String(a.id), toRow(a, page, seenAt));
  }
  counts.ads = rows.size;

  if (!opts.dryRun) {
    await upsert('opponent_ads', [...rows.values()], 'ad_id');
    if (purge) {
      const p = await purge();
      log(`retention: deleted ${p.ads_deleted} opponent ads that ended over 120 days ago`);
    }
  }
  log(`done: ${counts.pages} pages with ads, ${counts.notFound} without; ${counts.ads} ads${opts.dryRun ? ' (dry run, nothing written)' : ''}`);
  return counts;
}

async function main() {
  loadEnv();
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--days');
  const enabled = String(process.env.OPPONENTS_IG_ENABLED || '').trim() === 'true';
  const opts = { dryRun: argv.includes('--dry-run') || !enabled, days: Math.min(Math.max(Number(i === -1 ? 90 : argv[i + 1]) || 90, 1), 365) };
  if (!enabled) console.log('opponent ads: dry run only, nothing stored (OPPONENTS_IG_ENABLED is not set)');
  const tokens = String(process.env.META_TOKENS || process.env.META_TOKEN || '').split(/[\n,]/).map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) throw new Error('META_TOKENS is not set');
  const pages = loadPages();
  // The Ad Library needs a token whose user has confirmed their identity with
  // Meta; try each until one is accepted.
  let lastError = null;
  for (const token of tokens) {
    const { get } = makeClient({ token, version: VERSION });
    try {
      const pg = opts.dryRun ? {} : makePg();
      await run({ get, upsert: pg.upsert, purge: pg.purge, pages, opts });
      return;
    } catch (e) {
      lastError = e;
      if (!/ads_archive refused/.test(e.message)) throw e;
      console.log(`a token was refused by the Ad Library (${e.message.slice(0, 160)}); trying the next`);
    }
  }
  throw lastError;
}

if (require.main === module) {
  main().catch((e) => { console.error(`opponent ads failed: ${e.message}`); process.exit(1); });
}

module.exports = { loadPages, toRow, run };
