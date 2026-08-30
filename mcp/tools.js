'use strict';
// Tool implementations. Every one of these goes through lib/shape.js, which is
// the whole point of exposing tools instead of a SQL connection:
//
//   * meta_post_metrics is APPEND-ONLY — one row per post per collection day.
//     A raw `SUM(views_total)` multiplies every post by the number of days it
//     has been collected. shapeFeed() reduces to the latest snapshot per post
//     before anything is added up.
//   * NULL means "Meta refused this metric", not zero. Averaging over it, or
//     coalescing it to 0, silently understates performance.
//   * Page cards use medians, because one 2M-view post otherwise defines the
//     average for a whole page.
//
// An LLM given raw tables gets all three wrong, confidently. These tools cannot.

const { shapeFeed, shapePages, pageBaseline, withBenchmark } = require('../lib/shape');

const METRIC_LABELS = {
  views: 'Views', reach: 'Unique reach', beyond: 'Reach beyond followers',
  engagement: 'Engagement', rate: 'Engagement rate', shares: 'Shares', recent: 'Most recent',
};

function sinceFor(days) {
  if (!days || days <= 0) return undefined;
  return new Date(Date.now() - days * 86400000).toISOString();
}

const n = (v) => (v === null || v === undefined ? '—' : v.toLocaleString('en-GB'));
const p = (v) => (v === null || v === undefined ? '—' : v.toFixed(1) + '%');

function table(headers, rows) {
  if (!rows.length) return '_No rows._';
  const head = `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |`;
  return head + '\n' + rows.map((r) => `| ${r.join(' | ')} |`).join('\n');
}

// Markdown link when we have a permalink, plain text otherwise. Keeps the table
// readable while making every row clickable.
function postLink(r, label) {
  const safe = String(label).replace(/\|/g, '\\|').replace(/\]/g, ')');
  return r.permalink_url ? `[${safe}](${r.permalink_url})` : safe;
}

function truncate(s, len) {
  const one = (s || '(no text)').replace(/\s+/g, ' ');
  return one.length > len ? one.slice(0, len - 1) + '…' : one;
}

// Appended wherever numbers are shown, so the model reports gaps rather than
// quietly presenting partial data as complete.
function gapNote(rows) {
  const missing = rows.filter((r) => !r.has_metrics).length;
  if (!missing) return '';
  return `\n\n_${missing} of ${rows.length} posts have no metrics: Meta returned a permissions error for them. `
    + `They are shown as "—" and excluded from totals. This is a data gap, not zero performance._`;
}

async function listPages(store) {
  const data = await store.loadAll();
  const pages = shapePages(data);
  const rows = pages.map((g) => [
    g.name, g.page_id, n(g.followers_count), n(g.posts),
    g.posts_missing_metrics ? `${g.posts_missing_metrics} missing` : 'complete',
    n(g.views_total), p(g.median_engagement_rate), p(g.median_beyond_followers_pct),
  ]);
  return {
    text: `**Pages currently collected** (${pages.length})\n\n`
      + table(['Page', 'ID', 'Followers', 'Posts', 'Data', 'Total views', 'Median eng. rate', 'Median beyond followers'], rows)
      + `\n\n_Coverage note: only pages whose Business Portfolio has granted read access appear here. `
      + `Pages missing from this list are an access gap, not inactive pages._`,
    data: pages,
  };
}

