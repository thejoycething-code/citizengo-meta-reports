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
    // Video posts only; null on a photo means "not a video", not "no paid
    // views". Collected since 7 Sept 2026.
    video_views_organic: m.video_views_organic ?? null,
    video_views_paid: m.video_views_paid ?? null,
    video_views_by_distribution: m.video_views_by_distribution ?? null,

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

// A page's own baseline. With a single page in scope, absolute numbers tell a
// campaigner nothing — "4,535 views" is only meaningful as a multiple of what
// that page normally does. Medians and percentiles throughout, because organic
// reach is heavily skewed: one shared post can be 17x the next best, and a mean
// would drag the "normal" line up above almost every post.
function pageBaseline(rows) {
  const scored = rows.filter((r) => r.has_metrics);
  if (scored.length < 3) {
    // Below this there is no distribution to speak of, and claiming a baseline
    // would invite conclusions the data cannot support.
    return { n: scored.length, reliable: false };
  }
  return {
    n: scored.length,
    reliable: true,
    median_views: median(scored.map((r) => r.views_total).filter((v) => v !== null)),
    p90_views: percentile(scored.map((r) => r.views_total).filter((v) => v !== null), 90),
    median_unique: median(scored.map((r) => r.views_unique).filter((v) => v !== null)),
    median_eng_rate: median(scored.map((r) => r.engagement_rate).filter((v) => v !== null)),
    median_beyond_pct: median(scored.map((r) => r.beyond_followers_pct).filter((v) => v !== null)),
    median_shares: median(scored.map((r) => r.shares_total).filter((v) => v !== null)),
  };
}

function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return Number(s[idx].toFixed(1));
}

// Attaches "how does this compare to normal for this page" to a shaped row.
function withBenchmark(row, baseline) {
  if (!baseline || !baseline.reliable) return { ...row, benchmark: null };
  // Round to the magnitude. "2200.18x a normal post" claims a precision that a
  // median of 83 posts cannot support, and reads as a broken number rather than
  // the genuinely extraordinary one it is.
  const ratio = (v, med) => {
    if (typeof v !== 'number' || !(med > 0)) return null;
    const r = v / med;
    if (r >= 100) return Math.round(r / 10) * 10;
    if (r >= 10) return Math.round(r);
      // Below 0.1 a single decimal rounds to zero, and "0x a normal post" reads
      // as a broken figure rather than a very small one. A post that did 97 views
      // against a page median in the thousands deserves a number, not a zero.
      if (r < 0.1) return Number(r.toFixed(2));
    return Number(r.toFixed(1));
  };
  const views_x = ratio(row.views_total, baseline.median_views);
  return {
    ...row,
    benchmark: {
      views_x_median: views_x,
      shares_x_median: ratio(row.shares_total, baseline.median_shares),
      eng_rate_delta: (row.engagement_rate !== null && baseline.median_eng_rate !== null)
        ? Number((row.engagement_rate - baseline.median_eng_rate).toFixed(1)) : null,
      // Deliberately coarse buckets. Finer grading would imply a precision this
      // sample size does not have.
      band: views_x === null ? null
        : views_x >= 3 ? 'far above normal'
        : views_x >= 1.5 ? 'above normal'
        : views_x >= 0.5 ? 'normal'
        : 'below normal',
    },
  };
}

// Median, not mean: one 2M-view viral post would otherwise define the average
// for a whole page and make every other post look like a failure.
function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return Number((s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2).toFixed(1));
}

module.exports = { shapeFeed, shapePages, shapePost, pageBaseline, withBenchmark, pct, median, percentile, SORTS };
