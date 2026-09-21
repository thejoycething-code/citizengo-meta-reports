#!/usr/bin/env node
'use strict';
// top_posts, against a fake store. Two defects found on 21 Sept 2026, both of
// which looked fine in the output:
//
//   1. The "vs median" baseline was computed from the rows being DISPLAYED,
//      not from the window, because shapeFeed applies `limit` before returning.
//      Every multiple on the page was measured against the median of the
//      biggest posts on it. On HazteOir over 90 days that read 1,090,875 views
//      instead of 25,757 - a bar forty times too high, on the one column whose
//      whole job is to say whether a post beat its page's normal.
//
//   2. A page with more posts than the row cap said nothing about the ones it
//      could not reach, so a mid-table post looked absent rather than unranked.

const { callTool } = require('../mcp/tools.js');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

// 101 posts: one runaway, a hundred ordinary ones. The median of the whole set
// is ~50; the median of the top 5 is far higher. That gap is the bug.
const PAGE = { page_id: 'p1', name: 'Test Page', followers_count: 1000 };
const posts = [];
const metrics = [];
for (let i = 1; i <= 101; i++) {
  const views = i === 1 ? 5000000 : i * 100;      // one giant, the rest linear
  posts.push({
    post_id: `p1_${i}`, page_id: 'p1',
    created_time: '2026-09-01T10:00:00Z',
    message: `post number ${i}`, permalink_url: `https://facebook.com/p1_${i}`,
  });
  metrics.push({
    post_id: `p1_${i}`, collected_date: '2026-09-20', views_total: views,
    views_unique: Math.round(views * 0.7), views_from_nonfollowers: Math.round(views * 0.3),
    reactions_total: i, shares_total: i, clicks_total: i, comments_total: i,
  });
}

const fakeStore = {
  name: 'fake',
  async freshness() { return { latest: '2026-09-20', recentFailures: 0 }; },
  async loadAll() { return { pages: [PAGE], posts, metrics }; },
};

// The median of views_total over all 101 posts, computed independently of the
// code under test.
const allViews = metrics.map((m) => m.views_total).sort((a, b) => a - b);
const trueMedian = allViews.length % 2
  ? allViews[(allViews.length - 1) / 2]
  : (allViews[allViews.length / 2 - 1] + allViews[allViews.length / 2]) / 2;

(async () => {
  console.log('top_posts');
  console.log(`  (true median across all ${allViews.length} posts: ${trueMedian.toLocaleString('en-GB')})`);

  const medians = [];
  for (const limit of [5, 10, 100]) {
    const out = await callTool(fakeStore, 'top_posts', { page_id: 'p1', days: 90, limit });
    const m = out.text.match(/median of ([\d,]+) views/);
    medians.push(m ? Number(m[1].replace(/,/g, '')) : null);
    check(`limit=${limit} reports the window median, not the median of the rows shown`,
      medians[medians.length - 1] === trueMedian,
      `got ${m ? m[1] : 'no median'}`);
  }
  check('the baseline does not move when the row count does',
    new Set(medians).size === 1, `medians seen: ${medians.join(', ')}`);

  // The cap has to declare itself, and name the way round it.
  const capped = await callTool(fakeStore, 'top_posts', { page_id: 'p1', days: 90, limit: 10 });
  check('says how many posts the window holds', /Showing 10 of 101 posts/.test(capped.text));
  check('says the rest cannot be reached by re-sorting', /cannot be reached by changing the sort/.test(capped.text));
  check('names search_posts as the rank-independent route', /search_posts/.test(capped.text));

  // No note when nothing is hidden - a warning that fires always is ignored.
  const all = await callTool(fakeStore, 'top_posts', { page_id: 'p1', days: 90, limit: 100 });
  const smallStore = {
    ...fakeStore,
    async loadAll() { return { pages: [PAGE], posts: posts.slice(0, 4), metrics: metrics.slice(0, 4) }; },
  };
  const nothingHidden = await callTool(smallStore, 'top_posts', { page_id: 'p1', days: 90, limit: 10 });
  check('no cap note when every post is shown', !/cannot be reached/.test(nothingHidden.text));
  check('but the note does appear at limit=100 with 101 posts', /Showing 100 of 101/.test(all.text));

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