async function topPosts(store, { page_id, days: d = 30, sort = 'views', limit: l = 10 }) {
  const days = clampDays(d, 30); const limit = clampRows(l, 10, 100);
  const data = await store.loadAll();
  if (page_id && !data.pages.some((g) => g.page_id === page_id)) {
    return {
      text: `Page ${page_id} is not being collected, so there is no data for it — this is not the same as the page having no posts. Call list_pages to see which pages are available.`,
      data: null,
    };
  }
  const feed = shapeFeed(data, {
    page_id, since: sinceFor(days), sort, limit, with_metrics_only: false,
  });
  // Baseline from the same window, so "vs median" compares like with like.
  const base = pageBaseline(feed.rows);
  const rows = feed.rows.map((r) => withBenchmark(r, base)).map((r) => [
    r.created_time.slice(0, 10), r.page_name, postLink(r, truncate(r.message, 62)),
    n(r.views_total), n(r.views_unique), p(r.beyond_followers_pct),
    n(r.reactions_total), n(r.shares_total), p(r.engagement_rate),
    r.benchmark && r.benchmark.views_x_median !== null ? r.benchmark.views_x_median + '×' : '—',
  ]);
  const label = METRIC_LABELS[sort] || sort;
  return {
    text: `**Top ${feed.rows.length} posts by ${label}**`
      + `${page_id ? '' : ' (all pages)'}${days ? ` · last ${days} days` : ' · all time'}\n\n`
      + table(['Date', 'Page', 'Post', 'Views', 'Unique', 'Beyond followers', 'Reactions', 'Shares', 'Eng. rate', 'vs median', 'Post ID'],
        rows.map((row, i) => row.concat([feed.rows[i].post_id])))
      + (base.reliable
        ? `\n\n_"vs median" compares each post to this page's own median of ${n(base.median_views)} views over the same window. A raw view count says nothing on its own._`
        : `\n\n_Too few posts with metrics (${base.n}) to establish a baseline, so no comparison is shown._`)
      + gapNote(feed.rows),
    data: { ...feed, baseline: base },
  };
}

async function pageSummary(store, { page_id, days: d = 30 }) {
  const days = clampDays(d, 30);
  const data = await store.loadAll();
  const all = shapePages(data);
  const page = all.find((g) => g.page_id === page_id);
  if (!page) {
    return { text: `No page with id ${page_id} is being collected. Use list_pages to see what is available.`, data: null };
  }
  const feed = shapeFeed(data, { page_id, since: sinceFor(days), sort: 'views' });
  const scored = feed.rows.filter((r) => r.has_metrics);
  const best = scored[0];
  const widest = [...scored].sort((a, b) => (b.beyond_followers_pct ?? -1) - (a.beyond_followers_pct ?? -1))[0];

  const lines = [
    `**${page.name}** · ${n(page.followers_count)} followers · last ${days} days`,
    '',
    `- Posts published: **${feed.rows.length}** (${scored.length} with metrics)`,
    `- Total views: **${n(scored.reduce((a, r) => a + (r.views_total || 0), 0))}**`,
    `- Median engagement rate: **${p(page.median_engagement_rate)}**`,
    `- Median reach beyond followers: **${p(page.median_beyond_followers_pct)}**`,
  ];
  if (best) lines.push('', `Best performing by views: ${postLink(best, '"' + truncate(best.message, 90) + '"')} — ${n(best.views_total)} views, ${p(best.engagement_rate)} engagement rate. \`${best.post_id}\``);
  if (widest) lines.push(`Travelled furthest beyond followers: ${postLink(widest, '"' + truncate(widest.message, 90) + '"')} — ${p(widest.beyond_followers_pct)} of views came from non-followers. \`${widest.post_id}\``);
  return { text: lines.join('\n') + gapNote(feed.rows), data: { page, posts: feed.total } };
}

