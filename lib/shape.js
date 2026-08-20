'use strict';
// Shared shaping for every read surface: the dashboard API, the local dev
// server, and the Sheet mirror. One implementation so the three cannot drift —
// a Sheet that disagrees with the dashboard is worse than no Sheet.
//
// Nulls are preserved as null all the way through. A post whose insights Meta
// refused (#200) must render as "—", never as 0, or a data gap reads as a
// performance collapse.

function pct(numerator, denominator, dp = 1) {
  if (typeof numerator !== 'number' || typeof denominator !== 'number' || denominator <= 0) return null;
  return Number(((numerator / denominator) * 100).toFixed(dp));
}

function sumOrNull(values) {
  const present = values.filter((v) => typeof v === 'number');
  return present.length ? present.reduce((a, b) => a + b, 0) : null;
}

// One post row, joined and enriched.
function shapePost(post, metric, page) {
  const m = metric || {};
  const engagement = sumOrNull([m.reactions_total, m.shares_total, m.clicks_total, m.comments_total]);
  return {
    post_id: post.post_id,
    page_id: post.page_id,
    page_name: page ? page.name : null,
    created_time: post.created_time,
    message: post.message,
    permalink_url: post.permalink_url,
    status_type: post.status_type,
    media_type: post.media_type,
    collected_date: m.collected_date || null,

    views_total: m.views_total ?? null,
    views_unique: m.views_unique ?? null,
    views_organic: m.views_organic ?? null,
    views_paid: m.views_paid ?? null,
    views_from_followers: m.views_from_followers ?? null,
    views_from_nonfollowers: m.views_from_nonfollowers ?? null,

    reactions_total: m.reactions_total ?? null,
    shares_total: m.shares_total ?? null,
    clicks_total: m.clicks_total ?? null,
    comments_total: m.comments_total ?? null,
    video_views: m.video_views ?? null,

    engagement_total: engagement,
    // Against views, not followers — views is the denominator that still exists.
    engagement_rate: pct(engagement, m.views_total),
    // The virality signal: how far a post travelled past the people who already
    // follow the page. For campaigning this is the most actionable number here.
    beyond_followers_pct: pct(m.views_from_nonfollowers, m.views_total),
    organic_pct: pct(m.views_organic, m.views_total),

    // Truthful about gaps rather than hiding them.
    has_metrics: m.views_total !== null && m.views_total !== undefined,
    partial: !!(m.errors && Object.keys(m.errors).length),
  };
}

const SORTS = {
  recent: (a, b) => (a.created_time < b.created_time ? 1 : -1),
  views: (a, b) => (b.views_total ?? -1) - (a.views_total ?? -1),
  reach: (a, b) => (b.views_unique ?? -1) - (a.views_unique ?? -1),
  beyond: (a, b) => (b.beyond_followers_pct ?? -1) - (a.beyond_followers_pct ?? -1),
  engagement: (a, b) => (b.engagement_total ?? -1) - (a.engagement_total ?? -1),
  rate: (a, b) => (b.engagement_rate ?? -1) - (a.engagement_rate ?? -1),
  shares: (a, b) => (b.shares_total ?? -1) - (a.shares_total ?? -1),
};

function shapeFeed({ posts, metrics, pages }, opts = {}) {
  const pageById = new Map(pages.map((p) => [p.page_id, p]));
  // Latest snapshot per post — engagement accrues, so only the newest row counts.
  const latest = new Map();
  for (const m of metrics) {
    const prev = latest.get(m.post_id);
    if (!prev || String(m.collected_date) > String(prev.collected_date)) latest.set(m.post_id, m);
  }

  let rows = posts.map((p) => shapePost(p, latest.get(p.post_id), pageById.get(p.page_id)));

  if (opts.page_id) rows = rows.filter((r) => r.page_id === opts.page_id);
  if (opts.since) rows = rows.filter((r) => r.created_time >= opts.since);
  if (opts.with_metrics_only) rows = rows.filter((r) => r.has_metrics);

  rows.sort(SORTS[opts.sort] || SORTS.recent);
  const total = rows.length;
  if (opts.limit) rows = rows.slice(0, Number(opts.limit));
  return { total, rows };
}

// Per-page rollup for the summary cards.
function shapePages({ posts, metrics, pages }) {
  const { rows } = shapeFeed({ posts, metrics, pages }, {});
  return pages.map((p) => {
    const mine = rows.filter((r) => r.page_id === p.page_id);
    const scored = mine.filter((r) => r.has_metrics);
    return {
      page_id: p.page_id,
      name: p.name,
      followers_count: p.followers_count ?? null,
      posts: mine.length,
      posts_with_metrics: scored.length,
      posts_missing_metrics: mine.length - scored.length,
      views_total: sumOrNull(scored.map((r) => r.views_total)),
      views_unique: sumOrNull(scored.map((r) => r.views_unique)),
      views_paid: sumOrNull(scored.map((r) => r.views_paid)),
      engagement_total: sumOrNull(scored.map((r) => r.engagement_total)),
      median_engagement_rate: median(scored.map((r) => r.engagement_rate).filter((v) => v !== null)),
      median_beyond_followers_pct: median(scored.map((r) => r.beyond_followers_pct).filter((v) => v !== null)),
    };
  }).sort((a, b) => (b.views_total ?? -1) - (a.views_total ?? -1));
}

// Median, not mean: one 2M-view viral post would otherwise define the average
// for a whole page and make every other post look like a failure.
function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return Number((s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2).toFixed(1));
}

module.exports = { shapeFeed, shapePages, shapePost, pct, median, SORTS };
