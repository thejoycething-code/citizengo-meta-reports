#!/usr/bin/env node
'use strict';
// Pins collector/ad-library.js against a fake Ad Library: who is read by id and
// who by name, that a name search keeps only the matching Page, paging, and that
// a dry run writes nothing. Usage: node scripts/test-ad-library.js

const { loadPages, toRow, run } = require('../collector/ad-library');

let passed = 0, failed = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failed++; }
}

const ad = (id, page_id, page_name, extra = {}) => ({ id, page_id, page_name, ad_delivery_start_time: '2026-10-20T10:00:00+0000',
  ad_creative_bodies: ['Sign now', 'Sign now'], ad_creative_link_titles: ['Act', 'Act'], ad_snapshot_url: 'https://fb/ads/' + id,
  spend: { lower_bound: '100', upper_bound: '199' }, impressions: { lower_bound: '1000', upper_bound: '1999' }, currency: 'GBP', ...extra });

(async () => {
  const pages = loadPages();
  eq('config: pages with a Facebook Page to read', pages.length > 0 && pages.every((p) => p.id || p.name), true);
  eq('config: Dignity in Dying read by id', pages.find((p) => p.label === 'Dignity in Dying').id, '47612991154');

  const r = toRow(ad('1', 9, 'X', { ad_delivery_stop_time: null }), { label: 'X', topic: 'gender' }, '2026-10-31T00:00:00Z');
  eq('row: ranges as numbers, text variants deduplicated', [r.spend_lower, r.spend_upper, r.link_titles, r.delivery_stop], [100, 199, 'Act', null]);

  const calls = [];
  const get = async (path, params) => {
    calls.push(params);
    if (params.search_page_ids) {
      return params.after ? { ok: true, body: { data: [ad('2', 47612991154, 'Dignity in Dying')] } }
        : { ok: true, body: { data: [ad('1', 47612991154, 'Dignity in Dying')], paging: { next: 'n', cursors: { after: 'c1' } } } };
    }
    return { ok: true, body: { data: [ad('3', 555, 'Stonewall'), ad('4', 777, 'Stonewall Housing')] } };
  };
  const writes = [];
  const opts = { dryRun: false, days: 90 };
  const testPages = [{ id: '47612991154', name: 'Dignity in Dying', label: 'Dignity in Dying', topic: 'assisted-dying' },
    { id: null, name: 'Stonewall', label: 'Stonewall', topic: 'gender' }];
  const counts = await run({ get, upsert: async (t, rows) => writes.push([t, rows.map((x) => x.ad_id)]), purge: async () => ({ ads_deleted: 0 }),
    pages: testPages, opts, now: new Date('2026-10-31T00:00:00Z'), log: () => {} });
  eq('by id: both pages of results read', writes[0][1].slice(0, 2), ['1', '2']);
  eq('by name: only the exact Page kept', writes[0][1].slice(2), ['3']);
  eq('UK issue ads only, 90 days back', [calls[0].ad_type, calls[0].ad_reached_countries, calls[0].ad_delivery_date_min], ['POLITICAL_AND_ISSUE_ADS', '["GB"]', '2026-08-02']);
  eq('counts', [counts.pages, counts.ads], [2, 3]);

  const dry = [];
  await run({ get, upsert: async () => dry.push(1), pages: testPages, opts: { dryRun: true, days: 90 }, log: () => {} });
  eq('dry run writes nothing', dry.length, 0);

  const refused = await run({ get: async () => ({ ok: false, error: { message: 'identity not confirmed' } }), upsert: async () => {}, pages: testPages, opts, log: () => {} })
    .then(() => 'ran', (e) => e.message);
  eq('a refused token is reported, not swallowed', refused.startsWith('ads_archive refused'), true);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