async function comparePages(store, { days: d = 30 }) {
  const days = clampDays(d, 30);
  const data = await store.loadAll();
  const pages = shapePages(data);
  let anyIncomplete = false;
  // Ordered by views. The rows arrived in whatever order the store returned them,
  // which for a COMPARISON table is a trap: the first row reads as the best one,
  // and it was arbitrary — 20.5m views sat above 4.8m sat above 3.0m.
  const rows = pages.map((g) => {
    const feed = shapeFeed(data, { page_id: g.page_id, since: sinceFor(days) });
    const scored = feed.rows.filter((r) => r.has_metrics);
    const missing = feed.rows.length - scored.length;
    if (missing) anyIncomplete = true;
    // null, not 0, when nothing is measurable — a page with no usable posts has
    // NO figure, and printing 0 would rank it as the worst performer.
    const views = scored.length ? scored.reduce((a, r) => a + (r.views_total || 0), 0) : null;
    const eng = scored.length ? scored.reduce((a, r) => a + (r.engagement_total || 0), 0) : null;
    return [
      g.name, n(g.followers_count),
      missing ? `${feed.rows.length} (${missing} no data)` : n(feed.rows.length),
      n(views), n(eng),
      views ? p((eng / views) * 100) : '—',
      // Views per follower: the fair cross-page comparison, since a 28-follower
      // page and a 117k-follower page are not comparable on raw totals.
      (views && g.followers_count) ? (views / g.followers_count).toFixed(1) + '×' : '—',

      // Index 7: the unformatted figure the sort uses. Trimmed off before display.

      views,
    ];
  });
  // Sort on the raw number, not the formatted string — "9,157" sorts above

  // "20,501,220" lexically. Pages with nothing measurable go last rather than

  // being ranked as the worst.

  const sortedRows = [...rows].sort((x, y) => (y[7] || -1) - (x[7] || -1))

    .map((r) => r.slice(0, 7));


  return {
    text: `**Page comparison · last ${days} days**\n\n`
      + table(['Page', 'Followers', 'Posts', 'Views', 'Engagement', 'Eng. rate', 'Views per follower'], sortedRows)
      + `\n\n_"Views per follower" is the fairer cross-page comparison — raw totals just rank pages by audience size._`
      + (anyIncomplete
        ? `\n\n_**Compare with care:** pages marked "no data" have posts Meta refused to report on, so their totals are understated by an unknown amount. Do not rank pages against each other without saying so._`
        : ''),
    data: pages,
  };
}

// Instagram was invisible in data_health, so the only way to know whether it had
// metrics was to query the database by hand - and doing that against the latest
// collected_date, which may be a small targeted run rather than the last full
// one, reports zero coverage for accounts that are fully collected.
async function igLine(store) {
  if (typeof store.igCoverage !== 'function') return null;
  let c;
  try { c = await store.igCoverage(); } catch (e) { return null; }
  if (!c || !c.hasMedia) return '- Instagram: **not collected**';
  if (!c.total) return '- Instagram: posts collected, **no metrics yet** (needs instagram_manage_insights)';
  return `- Instagram: **${c.withReach} of ${c.total}** posts have reach, as of ${c.latest}`;
}

async function dataHealth(store) {
  const igStatus = (await igLine(store)) || '- Instagram: status unavailable';
  const data = await store.loadAll();
  const feed = shapeFeed(data, {});
  const pages = shapePages(data);
  const missing = feed.rows.filter((r) => !r.has_metrics);
  const partial = feed.rows.filter((r) => r.has_metrics && r.partial);
  const noComments = feed.rows.filter((r) => r.comments_total === null).length;
  const dates = feed.rows.map((r) => r.created_time.slice(0, 10)).sort();

  return {
    text: [
      '**Data health**',
      '',
      `- Pages collected: **${pages.length}**`,
      `- Posts: **${feed.total}**, covering ${dates[0] || '—'} to ${dates[dates.length - 1] || '—'}`,
      `- Posts with no metrics at all: **${missing.length}** (Meta permissions error)`,
      `- Posts missing only unique reach: **${partial.length}** (Meta suppresses it on low-follower pages)`,
      noComments
        ? `- Posts with no comment count: **${noComments}** (needs the pages_read_user_content scope)`
        : '- Comment counts: **complete** on every post',
      igStatus,
      '',
      'Known limitations to state when reporting:',
      '- **Reactions** are Meta\'s `reactions` count on the post itself — the number Facebook shows you on the post. Meta also publishes `post_reactions_by_type_total`, a lifetime insights figure that additionally counts reactions on reshares; measured across 406 posts it runs about 22% higher on posts that were shared and matches exactly on posts that were not. This tool reports the first, so figures line up with what you see. A small difference is timing — these are a nightly snapshot and people keep reacting.',
      '- Paid vs organic split comes from a breakdown, not a dedicated metric; all `post_impressions*` metrics were retired by Meta in 2026.',
      '- Only pages whose Business Portfolio granted read access are present. Absent pages are an access gap.',
      '- Metrics are a daily snapshot; engagement on recent posts is still accruing and will rise.',
    ].join('\n'),
    data: { pages: pages.length, posts: feed.total, missing: missing.length, partial: partial.length },
  };
}

