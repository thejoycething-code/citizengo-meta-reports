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
  check('says how many posts the window holds', /Showing ranks 1–10 of 101 posts/.test(capped.text));
  // It used to say the rest "cannot be reached", and a model believed it
  // (Miguel's test, 7 Oct 2026). They can: the note must name the next offset.
  check('names the offset that fetches the rest', /`offset: 10`/.test(capped.text));
  check('never claims the rest are unreachable', !/cannot be reached/.test(capped.text));
  const page2 = await callTool(fakeStore, 'top_posts', { page_id: 'p1', days: 90, limit: 100, offset: 100 });
  check('the offset it names reaches the last-ranked post', /\| p1_2 \|/.test(page2.text) && !/more are in the window/.test(page2.text));

  // No note when nothing is hidden - a warning that fires always is ignored.
  const all = await callTool(fakeStore, 'top_posts', { page_id: 'p1', days: 90, limit: 100 });
  const smallStore = {
    ...fakeStore,
    async loadAll() { return { pages: [PAGE], posts: posts.slice(0, 4), metrics: metrics.slice(0, 4) }; },
  };
  const nothingHidden = await callTool(smallStore, 'top_posts', { page_id: 'p1', days: 90, limit: 10 });
  check('no cap note when every post is shown', !/more are in the window/.test(nothingHidden.text));
  check('but the note does appear at limit=100 with 101 posts', /Showing ranks 1–100 of 101/.test(all.text));

  // --- formats -----------------------------------------------------------
  // media_type alone calls every Facebook video "video": 924 of 926
  // added_video posts are /reel/ URLs. The permalink is what separates them.
  const fmtStore = {
    name: 'fake',
    async freshness() { return { latest: '2026-09-20', recentFailures: 0 }; },
    async loadAll() {
      const mk = (id, extra) => ({
        post_id: `p1_${id}`, page_id: 'p1', created_time: '2026-09-01T10:00:00Z',
        message: `post ${id}`, ...extra,
      });
      return {
        pages: [PAGE],
        posts: [
          mk('reel', { permalink_url: 'https://www.facebook.com/reel/123/', media_type: 'video', status_type: 'added_video' }),
          mk('video', { permalink_url: 'https://www.facebook.com/x/videos/9/', media_type: 'video', status_type: 'added_video' }),
          mk('photo', { permalink_url: 'https://www.facebook.com/x/posts/1', media_type: 'photo', status_type: 'added_photos' }),
          mk('album', { permalink_url: 'https://www.facebook.com/x/posts/2', media_type: 'album', status_type: 'added_photos' }),
          mk('link', { permalink_url: 'https://www.facebook.com/x/posts/3', media_type: 'link', status_type: 'shared_story' }),
          mk('text', { permalink_url: 'https://www.facebook.com/x/posts/4', media_type: null, status_type: 'mobile_status_update' }),
        ],
        metrics: ['reel', 'video', 'photo', 'album', 'link', 'text'].map((id, i) => ({
          post_id: `p1_${id}`, collected_date: '2026-09-20',
          views_total: 1000 - i, views_unique: 700, reactions_total: 10,
          shares_total: 2, clicks_total: 3, comments_total: 4,
        })),
      };
    },
  };
  const fmt = await callTool(fmtStore, 'top_posts', { page_id: 'p1', days: 90, limit: 10 });
  for (const [label, want] of [['reel', 'Reel'], ['video', 'Video'], ['photo', 'Photo'],
    ['album', 'Album'], ['link', 'Shared link'], ['text', 'Text']]) {
    const row = fmt.text.split('\n').find((l) => l.includes(`p1_${label} `) || l.includes(`p1_${label}|`) || l.includes(`| p1_${label} |`)) || '';
    check(`${label} is labelled "${want}"`, row.includes(`| ${want} |`), row.slice(0, 95));
  }

  // --- export ------------------------------------------------------------
  // A ranked view can never reach a mid-table post. compact pages through the
  // whole window and must never exceed the 60,000-character response cap.
  let offset = 0; let blocks = 0; let exported = 0; let biggest = 0;
  const seen = new Set();
  for (;;) {
    const out = await callTool(fakeStore, 'top_posts', { page_id: 'p1', days: 90, compact: true, offset });
    const rows = out.text.split('\n').filter((l) => /^\| 20\d\d-/.test(l));
    rows.forEach((r) => seen.add(r));
    exported += rows.length; blocks++;
    biggest = Math.max(biggest, out.text.length);
    const next = out.text.match(/offset: (\d+)/);
    if (!next || blocks > 20) break;
    offset = Number(next[1]);
  }
  check('the export covers every post in the window', exported === 101, `exported ${exported} of 101`);
  check('no row is repeated across blocks', seen.size === exported, `${seen.size} unique of ${exported}`);
  check('every block stays inside the 60,000-character cap', biggest <= 60000, `largest ${biggest}`);
  check('the last block declares the export finished',
    /End of the export/.test((await callTool(fakeStore, 'top_posts',
      { page_id: 'p1', days: 90, compact: true, offset: 100 })).text));

  // --- export rows carry the post text ------------------------------------
  // An export row with only an id could not be identified without opening its
  // link (Scorecard feedback, 29 Sept 2026).
  const firstBlock = await callTool(fakeStore, 'top_posts', { page_id: 'p1', days: 90, compact: true });
  check('export rows carry a linked snippet of the post text',
    /\| \[post number \d+\]\(https:\/\/facebook\.com\/p1_\d+\) \|/.test(firstBlock.text));

  // --- Facebook Reels watch time ------------------------------------------
  // Collected all along, never shown. Appears only when a row has it.
  const watchStore = {
    ...fmtStore,
    async loadAll() {
      const d = await fmtStore.loadAll();
      d.metrics = d.metrics.map((m) => (m.post_id === 'p1_reel' ? { ...m, video_avg_seconds_watched: 14.26 } : m));
      return d;
    },
  };
  const watched = await callTool(watchStore, 'top_posts', { page_id: 'p1', days: 90, limit: 10 });
  const reelRow = watched.text.split('\n').find((l) => l.includes('| p1_reel |')) || '';
  check('Reel rows show average watch time', reelRow.includes('| 14.3s |'), reelRow.slice(-60));
  check('the watch column is explained', /"Avg watch" is Meta/.test(watched.text));
  const watchedExport = await callTool(watchStore, 'top_posts', { page_id: 'p1', days: 90, compact: true });
  check('the export carries watch time too', /\| 14\.3s \|/.test(watchedExport.text));
  check('no watch column when no row has the data', !/Avg watch/.test(fmt.text));

  // --- page_growth takes exact dates --------------------------------------
  let asked = null;
  const growthStore = {
    ...fakeStore,
    async pageGrowth(opts) {
      asked = opts;
      return [
        { page_id: 'p1', page_name: 'Test Page', metric_date: '2026-09-22', daily_follows: 10, daily_unfollows: 2 },
        { page_id: 'p1', page_name: 'Test Page', metric_date: '2026-09-28', daily_follows: 5, daily_unfollows: 1 },
      ];
    },
  };
  const week = await callTool(growthStore, 'page_growth', { page_id: 'p1', since: '2026-09-22', until: '2026-09-28' });
  check('page_growth passes since and until to the store',
    asked && asked.since === '2026-09-22' && asked.until === '2026-09-28', JSON.stringify(asked));
  check('page_growth names the calendar window it covers', /22 Sep 2026 – 28 Sep 2026/.test(week.text));
  check('page_growth nets follows against unfollows over the window', /\| 15 \| 3 \| 12 \|/.test(week.text));
  await callTool(growthStore, 'page_growth', { page_id: 'p1', days: 7 });
  check('a rolling window still sends no until', asked && asked.until === undefined);

  // --- calendar windows ---------------------------------------------------
  // A Mon-Sun week must be exact: a rolling `days` made a model report a
  // week's post count as "42 to 52".
  const weekPosts = [
    { post_id: 'w_before', page_id: 'p1', created_time: '2026-09-27T23:30:00Z', message: 'sunday before' },
    { post_id: 'w_mon', page_id: 'p1', created_time: '2026-09-28T00:10:00Z', message: 'monday' },
    { post_id: 'w_sun', page_id: 'p1', created_time: '2026-10-04T23:50:00Z', message: 'sunday' },
    { post_id: 'w_after', page_id: 'p1', created_time: '2026-10-05T00:05:00Z', message: 'monday after' },
  ];
  const weekStore = {
    ...fakeStore,
    async loadAll() {
      return { pages: [PAGE], posts: weekPosts,
        metrics: weekPosts.map((p, i) => ({ post_id: p.post_id, collected_date: '2026-10-06', views_total: 100 * (i + 1) })) };
    },
  };
  const wk = await callTool(weekStore, 'top_posts', { page_id: 'p1', since: '2026-09-28', until: '2026-10-04' });
  check('since/until keeps exactly the posts published in the week',
    /\| w_mon \|/.test(wk.text) && /\| w_sun \|/.test(wk.text) && !/w_before|w_after/.test(wk.text));
  check('the header states the window and its post count', /28 Sep 2026 – 4 Oct 2026 · 2 posts published in the window/.test(wk.text));

  // --- outliers: per-page baselines and a stated threshold -----------------
  // Two pages, a big one and a small one. Pooled, the small page's posts all
  // fall "below normal"; each must be judged against its own median.
  const BIG = { page_id: 'big', name: 'Big', followers_count: 100000 };
  const SMALL = { page_id: 'small', name: 'Small', followers_count: 1000 };
  const recent = new Date(Date.now() - 5 * 86400000).toISOString();
  const op = []; const om = [];
  const add = (page, id, views) => {
    op.push({ post_id: id, page_id: page, created_time: recent, message: id });
    om.push({ post_id: id, collected_date: '2026-10-06', views_total: views, shares_total: 1 });
  };
  [10000, 10000, 10000, 10000, 25000].forEach((v, i) => add('big', `big_${i}`, v));
  [100, 100, 100, 100, 250].forEach((v, i) => add('small', `small_${i}`, v));
  const oStore = { ...fakeStore, async loadAll() { return { pages: [BIG, SMALL], posts: op, metrics: om }; } };
  const o = await callTool(oStore, 'outliers', {});
  check('outliers judges each page against its own median',
    /\| small_4 \|/.test(o.text) && /\| big_4 \|/.test(o.text) && !/Well below normal[^\n]*— [1-9]/.test(o.text),
    (o.text.match(/Beat normal[^\n]*/) || [''])[0]);
  check('outliers states its rule', /2× or more/.test(o.text) && /0\.5× or less/.test(o.text));
  const o3 = await callTool(oStore, 'outliers', { threshold: 3 });
  check('a higher threshold is honoured', /Beat normal \(3×\+\)\*\* — 0 /.test(o3.text));

  // --- compare_pages: one window for every column --------------------------
  const cmp = await callTool(oStore, 'compare_pages', { days: 30 });
  check('compare_pages carries same-window medians', /Median views\/post/.test(cmp.text) && /\| Big \|[^\n]*\| 10,000 \|/.test(cmp.text));
  const one = await callTool(oStore, 'compare_pages', { days: 30, page_ids: ['small'] });
  check('compare_pages can be narrowed to named pages', /\| Small \|/.test(one.text) && !/\| Big \|/.test(one.text));

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
