#!/usr/bin/env node
'use strict';
// Pins collector/adspend.js: one row per ad with LIFETIME totals, so ten nightly
// runs over one boost store one row, not ten that get summed. Built from the
// CitizenGO Argentina boost of 8-12 Nov 2026 (ARS 79,402, reach 23,025), which
// the old rolling-window rows reported as ARS 627,749 / reach 190,815.
// Usage: node scripts/test-adspend.js

const { collectAdSpend } = require('../collector/adspend');
const { jsonSink } = require('../collector/lib/sinks');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0, failed = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failed++; }
}

const POST = '1092595733162631_1151513767270827';
const LIFETIME = { ad_id: 'ad1', campaign_name: 'Papa', spend: '79402.19', impressions: '34604', reach: '23025', date_start: '2026-11-08', date_stop: '2026-11-12' };

function fakeGraph({ pages = 1 } = {}) {
  const calls = [];
  const call = async (p, params) => {
    calls.push({ p, params });
    if (p === '/me/adaccounts') return { ok: true, body: { data: [{ id: 'act_1', account_id: '1', currency: 'ARS' }] } };
    if (p === '/act_1/ads') return { ok: true, body: { data: [{ id: 'ad1', creative: { effective_object_story_id: POST } }, { id: 'ad2', creative: {} }] } };
    if (p === '/act_1/insights' && params.date_preset === 'maximum') {
      const ids = JSON.parse(params.filtering)[0].value;
      return { ok: true, body: { data: ids.includes('ad1') ? [LIFETIME] : [] } };
    }
    if (p === '/act_1/insights') {
      // Discovery, optionally split over several pages to check the cursor is followed.
      const n = params.after ? Number(params.after) : 0;
      const data = n === 0 ? [{ ad_id: 'ad2' }] : [{ ad_id: 'ad1' }];
      const more = n + 1 < pages;
      return { ok: true, body: { data: pages === 1 ? [{ ad_id: 'ad1' }, { ad_id: 'ad2' }] : data,
        paging: more ? { cursors: { after: String(n + 1) }, next: 'x' } : {} } };
    }
    return { ok: false, error: { message: 'unexpected ' + p } };
  };
  return { call, calls };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adspend-'));
  const sink = jsonSink({ dir });
  const g = fakeGraph();
  for (let night = 9; night <= 18; night++) {
    const { rows } = await collectAdSpend({ call: g.call, lookbackDays: 400, runStarted: new Date(`2026-11-${String(night).padStart(2, "0")}T04:30:00Z`), log: () => {} });
    await sink.upsert('meta_post_ad_spend', rows);
  }
  const written = await sink.flush();
  const stored = fs.readFileSync(path.join(dir, 'meta_post_ad_spend.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  eq('ten nights store one row for the ad', stored.length, 1);
  eq('row holds Ads Manager lifetime totals', [stored[0].spend, stored[0].reach, stored[0].impressions], [79402.19, 23025, 34604]);
  eq('row is dated by delivery, not the window', [stored[0].date_start, stored[0].date_stop], ['2026-11-08', '2026-11-12']);
  eq('row carries the newest collection time', stored[0].collected_at, '2026-11-18T04:30:00.000Z');
  eq('an ad with no page post is not asked for or stored', g.calls.filter((c) => c.params && c.params.filtering).every((c) => !c.params.filtering.includes('ad2')), true);
  eq('lifetime asked with date_preset=maximum, not a window', g.calls.filter((c) => c.params && c.params.filtering).every((c) => c.params.date_preset === 'maximum' && !c.params.time_range), true);
  void written;

  const paged = fakeGraph({ pages: 2 });
  const { rows } = await collectAdSpend({ call: paged.call, lookbackDays: 400, runStarted: new Date('2026-11-18T04:30:00Z'), log: () => {} });
  eq('discovery follows the paging cursor', rows.map((r) => r.ad_id), ['ad1']);

  const denied = await collectAdSpend({ call: async () => ({ ok: false, error: { message: 'no ads_read' } }), lookbackDays: 400, runStarted: new Date(), log: () => {} });
  eq('no ads_read: skipped, nothing written', [denied.skipped, denied.rows.length], [true, 0]);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