// Enough to see the pattern, few enough to read. Before this cap the tool
// returned every post more than 1.5x or under 0.5x the median - which on a
// 90-day window across 36 pages was 2,225 lines and 439,000 characters, most of
// it posts that were unremarkable in the ordinary way.
// Caller-supplied bounds, clamped rather than trusted.
//
// These were defaults, not maximums. The 25-row cap on outliers existed because
// that tool once returned 439,241 characters, but {"limit": 100000} restored the
// original behaviour, and every tool advertises both parameters in its input
// schema - so a client did not even have to guess.
const clampRows = (v, dflt, max = 200) =>
  Math.min(Math.max(Math.floor(Number(v)) || dflt, 1), max);
const clampDays = (v, dflt) =>
  Math.min(Math.max(Math.floor(Number(v)) || dflt, 1), 400);

const OUTLIER_ROWS = 25;

async function outliers(store, { page_id, days: d = 90, limit: l = OUTLIER_ROWS }) {
  const days = clampDays(d, 90); const limit = clampRows(l, OUTLIER_ROWS, 100);
  const data = await store.loadAll();
  const feed = shapeFeed(data, { page_id, since: sinceFor(days), sort: 'views' });
  const base = pageBaseline(feed.rows);
  if (!base.reliable) {
    return {
      text: `Only ${base.n} post(s) with metrics in the last ${days} days — not enough to say what "normal" looks like for this page, so nothing can be called an outlier yet. Collect more history first.`,
      data: null,
    };
  }
  const scored = feed.rows.filter((r) => r.has_metrics).map((r) => withBenchmark(r, base));
  // Most extreme first, so a cap keeps the interesting end rather than whichever
  // posts happened to sort first.
  const over = scored.filter((r) => r.benchmark.views_x_median >= 1.5)
    .sort((a, b) => b.benchmark.views_x_median - a.benchmark.views_x_median);
  const under = scored.filter((r) => r.benchmark.views_x_median < 0.5)
    .sort((a, b) => a.benchmark.views_x_median - b.benchmark.views_x_median);

  // Say what was left out. A silent cap reads as "this is all of them", which is
  // how a partial answer gets quoted as a complete one.
  const shown = (rows) => rows.slice(0, limit);
  const omitted = (rows) => (rows.length > limit
    ? `\n\n_Showing the ${limit} most extreme of ${n(rows.length)}. Ask for a single page, a shorter window, or a higher limit to see more._`
    : '');

  const fmt = (r) => [
    r.created_time.slice(0, 10),
    r.benchmark.views_x_median + '×',
    n(r.views_total),
    n(r.shares_total),
    r.benchmark.shares_x_median !== null ? r.benchmark.shares_x_median + '×' : '—',
    p(r.engagement_rate),
    postLink(r, truncate(r.message, 52)),
    r.post_id,
  ];
  const head = ['Date', 'vs median', 'Views', 'Shares', 'Shares vs med', 'Eng. rate', 'Post', 'Post ID'];

  return {
    text: [
      `**What normal looks like** · last ${days} days · ${base.n} posts with metrics`,
      '',
      `- Median views: **${n(base.median_views)}** · 90th percentile: **${n(base.p90_views)}**`,
      `- Median engagement rate: **${p(base.median_eng_rate)}**`,
      `- Median reach beyond followers: **${p(base.median_beyond_pct)}**`,
      `- Median shares: **${n(base.median_shares)}**`,
      '',
      `**Broke away from normal** (${over.length})`,
      '',
      over.length ? table(head, shown(over).map(fmt)) + omitted(over) : '_None._',
      '',
      `**Well below normal** (${under.length})`,
      '',
      under.length ? table(head, shown(under).map(fmt)) + omitted(under) : '_None._',
      '',
      '_Shares are usually what separates the two: a post reaches beyond its followers when supporters carry it, not when the page posts it._',
    ].join('\n') + gapNote(feed.rows),
    data: { baseline: base, over: over.length, under: under.length },
  };
}

