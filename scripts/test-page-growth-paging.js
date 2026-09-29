#!/usr/bin/env node
'use strict';
// store.pageGrowth read one request with limit=400, ordered by date ascending.
// An all-pages call over 30 days is ~1,080 rows, so it silently returned the
// OLDEST eleven days and page_growth reported "last 30 days" totals that were
// really the first third of the window. Found 29 Sept 2026.
//
// This stubs fetch with a fake PostgREST that honours limit and offset, and
// checks that every row in the window comes back.

const { supabaseStore } = require('../lib/store');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

// 36 pages x 90 days, as the real store now holds.
const ROWS = [];
for (let d = 0; d < 90; d++) {
  const date = new Date(Date.UTC(2026, 6, 1) + d * 86400000).toISOString().slice(0, 10);
  for (let p = 0; p < 36; p++) ROWS.push({ page_id: `p${String(p).padStart(2, '0')}`, metric_date: date });
}

const requests = [];
global.fetch = async (url) => {
  const u = new URL(url);
  requests.push(u.search);
  let rows = ROWS.slice();
  for (const [k, v] of u.searchParams) {
    if (k !== 'metric_date') continue;
    const [op, val] = v.split('.');
    rows = rows.filter((r) => (op === 'gte' ? r.metric_date >= val : r.metric_date <= val));
  }
  // metric_date appears twice (gte and lte); URLSearchParams iterates both.
  const limit = Number(u.searchParams.get('limit')) || rows.length;
  const offset = Number(u.searchParams.get('offset')) || 0;
  const body = JSON.stringify(rows.slice(offset, offset + limit));
  return { ok: true, status: 200, text: async () => body, headers: new Map() };
};

(async () => {
  console.log('store.pageGrowth paging');
  const store = supabaseStore({ url: 'https://example.test', serviceKey: 'k' });

  const all = await store.pageGrowth({ since: '2026-07-01', until: '2026-09-28' });
  check('returns every row in a 90-day all-pages window', all.length === ROWS.length, `${all.length} of ${ROWS.length}`);
  check('reaches the last day of the window', all.some((r) => r.metric_date === '2026-09-28'));
  check('pages through rather than asking once', requests.length > 1, `${requests.length} request(s)`);

  const month = await store.pageGrowth({ since: '2026-09-01', until: '2026-09-28' });
  check('a 28-day window returns 28 days x 36 pages', month.length === 28 * 36, `${month.length}`);

  let threw = false;
  try { await store.pageGrowth({ since: '2026-07-01', limit: 500 }); } catch (e) { threw = /narrow it/.test(e.message); }
  check('hitting the ceiling throws instead of returning a truncated window', threw);

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
