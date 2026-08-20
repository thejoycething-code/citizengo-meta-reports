#!/usr/bin/env node
'use strict';
// Weekly organic performance digest, written for the social media team rather
// than for an analyst: plain language, every number framed against the page's own
// baseline, and honest about what the data cannot say.
//
// One statistical rule enforced here, because it is easy to get wrong and
// impossible to spot afterwards: per-post UNIQUE reach is never summed. Two posts
// reaching 1,000 people each have not reached 2,000 people — the same followers
// see both. Views are additive; people are not. So this reports total views, and
// reports unique reach only per-post.
//
// Usage:
//   node digest/build.js [--page-id ID] [--weeks 2] [--out FILE]

const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../lib/graph');
const { fileStore, supabaseStore } = require('../lib/store');
const { shapeFeed, shapePages, pageBaseline, withBenchmark, median } = require('../lib/shape');

loadEnv();

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 || !args[i + 1] || args[i + 1].startsWith('--') ? fallback : args[i + 1];
};

const WEEKS = Number(opt('weeks', 2));
const PAGE_ID = opt('page-id', null);
const OUT = opt('out', null);

const DAY = 86400000;
const n = (v) => (v === null || v === undefined ? '—' : Math.round(v).toLocaleString('en-GB'));
const pc = (v) => (v === null || v === undefined ? '—' : v.toFixed(1) + '%');
const clean = (s, len) => {
  const one = (s || '(no text)').replace(/\s+/g, ' ').trim();
  return one.length > len ? one.slice(0, len - 1) + '…' : one;
};

function signed(v, suffix = '%') {
  if (v === null || v === undefined) return '—';
  const r = Math.round(v);
  return (r > 0 ? '+' : '') + r + suffix;
}

// Week-over-week on a handful of posts is noisy, and organic reach is so skewed
// that one shared post can swing a weekly total by an order of magnitude. Both
// failure modes are called out rather than presenting a percentage as a trend.
//
// This exists because the first live run reported "views -86%" with no caveat,
// when the whole difference was a single viral post in the earlier week. Read
// cold, that says "we collapsed". It did not.
function shareOfWeek(w) {
  return w.views > 0 ? w.top_views / w.views : 0;
}

function changeNote(thisWeek, lastWeek) {
  if (!lastWeek.posts) return 'No posts the week before, so there is nothing to compare against.';

  const notes = [];
  if (thisWeek.posts < 4 || lastWeek.posts < 4) {
    notes.push(`based on ${thisWeek.posts} posts against ${lastWeek.posts} the week before, which is too few for the change to mean much`);
  }
  const domNow = shareOfWeek(thisWeek);
  const domPrev = shareOfWeek(lastWeek);
  if (domPrev >= 0.5) {
    notes.push(`${Math.round(domPrev * 100)}% of last week's views came from one post, so the drop is that single post ending rather than a fall in normal performance`);
  } else if (domNow >= 0.5) {
    notes.push(`${Math.round(domNow * 100)}% of this week's views came from one post, so the rise is that single post rather than a broad improvement`);
  }
  if (!notes.length) return null;
  return notes.join('; and ').replace(/^./, (c) => c.toUpperCase()) + '.';
}

function windowStats(rows, from, to) {
  const inWindow = rows.filter((r) => {
    const t = new Date(r.created_time).getTime();
    return t >= from && t < to;
  });
  const scored = inWindow.filter((r) => r.has_metrics);
  return {
    posts: inWindow.length,
    scored: scored.length,
    no_metrics: inWindow.length - scored.length,
    views: scored.reduce((a, r) => a + (r.views_total || 0), 0),
    // NOT summed across posts — see the note at the top of this file.
    best_unique: scored.length ? Math.max(...scored.map((r) => r.views_unique || 0)) : null,
    shares: scored.reduce((a, r) => a + (r.shares_total || 0), 0),
    reactions: scored.reduce((a, r) => a + (r.reactions_total || 0), 0),
    med_eng: median(scored.map((r) => r.engagement_rate).filter((v) => v !== null)),
    med_beyond: median(scored.map((r) => r.beyond_followers_pct).filter((v) => v !== null)),
    // The median is what survives an outlier; the total does not.
    med_views: median(scored.map((r) => r.views_total).filter((v) => v !== null)),
    top_views: scored.length ? Math.max(...scored.map((r) => r.views_total || 0)) : 0,
    rows: inWindow,
  };
}