// Text search across post copy. Uses the store's server-side filter rather than
// loading every post, because at 36 pages over 90 days that is thousands of rows
// per call.
//
// Results are ranked by REACH, not relevance. A campaigner asking "how did our
// marriage posts do" wants the ones that travelled, not the ones that mention the
// word most often — and Meta gives us no relevance signal anyway.
async function searchPosts(store, { query, page_id, days: d = 0, limit: l = 15 }) {
  const days = Math.min(Math.max(Math.floor(Number(d)) || 0, 0), 400); const limit = clampRows(l, 15, 100);
  if (!query || !String(query).trim()) {
    return { text: 'Give a search term — a word or phrase that appears in the post text.', data: null };
  }
  const rows = await store.searchPosts({
    q: query, page_id, since: sinceFor(days), limit,
  });

  if (!rows.length) {
    return {
      text: `No posts matching "${query}"${page_id ? ' on that page' : ''}${days ? ` in the last ${days} days` : ''}.\n\n`
        + '_Only collected pages are searchable, and only the period that has been collected. '
        + 'A blank result may mean the post exists but has not been collected, rather than that it was never written._',
      data: null,
    };
  }

  const table_ = table(
    ['Date', 'Page', 'Post', 'Reach', 'Views', 'Beyond followers', 'Shares', 'Comments', 'Eng. rate', 'Post ID'],
    rows.map((r) => [
      (r.created_time || '').slice(0, 10),
      r.page_name || '—',
      postLink(r, truncate(r.message, 62)),
      n(r.views_unique),
      n(r.views_total),
      r.views_total > 0 ? p((r.views_from_nonfollowers / r.views_total) * 100) : '—',
      n(r.shares_total), n(r.comments_total),
      r.engagement_rate_pct !== null && r.engagement_rate_pct !== undefined
        ? p(Number(r.engagement_rate_pct)) : '—',
      r.post_id,
    ])
  );

  return {
    text: `**${rows.length} post${rows.length === 1 ? '' : 's'} matching "${query}"**`
      + `${page_id ? ' on one page' : ' across all collected pages'}`
      + `${days ? ` · last ${days} days` : ''} · ranked by reach\n\n`
      + table_
      + '\n\n_Matches the post text only. Ranked by how many people each reached, not by relevance._',
    data: rows,
  };
}

// Page-level trend, as opposed to individual post performance. Answers "are we
// growing" rather than "did this post work".
async function pageGrowth(store, { page_id, days: d = 30 }) {
  const days = clampDays(d, 30);
  const rows = await store.pageGrowth({ page_id, since: sinceFor(days) });
  if (!rows || !rows.length) {
    return {
      text: 'No page-level data yet. It is collected alongside posts, so it appears after the next collection run.',
      data: null,
    };
  }

  // Group by page and report the window's movement rather than every day —
  // 30 rows per page across 36 pages would be unreadable.
  const byPage = new Map();
  for (const r of rows) {
    if (!byPage.has(r.page_id)) byPage.set(r.page_id, []);
    byPage.get(r.page_id).push(r);
  }

  const summary = [...byPage.values()].map((series) => {
    series.sort((a, b) => (a.metric_date < b.metric_date ? -1 : 1));
    const first = series[0];
    const last = series[series.length - 1];
    const sum = (k) => {
      const vals = series.map((x) => x[k]).filter((v) => typeof v === 'number');
      return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
    };
    const startF = first.followers_snapshot;
    const endF = last.followers_snapshot;
    return {
      name: last.page_name,
      days: series.length,
      followers: endF,
      // Only meaningful once there are snapshots from different days; on a
      // single collection every snapshot is identical, so this reads 0 rather
      // than pretending to be a trend.
      followerChange: (typeof startF === 'number' && typeof endF === 'number') ? endF - startF : null,
      views: sum('views_total'),
      reach: sum('media_view_unique'),
      engagements: sum('post_engagements'),
      newFollows: sum('daily_follows'),
    };
  }).sort((a, b) => (b.views || 0) - (a.views || 0));

  return {
    text: `**Page-level trend · last ${days} days**\n\n`
      + table(
        ['Page', 'Days', 'Followers', 'Page views', 'Reach', 'Engagements', 'New follows'],
        summary.map((s) => [
          s.name, s.days, n(s.followers),
          n(s.views), n(s.reach), n(s.engagements), n(s.newFollows),
        ])
      )
      + '\n\n_Page-level figures, not post totals: page views include profile visits, and reach counts people who saw anything from the page. '
      + '"New follows" is Meta\'s own daily metric and is the reliable growth figure. It counts NEW follows only — Meta does not report unfollows, so it is gross rather than net. '
      + 'The follower count is as at the last collection, not as at each date, which is why no net change is shown: a backfill stamps every row with one day\'s number._',
    data: summary,
  };
}


