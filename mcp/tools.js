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

async function topPosts(store, { page_id, days = 30, sort = 'views', limit = 10 }) {
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
    r.created_time.slice(0, 10), r.page_name, truncate(r.message, 70),
    n(r.views_total), n(r.views_unique), p(r.beyond_followers_pct),
    n(r.reactions_total), n(r.shares_total), p(r.engagement_rate),
    r.benchmark && r.benchmark.views_x_median !== null ? r.benchmark.views_x_median + '×' : '—',
  ]);
  const label = METRIC_LABELS[sort] || sort;
  return {
    text: `**Top ${feed.rows.length} posts by ${label}**`
      + `${page_id ? '' : ' (all pages)'}${days ? ` · last ${days} days` : ' · all time'}\n\n`
      + table(['Date', 'Page', 'Post', 'Views', 'Unique', 'Beyond followers', 'Reactions', 'Shares', 'Eng. rate', 'vs median'], rows)
      + (base.reliable
        ? `\n\n_"vs median" compares each post to this page's own median of ${n(base.median_views)} views over the same window. A raw view count says nothing on its own._`
        : `\n\n_Too few posts with metrics (${base.n}) to establish a baseline, so no comparison is shown._`)
      + gapNote(feed.rows),
    data: { ...feed, baseline: base },
  };
}

async function pageSummary(store, { page_id, days = 30 }) {
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
  if (best) lines.push('', `Best performing by views: "${truncate(best.message, 90)}" — ${n(best.views_total)} views, ${p(best.engagement_rate)} engagement rate.`);
  if (widest) lines.push(`Travelled furthest beyond followers: "${truncate(widest.message, 90)}" — ${p(widest.beyond_followers_pct)} of views came from non-followers.`);
  return { text: lines.join('\n') + gapNote(feed.rows), data: { page, posts: feed.total } };
}

async function comparePages(store, { days = 30 }) {
  const data = await store.loadAll();
  const pages = shapePages(data);
  let anyIncomplete = false;
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
    ];
  });
  return {
    text: `**Page comparison · last ${days} days**\n\n`
      + table(['Page', 'Followers', 'Posts', 'Views', 'Engagement', 'Eng. rate', 'Views per follower'], rows)
      + `\n\n_"Views per follower" is the fairer cross-page comparison — raw totals just rank pages by audience size._`
      + (anyIncomplete
        ? `\n\n_**Compare with care:** pages marked "no data" have posts Meta refused to report on, so their totals are understated by an unknown amount. Do not rank pages against each other without saying so._`
        : ''),
    data: pages,
  };
}

async function dataHealth(store) {
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
      `- Posts with no comment count: **${noComments}** (requires the pages_read_user_content scope, not yet granted)`,
      '',
      'Known limitations to state when reporting:',
      '- Paid vs organic split comes from a breakdown, not a dedicated metric; all `post_impressions*` metrics were retired by Meta in 2026.',
      '- Only pages whose Business Portfolio granted read access are present. Absent pages are an access gap.',
      '- Metrics are a daily snapshot; engagement on recent posts is still accruing and will rise.',
    ].join('\n'),
    data: { pages: pages.length, posts: feed.total, missing: missing.length, partial: partial.length },
  };
}

async function outliers(store, { page_id, days = 90 }) {
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
  const over = scored.filter((r) => r.benchmark.views_x_median >= 1.5);
  const under = scored.filter((r) => r.benchmark.views_x_median < 0.5);

  const fmt = (r) => [
    r.created_time.slice(0, 10),
    r.benchmark.views_x_median + '×',
    n(r.views_total),
    n(r.shares_total),
    r.benchmark.shares_x_median !== null ? r.benchmark.shares_x_median + '×' : '—',
    p(r.engagement_rate),
    truncate(r.message, 60),
  ];
  const head = ['Date', 'vs median', 'Views', 'Shares', 'Shares vs med', 'Eng. rate', 'Post'];

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
      over.length ? table(head, over.map(fmt)) : '_None._',
      '',
      `**Well below normal** (${under.length})`,
      '',
      under.length ? table(head, under.map(fmt)) : '_None._',
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
async function searchPosts(store, { query, page_id, days = 0, limit = 15 }) {
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
    ['Date', 'Page', 'Post', 'Reach', 'Views', 'Beyond followers', 'Shares', 'Comments', 'Eng. rate'],
    rows.map((r) => [
      (r.created_time || '').slice(0, 10),
      r.page_name || '—',
      truncate(r.message, 70),
      n(r.views_unique),
      n(r.views_total),
      r.views_total > 0 ? p((r.views_from_nonfollowers / r.views_total) * 100) : '—',
      n(r.shares_total), n(r.comments_total),
      r.engagement_rate_pct !== null && r.engagement_rate_pct !== undefined
        ? p(Number(r.engagement_rate_pct)) : '—',
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
      },
      additionalProperties: false,
    },
    handler: (store, args) => outliers(store, args),
  },
  {
    name: 'data_health',
    description: 'Report coverage and known gaps: how many posts lack metrics and why, which scopes are missing, and what caveats to state when reporting. Call this before presenting numbers as complete, and whenever a total looks surprisingly low.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (store) => dataHealth(store),
  },
];

module.exports = { TOOLS };