async function main() {
  const store = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
    ? supabaseStore({ url: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_KEY })
    : fileStore({ dir: path.join(__dirname, '..', 'data') });

  const data = await store.loadAll();
  const pages = shapePages(data);
  const page = PAGE_ID ? pages.find((p) => p.page_id === PAGE_ID) : pages[0];
  if (!page) {
    console.error('No pages found. Has the collector run?');
    process.exit(1);
  }

  const feed = shapeFeed(data, { page_id: page.page_id, sort: 'recent' });
  const now = Date.now();
  const thisWeek = windowStats(feed.rows, now - 7 * DAY, now + DAY);
  const lastWeek = windowStats(feed.rows, now - 14 * DAY, now - 7 * DAY);

  // Baseline over the whole collected history, not just this week — a one-week
  // baseline would move with the thing it is meant to measure.
  const base = pageBaseline(feed.rows);
  const scored = thisWeek.rows.filter((r) => r.has_metrics)
    .map((r) => withBenchmark(r, base))
    .sort((a, b) => (b.views_total || 0) - (a.views_total || 0));

  const over = scored.filter((r) => r.benchmark && r.benchmark.views_x_median >= 1.5);
  const under = scored.filter((r) => r.benchmark && r.benchmark.views_x_median < 0.5);
  const carried = scored.filter((r) => r.benchmark && r.benchmark.shares_x_median >= 2);

  const viewsDelta = lastWeek.views > 0 ? ((thisWeek.views - lastWeek.views) / lastWeek.views) * 100 : null;
  const medDelta = (lastWeek.med_views > 0 && thisWeek.med_views !== null)
    ? ((thisWeek.med_views - lastWeek.med_views) / lastWeek.med_views) * 100 : null;
  const weekEnding = new Date(now).toISOString().slice(0, 10);
  const L = [];

  L.push(`# ${page.name} — organic performance`);
  L.push(`Week ending ${weekEnding}`);
  L.push('');

  L.push('## The week in short');
  L.push('');
  L.push(`- **${thisWeek.posts} posts** published, ${n(thisWeek.views)} views in total`);
  L.push(`- Best single post reached **${n(thisWeek.best_unique)} people**`);
  L.push(`- **${n(thisWeek.shares)} shares** and ${n(thisWeek.reactions)} reactions`);
  L.push(`- Typical post: ${pc(thisWeek.med_eng)} engagement rate, ${pc(thisWeek.med_beyond)} of its reach beyond your followers`);
  if (viewsDelta !== null) {
    // The median comparison is the one to trust; the total is shown for
    // completeness because people will add the numbers up themselves otherwise.
    L.push(`- Typical post **${signed(medDelta)}** against the week before (total views ${signed(viewsDelta)})`);
  }
  const caveat = changeNote(thisWeek, lastWeek);
  if (caveat) L.push(`- _${caveat}_`);
  L.push('');

  if (base.reliable) {
    L.push(`For context, a normal post on this page gets **${n(base.median_views)} views** and ${pc(base.median_eng_rate)} engagement. Everything below is measured against that.`);
    L.push('');
  }

  L.push('## What worked');
  L.push('');
  if (!over.length) {
    L.push('Nothing beat the page\'s usual performance by a clear margin this week.');
  } else {
    for (const r of over.slice(0, 5)) {
      L.push(`**${r.benchmark.views_x_median}× a normal post** · ${r.created_time.slice(0, 10)} · ${r.media_type || 'post'}`);
      L.push(`> ${clean(r.message, 180)}`);
      L.push(`${n(r.views_total)} views · ${n(r.views_unique)} people · ${pc(r.beyond_followers_pct)} beyond your followers · ${n(r.shares_total)} shares · ${pc(r.engagement_rate)} engagement`);
      if (r.permalink_url) L.push(`[See the post](${r.permalink_url})`);
      L.push('');
    }
  }

  L.push('## What did not land');
  L.push('');
  if (!under.length) {
    L.push('No post fell well below the usual level this week.');
  } else {
    L.push('These reached well under half what this page normally does. Worth a look at format and timing rather than subject — several are on themes that have worked before.');
    L.push('');
    for (const r of under.slice(0, 5)) {
      L.push(`- **${r.benchmark.views_x_median}×** · ${n(r.views_total)} views · ${clean(r.message, 100)}`);
    }
    L.push('');
  }

  L.push('## The pattern to notice');
  L.push('');
  if (carried.length) {
    const best = carried[0];
    L.push(`${carried.length} post${carried.length > 1 ? 's' : ''} got shared far more than usual, and that is what carried ${carried.length > 1 ? 'them' : 'it'} beyond your existing followers. The clearest case did **${best.benchmark.shares_x_median}× the normal number of shares** and ${pc(best.beyond_followers_pct)} of its reach came from people who do not follow the page.`);
    L.push('');
    L.push('That is the difference between a post being *carried* by supporters and merely being *seen*. Reach beyond followers comes from shares, not from posting more.');
  } else {
    L.push('Nothing was shared unusually heavily this week, so most reach came from people who already follow the page. Posts that travel further tend to be the ones supporters pass on.');
  }
  L.push('');

  L.push('## About these numbers');
  L.push('');
  L.push('- Organic only. Paid reach is reported separately and is not included here.');
  L.push('- "Beyond your followers" is the share of views from people who do not follow the page — the closest thing to a measure of whether a post travelled.');
  L.push('- Views can be added together; **people cannot**. Two posts reaching 1,000 people each have not reached 2,000 different people, so this digest never adds up reach across posts.');
  if (thisWeek.no_metrics) {
    L.push(`- ${thisWeek.no_metrics} post${thisWeek.no_metrics > 1 ? 's' : ''} this week returned no figures from Facebook and ${thisWeek.no_metrics > 1 ? 'are' : 'is'} left out entirely. That is a gap in what Facebook reported, not zero performance.`);
  }
  L.push(`- Covers **${page.name}** only. Other CitizenGO pages need their own access granted before they can appear.`);
  L.push('');
  L.push(`_Generated ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC from ${base.n} posts of collected history._`);

  const out = L.join('\n') + '\n';
  if (OUT) {
    fs.writeFileSync(OUT, out);
    console.error(`digest written to ${OUT} (${out.length} bytes)`);
  } else {
    process.stdout.write(out);
  }
}

main().catch((e) => { console.error('digest failed:', e.message); process.exit(1); });