async function instagramPosts(store, { page_id, days: d = 30, sort = 'reach', limit: l = 15 }) {
  const days = clampDays(d, 30); const limit = clampRows(l, 15, 100);
  const rows = await store.igMedia({ page_id, since: sinceFor(days), sort, limit });
  if (!rows || !rows.length) {
    return {
      text: 'No Instagram data yet.\n\n_Instagram needs `instagram_basic` and `instagram_manage_insights` on the token, and the account must be a Business or Creator account linked to the Facebook Page. A personal Instagram account exposes no insights at all, whatever the token allows._',
      data: null,
    };
  }
  const label = { reach: 'reach', saved: 'saves', views: 'views', interactions: 'interactions', recent: 'most recent' }[sort] || sort;
  return {
    text: `**Top ${rows.length} Instagram posts by ${label}**${days ? ` · last ${days} days` : ''}\n\n`
      + table(
        ['Date', 'Account', 'Post', 'Type', 'Reach', 'Views', 'Saves', 'Saves/1k', 'Interactions', 'Rate'],
        rows.map((r) => [
          (r.timestamp || '').slice(0, 10),
          r.ig_username ? '@' + r.ig_username : (r.page_name || '—'),
          r.permalink ? `[${truncate(r.caption, 52).replace(/\|/g, '\\|')}](${r.permalink})` : truncate(r.caption, 52),
          r.media_product_type || r.media_type || '—',
          n(r.reach), n(r.views), n(r.saved),
          r.saves_per_1k_reached !== null && r.saves_per_1k_reached !== undefined ? Number(r.saves_per_1k_reached).toFixed(1) : '—',
          n(r.total_interactions),
          r.interaction_rate_pct !== null && r.interaction_rate_pct !== undefined ? p(Number(r.interaction_rate_pct)) : '—',
        ])
      )
      + '\n\n_Saves per 1,000 reached is the intent signal worth watching: saving a post is a deliberate act in a way a like is not, and Facebook has no equivalent metric._',
    data: rows,
  };
}

async function adSpend(store, { page_id, days: d = 90, limit: l = 20 }) {
  const days = clampDays(d, 90); const limit = clampRows(l, 20, 100);
  const rows = await store.adSpend({ page_id, since: sinceFor(days), limit });
  if (!rows || !rows.length) {
    return {
      text: 'No boosted posts found.\n\n_Ad spend needs `ads_read` on the token, and only posts that were actually promoted appear here. An organic-only page will always be empty._',
      data: null,
    };
  }
  // Spend is in whatever currency each ad account bills in — this estate uses
    // seven. Summing them gives a number that means nothing, and labelling that
    // sum with the first row's currency makes it look like it does: this reported
    // "ARS 141431.18 total" for a mix of ARS, GBP, CAD and AUD.
    //
    // Ranking had the same flaw and it mattered more. Sorted by raw spend, a
    // 139,207 ARS boost (about GBP 100) outranked a genuine GBP 658 one purely
    // because the number is larger. Ordered by paid reach instead: currency
    // neutral, and closer to the question being asked.
    const byCurrency = new Map();
    for (const r of rows) {
      const c = r.currency || '?';
      byCurrency.set(c, (byCurrency.get(c) || 0) + (Number(r.total_spend) || 0));
    }
    const multi = byCurrency.size > 1;
    const totals = [...byCurrency.entries()].sort((a, b) => b[1] - a[1])
      .map(([c, v]) => `${c} ${v.toLocaleString('en-GB', { maximumFractionDigits: 0 })}`)
      .join(' · ');
    const sorted = [...rows].sort((a, b) => (b.ad_reach || 0) - (a.ad_reach || 0));
  return {
    text: `**Boosted posts · last ${days} days** · ${rows.length} post${rows.length === 1 ? '' : 's'}\n\nSpend by currency: ${totals}${multi ? '. These are **not** added together — different ad accounts bill in different currencies, so one total would be meaningless.' : '.'}\n\n`
      + table(
        ['Date', 'Page', 'Post', 'Spend', 'Paid reach', 'Cost/1k', 'Organic views', 'Paid views', 'Organic:paid'],
        sorted.map((r) => [
          (r.created_time || '').slice(0, 10),
          r.page_name || '—',
          r.permalink_url ? `[${truncate(r.message, 44).replace(/\|/g, '\\|')}](${r.permalink_url})` : truncate(r.message, 44),
          r.total_spend !== null ? `${r.currency || ''} ${Number(r.total_spend).toFixed(2)}` : '—',
          n(r.ad_reach), 
          r.cost_per_1k_reached !== null && r.cost_per_1k_reached !== undefined ? Number(r.cost_per_1k_reached).toFixed(2) : '—',
          n(r.views_organic), n(r.views_paid),
          r.organic_to_paid_ratio !== null && r.organic_to_paid_ratio !== undefined ? Number(r.organic_to_paid_ratio).toFixed(2) + '×' : '—',
        ])
      )
      + (multi ? '\n\n_Ordered by paid reach, not spend: amounts in different currencies cannot be ranked against each other._' : '')
        + '\n\n_"Organic:paid" is how much reach the post earned for free against what was paid for. Above 1 means the free half did more work than the money did — those are the posts worth studying, and arguably the ones worth boosting harder._',
    data: rows,
  };
}

