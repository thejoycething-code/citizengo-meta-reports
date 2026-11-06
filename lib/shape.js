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

// One post row, joined and enriched. `original` is set when this post is a copy
// of a post published to several Pages at once (see sharedCopies below): its
// numbers belong to the original Page, so the copy carries none of its own.
function shapePost(post, metric, page, original) {
  const m = (original ? null : metric) || {};
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
    // post_video_avg_time_watched, in seconds. Meta serves it on Reels (643 of
    // 655 on 28 Sept 2026) and on none of the classic videos, so null on a
    // non-Reel is "not offered", not zero.
    video_avg_seconds_watched: m.video_avg_seconds_watched ?? null,

    engagement_total: engagement,
    // Against views, not followers — views is the denominator that still exists.
    engagement_rate: pct(engagement, m.views_total),
    // The virality signal: how far a post travelled past the people who already
    // follow the page. For campaigning this is the most actionable number here.
    beyond_followers_pct: pct(m.views_from_nonfollowers, m.views_total),
    organic_pct: pct(m.views_organic, m.views_total),

    // Truthful about gaps rather than hiding them.
    has_metrics: hasViews(m),
    partial: !!(m.errors && Object.keys(m.errors).length),
    // A copy is not a data gap: its numbers are on the original Page's row.
    // Counted apart from "no metrics" so a missing count means what it says.
    shared_copy: !!original,
    original_post_id: original ? original.post_id : null,
    original_page_id: original ? original.page_id : null,
    original_page_name: original ? (original.page_name || null) : null,
  };
}

function hasViews(m) {
  return !!m && m.views_total !== null && m.views_total !== undefined;
}

// Posts published to several Pages at once (multi-Page publishing, e.g. UK and
// Scotland, or CitizenGO and its country Pages) are ONE Facebook object: every
// copy has the same story id after the underscore, `<page>_<story>`.
//
// Measured 6 Nov 2026: where two copies both returned insights, the numbers were
// identical on 279 of 283 same-day pairs (all within 2%). So a copy's insights
// are the original's, and counting both doubles the post. Meta has since
// stopped serving them on most copies (#200 "Permissions error"), which is
// where 78 of the 86 "no metrics" posts came from. Not a Business Portfolio or
// token problem: the same token reads every one of those Pages' own posts.
//
// The original is the copy Meta still serves insights on (its newest snapshot
// has them), then one that has ever had them, then the earliest created.
// Creation order alone is not enough: Scotland's copy of a UK post is
// sometimes timestamped first, yet only the UK copy still answers. Every other copy, on a different
// Page, maps to it. Needs every Page's posts in hand: a single-Page load cannot
// see the other copies and leaves them as they are.
function sharedCopies(posts, metricFor, pageById, newestFor = metricFor) {
  const byStory = new Map();
  for (const p of posts) {
    // Real story ids are long numbers. Anything else (test fixtures, odd ids)
    // is left alone rather than risk pairing two unrelated posts.
    const story = String(p.post_id || '').split('_')[1];
    if (!story || !/^\d{6,}$/.test(story)) continue;
    if (!byStory.has(story)) byStory.set(story, []);
    byStory.get(story).push(p);
  }
  const copyOf = new Map();
  for (const group of byStory.values()) {
    if (new Set(group.map((p) => p.page_id)).size < 2) continue;
    const ordered = [...group].sort((a, b) => String(a.created_time).localeCompare(String(b.created_time)));
    const original = ordered.find((p) => hasViews(newestFor(p.post_id)))
      || ordered.find((p) => hasViews(metricFor(p.post_id))) || ordered[0];
    const page = pageById.get(original.page_id);
    const info = { post_id: original.post_id, page_id: original.page_id, page_name: page ? page.name : null };
    for (const p of ordered) {
      if (p.page_id !== original.page_id) copyOf.set(p.post_id, info);
    }
  }
  return copyOf;
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
  // But the newest row WITH insights, when there is one: a later day on which
  // Meta refused (#200) or failed (#2, "retry later") must not hide numbers we
  // already hold. Two CitizenGO posts read "no metrics" on 6 Nov 2026 over one
  // transient #2 on 5 Oct, with 15 good snapshots before it.
  const latest = new Map();
  const latestGood = new Map();
  const newer = (map, m) => {
    const prev = map.get(m.post_id);
    if (!prev || String(m.collected_date) > String(prev.collected_date)) map.set(m.post_id, m);
  };
  for (const m of metrics) {
    newer(latest, m);
    if (hasViews(m)) newer(latestGood, m);
  }
  const metricFor = (id) => latestGood.get(id) || latest.get(id);
  const copyOf = sharedCopies(posts, metricFor, pageById, (id) => latest.get(id));

  let rows = posts.map((p) => shapePost(p, metricFor(p.post_id), pageById.get(p.page_id), copyOf.get(p.post_id)));

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
      // Copies of a post shared from another Page are not missing: their
      // numbers are on that Page. See sharedCopies.
      posts_shared_copies: mine.filter((r) => r.shared_copy).length,
      posts_missing_metrics: mine.filter((r) => !r.has_metrics && !r.shared_copy).length,
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

module.exports = { shapeFeed, shapePages, shapePost, sharedCopies, pageBaseline, withBenchmark, pct, median, percentile, SORTS };
