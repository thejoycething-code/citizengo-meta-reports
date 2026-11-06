#!/usr/bin/env node
'use strict';
// Posts published to several Pages at once, and snapshots that fail after
// earlier good ones (6 Nov 2026, Asana "86 posts with no metrics").
//
// 78 of the 86 were copies: the same Facebook object on UK and Scotland, or on
// CitizenGO and a country Page. Meta keeps one set of numbers, on the original,
// and answers #200 on the copies. Where both had answered, the numbers were the
// same, so counting both doubled the post.

const { shapeFeed, shapePages } = require('../lib/shape');
const { callTool } = require('../mcp/tools.js');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

const pages = [
  { page_id: 'uk', name: 'UK', followers_count: 1000 },
  { page_id: 'sc', name: 'Scotland', followers_count: 100 },
  { page_id: 'gl', name: 'Global', followers_count: 5000 },
];
const post = (page, story, t) => ({ post_id: `${page}_${story}`, page_id: page, created_time: t, message: story });
const err200 = { post_media_view: { code: 200, message: 'Permissions error' } };
const row = (id, day, views, errors = null) => ({ post_id: id, page_id: id.split('_')[0], collected_date: day, views_total: views, reactions_total: views === null ? null : 10, errors });

const posts = [
  // UK original, Scotland copy timestamped FIRST, Scotland once answered then stopped.
  post('sc', '1000000', '2026-10-15T10:00:00Z'), post('uk', '1000000', '2026-10-15T10:05:00Z'),
  // Both copies still answer with the same numbers: earliest wins, other is a copy.
  post('uk', '2000000', '2026-11-05T18:00:00Z'), post('sc', '2000000', '2026-11-05T18:01:00Z'),
  // Global original, UK copy that never answered.
  post('gl', '3000000', '2026-08-06T17:04:00Z'), post('uk', '3000000', '2026-08-06T17:09:00Z'),
  // Single-Page post whose newest snapshot failed with a transient #2.
  post('gl', '4000000', '2026-09-04T09:00:00Z'),
  // Single-Page post that never had numbers: a real gap.
  post('gl', '5000000', '2026-09-05T09:00:00Z'),
  // Ordinary post.
  post('uk', '6000000', '2026-10-01T09:00:00Z'),
];
const metrics = [
  row('sc_1000000', '2026-11-01', 1200), row('sc_1000000', '2026-11-05', null, err200),
  row('uk_1000000', '2026-11-01', 1200), row('uk_1000000', '2026-11-05', 1300),
  row('uk_2000000', '2026-11-06', 50), row('sc_2000000', '2026-11-06', 50),
  row('gl_3000000', '2026-09-28', 900), row('uk_3000000', '2026-09-28', null, err200),
  row('gl_4000000', '2026-10-04', 700), row('gl_4000000', '2026-10-05', null, { post_media_view: { code: 2 } }),
  row('gl_5000000', '2026-10-05', null, err200),
  row('uk_6000000', '2026-10-05', 400),
];
const data = { pages, posts, metrics };
const by = Object.fromEntries(shapeFeed(data).rows.map((r) => [r.post_id, r]));

check('original still answering wins over an earlier-timestamped copy', by['uk_1000000'].has_metrics && by['uk_1000000'].views_total === 1300 && by['sc_1000000'].shared_copy && by['sc_1000000'].original_page_name === 'UK');
check('copy carries no numbers of its own', by['sc_1000000'].views_total === null && by['sc_1000000'].reactions_total === null && !by['sc_1000000'].has_metrics);
check('both answering: earliest is original, the other a copy (no double count)', by['uk_2000000'].views_total === 50 && !by['uk_2000000'].shared_copy && by['sc_2000000'].shared_copy);
check('copy that never answered points at the Global original', by['uk_3000000'].shared_copy && by['uk_3000000'].original_post_id === 'gl_3000000' && by['gl_3000000'].views_total === 900);
check('a failed newest snapshot falls back to the last good one', by['gl_4000000'].has_metrics && by['gl_4000000'].views_total === 700);
check('a post with no good snapshot stays a real gap', !by['gl_5000000'].has_metrics && !by['gl_5000000'].shared_copy);
check('ordinary post untouched', by['uk_6000000'].views_total === 400 && !by['uk_6000000'].shared_copy);

const pg = Object.fromEntries(shapePages(data).map((p) => [p.page_id, p]));
check('Scotland: copies counted apart, not missing', pg.sc.posts_shared_copies === 2 && pg.sc.posts_missing_metrics === 0 && pg.sc.views_total === null);
check('UK: totals exclude its copy of the Global post', pg.uk.views_total === 1300 + 50 + 400 && pg.uk.posts_shared_copies === 1 && pg.uk.posts_missing_metrics === 0);
check('Global: one real gap', pg.gl.posts_missing_metrics === 1);

check('page filter still sees other Pages when spotting copies', shapeFeed(data, { page_id: 'sc' }).rows.every((r) => r.shared_copy));

(async () => {
  const store = { loadAll: async () => data, igCoverage: async () => null, adSpendCoverage: async () => null };
  try {
    const res = await callTool(store, 'data_health', {});
    const d = res.data || {};
    check('data_health splits copies from real gaps', d.missing === 1 && d.shared_copies === 3, JSON.stringify(d));
    check('data_health no longer blames permissions for copies', /several Pages at once: \*\*3\*\*/.test(res.text) && !/\(Meta permissions error\)/.test(res.text));
  } catch (e) {
    check('data_health runs', false, e.message);
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