const TOOLS = [
  {
    name: 'list_pages',
    description: 'List every Facebook page currently being collected, with follower counts, post counts, data completeness and headline medians. Call this first if you do not know which pages exist or need a page_id.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (store) => listPages(store),
  },
  {
    name: 'top_posts',
    description: 'Rank organic posts by a chosen metric. Use this to answer "which of our posts performed best". Sort by "beyond" to find posts that spread furthest past existing followers — usually the most useful measure of whether content travelled, as opposed to merely reaching people who already follow the page.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'Restrict to one page. Omit for all pages. Get ids from list_pages.' },
        days: { type: 'number', description: 'Look back this many days (default 30). Use 0 for all collected data.' },
        sort: { type: 'string', enum: ['views', 'reach', 'beyond', 'engagement', 'rate', 'shares', 'recent'], description: 'Ranking metric (default views).' },
        limit: { type: 'number', description: 'How many posts to return (default 10).' },
      },
      additionalProperties: false,
    },
    handler: (store, args) => topPosts(store, args),
  },
  {
    name: 'page_summary',
    description: 'Headline performance for a single page over a period, including its best post and the post that travelled furthest beyond its followers. Use for "how did <page> do last month".',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'The page to summarise. Get ids from list_pages.' },
        days: { type: 'number', description: 'Look back this many days (default 30).' },
      },
      required: ['page_id'],
      additionalProperties: false,
    },
    handler: (store, args) => pageSummary(store, args),
  },
  {
    name: 'compare_pages',
    description: 'Compare every collected page over the same period, including views per follower — the fair comparison across pages of very different audience sizes. Use for "which country page is doing best".',
    inputSchema: {
      type: 'object',
      properties: { days: { type: 'number', description: 'Look back this many days (default 30).' } },
      additionalProperties: false,
    },
    handler: (store, args) => comparePages(store, args),
  },
  {
    name: 'search_posts',
    description: 'Search the text of collected posts across every page and return them ranked by reach. Use this whenever someone asks about a topic, campaign or specific post rather than about a page overall — "how did our marriage posts do", "what did we publish about assisted dying", "find the Sarah Morse posts". Searches post copy only, not comments.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Word or phrase appearing in the post text. Case-insensitive.' },
        page_id: { type: 'string', description: 'Restrict to one page. Omit to search every collected page.' },
        days: { type: 'number', description: 'Only posts from the last N days. Omit or 0 for all collected history.' },
        limit: { type: 'number', description: 'Maximum posts to return (default 15, max 200).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: (store, args) => searchPosts(store, args),
  },
  {
    name: 'outliers',
    description: 'Establish what "normal" looks like for a page (median views, engagement rate, shares) and list the posts that broke away from it or fell well below. Use this to answer "was this post actually good", "what worked", or "why did this one do so well" — a raw view count is meaningless without the page baseline to compare it against.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'Restrict to one page. Omit for all pages.' },
        days: { type: 'number', description: 'Window to compute the baseline over (default 90). A longer window gives a steadier baseline.' },
        limit: { type: 'number', description: 'How many posts to list at each end (default 25). The count of any left out is always stated.' },
      },
      additionalProperties: false,
    },
    handler: (store, args) => outliers(store, args),
  },
  {
    name: 'page_growth',
    description: 'Page-level trend over time: followers and how they changed, page views, total page reach, engagements and new follows. Use this for "are we growing", "how is this page trending" or "which pages are gaining followers" — as opposed to how any individual post did.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'Restrict to one page. Omit for every collected page.' },
        days: { type: 'number', description: 'Window in days (default 30).' },
      },
      additionalProperties: false,
    },
    handler: (store, args) => pageGrowth(store, args),
  },
  {
    name: 'instagram_posts',
    description: 'Top Instagram posts by reach, saves, views or interactions. Use for any question about Instagram rather than Facebook. Saves are the notable metric here — Facebook has no equivalent, and saving a post signals far more intent than a like.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'Restrict to the Instagram account linked to this Facebook page id.' },
        days: { type: 'number', description: 'Look back this many days (default 30, 0 for all).' },
        sort: { type: 'string', enum: ['reach', 'saved', 'views', 'interactions', 'recent'], description: 'Ranking metric (default reach).' },
        limit: { type: 'number', description: 'How many posts (default 15).' },
      },
      additionalProperties: false,
    },
    handler: (store, args) => instagramPosts(store, args),
  },
  {
    name: 'ad_spend',
    description: 'Posts that were boosted, with what they cost and how paid reach compares to what the post earned organically. Use for "what did we spend on this", "which boosts were worth it", "cost per person reached". Only promoted posts appear.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'Restrict to one page.' },
        days: { type: 'number', description: 'Look back this many days (default 90).' },
        limit: { type: 'number', description: 'How many posts (default 20).' },
      },
      additionalProperties: false,
    },
    handler: (store, args) => adSpend(store, args),
  },
  {
    name: 'data_health',
    description: 'Report coverage and known gaps: how many posts lack metrics and why, which scopes are missing, and what caveats to state when reporting. Call this before presenting numbers as complete, and whenever a total looks surprisingly low.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (store) => dataHealth(store),
  },
];

// How old the data may be before a caller is warned. Collection runs nightly,
// so two days means one missed run passes quietly and two does not.
const STALE_AFTER_DAYS = 2;

async function freshnessBanner(store) {
  if (typeof store.freshness !== 'function') return '';
  let f;
  try {
    f = await store.freshness();
  } catch (e) {
    // Never let the freshness check break the answer it is annotating.
    return '';
  }
  if (!f || !f.latest) {
    return '**No data has been collected yet.** Everything below will be empty.\n\n';
  }
  const days = Math.floor((Date.now() - new Date(f.latest + 'T00:00:00Z').getTime()) / 86400000);
  if (days < STALE_AFTER_DAYS) return '';
  return `**These figures are ${days} days old.** The most recent collection ran on ${f.latest}. `
    + 'Nightly collection has probably stopped — most often an expired Facebook token. '
    + 'Treat the numbers below as historic, not current.\n\n';
}

// Single dispatch path for BOTH transports. Previously each server looked the
// tool up itself, which is how a check added in one place would silently miss
// the other.
async function callTool(store, name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    const e = new Error(`Unknown tool: ${name}`);
    e.code = 'UNKNOWN_TOOL';
    throw e;
  }
  const out = await tool.handler(store, args || {});
  const banner = await freshnessBanner(store);
  // Prepended, not appended: a warning below the numbers is a warning nobody
  // reads until after they have quoted them.
  return { ...out, text: banner + out.text };
}

module.exports = { TOOLS, callTool, freshnessBanner, STALE_AFTER_DAYS };
