'use strict';
// Instagram collection.
//
// Kept separate from the Facebook path because the shapes genuinely differ:
// IG media has no share count on the object, has `saved` (which Facebook has no
// equivalent for and is the strongest intent signal on the platform), and uses
// different metric names. Forcing both through one code path would mean
// special-casing at every step.
//
// IG insights survived Meta's 2025-2026 deprecations far better than Facebook's,
// so reach and views are straightforwardly available here.
//
// Requires instagram_basic and instagram_manage_insights on the token, plus the
// IG account being linked to the Page. A page without a linked account is
// skipped silently — most Pages legitimately have none.

const IG_MEDIA_FIELDS = [
  'id', 'caption', 'media_type', 'media_product_type', 'permalink',
  'thumbnail_url', 'timestamp', 'like_count', 'comments_count',
].join(',');

// Probed one at a time, like the Facebook metrics, so one unavailable metric
// cannot fail the rest. Stories expire after 24h and expose a narrower set;
// anything unsupported records an error and leaves a null.
const IG_METRICS = ['reach', 'views', 'saved', 'total_interactions', 'likes', 'comments', 'shares'];

// FEED posts only. These three are the one place in either platform where a
// follower action can be attributed to a single post - probed live on v23.0,
// 7 Sept 2026, and confirmed absent everywhere else: a REELS post from the same
// account rejects all three with "does not support ... for this media product
// type", and Facebook has no per-post equivalent at all
// (scripts/probe-follower-metrics.js re-checks both).
//
// Gated rather than probed-and-caught because the alternative is three
// guaranteed failures on every Reel, which would bury the real errors in the
// errors column under noise we already know the answer to.
const IG_FEED_METRICS = ['follows', 'profile_visits', 'profile_activity'];

// REELS only, and the mirror image of the above: Meta refuses these on a FEED
// post and serves them on a Reel. Probed live on v23.0, 7 Sept 2026.
//
// This is the only watch-through signal available for Reels - clips_replays_count,
// ig_reels_aggregated_all_plays_count and thruplays are all rejected outright -
// and Reels are 374 of our 790 Instagram posts, so without these half the
// Instagram estate has no completion signal at all.
const IG_REELS_METRICS = ['ig_reels_avg_watch_time', 'ig_reels_video_view_total_time'];

// ACCOUNT level, per day. Two kinds, and the split is forced by the API rather
// than chosen: these are served as a time series, so one call covers the whole
// window.
const IG_ACCOUNT_SERIES = { follower_count: 'follower_count', reach: 'reach' };

// ...while these are only served as a single total_value. Passing since/until
// returns one number for the whole range, not one per day, so a genuine daily
// history would cost one call per metric per day. Collected for the current day
// only; older rows carry the series metrics above and nulls here, which is
// honest rather than convenient.
const IG_ACCOUNT_TOTALS = {
  views: 'views', profile_views: 'profile_views', website_clicks: 'website_clicks',
  accounts_engaged: 'accounts_engaged', total_interactions: 'total_interactions',
  replies: 'replies',
};

// Served as total_value with a breakdown rather than a scalar, so it is stored
// as jsonb whole instead of being flattened into a number that loses the half
// of it that matters.
const IG_ACCOUNT_BREAKDOWNS = { follows_and_unfollows: 'follows_and_unfollows' };

function firstValue(res) {
  if (!res || !res.ok) return null;
  const d = res.body && res.body.data && res.body.data[0];
  const v = d && d.values && d.values[0];
  return v && typeof v.value === 'number' ? v.value : null;
}

// call(pathname, params, opts) is injected so this module stays testable and
// shares the collector's API-call accounting.
async function collectInstagram({ page, as, call, lookbackDays, maxPosts, runStarted, collectedDate, log }) {
  // The linked account, if any.
  const info = await call(`/${page.page_id}`, {
    fields: 'instagram_business_account{id,username,followers_count,media_count}',
  }, as);

  const ig = info.ok && info.body && info.body.instagram_business_account;
  if (!ig || !ig.id) return { linked: false, media: [], metrics: [] };

  const cutoff = new Date(runStarted.getTime() - lookbackDays * 86400000);
  const media = [];
  let next = null;

  while (media.length < maxPosts) {
    const params = next
      ? { fields: IG_MEDIA_FIELDS, limit: 100, after: next }
      : { fields: IG_MEDIA_FIELDS, limit: 100 };
    const res = await call(`/${ig.id}/media`, params, as);
    if (!res.ok) {
      log(`   instagram: @${ig.username} — media listing failed (${res.error ? res.error.message.slice(0, 70) : 'unknown'})`);
      return { linked: true, username: ig.username, media: [], metrics: [], error: res.error };
    }
    const rows = (res.body && res.body.data) || [];
    if (!rows.length) break;

    let reachedCutoff = false;
    for (const r of rows) {
      if (new Date(r.timestamp) < cutoff) { reachedCutoff = true; break; }
      media.push({
        media_id: r.id,
        page_id: page.page_id,
        ig_user_id: ig.id,
        ig_username: ig.username || null,
        media_type: r.media_type || null,
        media_product_type: r.media_product_type || null,
        caption: r.caption || null,
        permalink: r.permalink || null,
        thumbnail_url: r.thumbnail_url || null,
        timestamp: r.timestamp,
        _like_count: typeof r.like_count === 'number' ? r.like_count : null,
        _comments_count: typeof r.comments_count === 'number' ? r.comments_count : null,
      });
      if (media.length >= maxPosts) break;
    }
    if (reachedCutoff) break;
    next = res.body && res.body.paging && res.body.paging.cursors && res.body.paging.cursors.after;
    if (!next) break;
  }

  const metrics = [];
  for (const m of media) {
    const errors = {};
    const values = {};
    // Gated per product type rather than attempted and caught: Meta refuses the
    // FEED-only metrics on a Reel and the Reels-only metrics on a FEED post, so
    // asking for both everywhere would guarantee two or three failures on every
    // single post and bury the real errors under known ones.
    const wanted = [...IG_METRICS];
    if (m.media_product_type === 'FEED') wanted.push(...IG_FEED_METRICS);
    if (m.media_product_type === 'REELS') wanted.push(...IG_REELS_METRICS);
    for (const metric of wanted) {
      const r = await call(`/${m.media_id}/insights`, { metric }, as);
      if (r.ok) values[metric] = firstValue(r);
      else errors[metric] = { code: r.error ? r.error.code : null, message: r.error ? r.error.message : 'unknown' };
    }
    metrics.push({
      media_id: m.media_id,
      page_id: page.page_id,
      collected_date: collectedDate,
      collected_at: runStarted.toISOString(),
      reach: values.reach ?? null,
      views: values.views ?? null,
      saved: values.saved ?? null,
      total_interactions: values.total_interactions ?? null,
      // The media object carries like and comment counts directly, which is
      // cheaper and more reliable than the insights metric. Fall back only if
      // the object did not provide them.
      likes: m._like_count ?? values.likes ?? null,
      comments: m._comments_count ?? values.comments ?? null,
      shares: values.shares ?? null,
      // Null on anything that is not a FEED post. That null means "Meta does
      // not offer this for this media product type", NOT zero followers gained
      // - never sum or average these without filtering to FEED first.
      follows: values.follows ?? null,
      profile_visits: values.profile_visits ?? null,
      profile_activity: values.profile_activity ?? null,
      // REELS only. Milliseconds as Meta reports them; the meta_ig_latest view
      // derives the seconds figure people actually quote.
      reels_avg_watch_time_ms: values.ig_reels_avg_watch_time ?? null,
      reels_total_watch_time_ms: values.ig_reels_video_view_total_time ?? null,
      errors: Object.keys(errors).length ? errors : null,
    });
  }

  media.forEach((m) => { delete m._like_count; delete m._comments_count; });

  const account = await collectAccountMetrics({
    ig, page, as, call, lookbackDays, runStarted, collectedDate,
  });

  return { linked: true, username: ig.username, ig_user_id: ig.id, media, metrics, account };
}

// Account-level daily metrics. Nothing was collected here before 7 Sept 2026:
// Facebook follower growth was charted and Instagram had no equivalent, while
// this function's own `ig` argument already carried followers_count and
// media_count from the call that finds the linked account - fetched every run
// and thrown away.
//
// Instagram serves account insights for roughly the last 30 days only, unlike
// Facebook page insights. The window is clamped accordingly, and it is why this
// table cannot be backfilled the way the post tables can.
async function collectAccountMetrics({ ig, page, as, call, lookbackDays, runStarted, collectedDate }) {
  const errors = {};
  const byDate = new Map();
  const rowFor = (date) => {
    if (!byDate.has(date)) {
      byDate.set(date, {
        ig_user_id: ig.id,
        page_id: page.page_id,
        ig_username: ig.username || null,
        metric_date: date,
        collected_at: runStarted.toISOString(),
        followers_snapshot: null,
        media_count: null,
        errors: null,
      });
    }
    return byDate.get(date);
  };

  const days = Math.min(lookbackDays, 30);
  const until = Math.floor(runStarted.getTime() / 1000);
  const since = until - days * 86400;

  for (const [metric, column] of Object.entries(IG_ACCOUNT_SERIES)) {
    const r = await call(`/${ig.id}/insights`, { metric, period: 'day', since, until }, as);
    if (!r.ok) {
      errors[metric] = { code: r.error ? r.error.code : null, message: r.error ? r.error.message : 'unknown' };
      continue;
    }
    const series = (r.body && r.body.data && r.body.data[0] && r.body.data[0].values) || [];
    for (const point of series) {
      if (!point || point.end_time === undefined) continue;
      // end_time is the END of the day the value covers, as on the page series.
      rowFor(String(point.end_time).slice(0, 10))[column] =
        typeof point.value === 'number' ? point.value : null;
    }
  }

  // The current day gets the point-in-time totals and the total_value metrics.
  const today = rowFor(collectedDate);
  today.followers_snapshot = typeof ig.followers_count === 'number' ? ig.followers_count : null;
  today.media_count = typeof ig.media_count === 'number' ? ig.media_count : null;

  for (const [metric, column] of Object.entries({ ...IG_ACCOUNT_TOTALS, ...IG_ACCOUNT_BREAKDOWNS })) {
    const r = await call(`/${ig.id}/insights`, { metric, metric_type: 'total_value', period: 'day' }, as);
    if (!r.ok) {
      errors[metric] = { code: r.error ? r.error.code : null, message: r.error ? r.error.message : 'unknown' };
      continue;
    }
    const d = r.body && r.body.data && r.body.data[0];
    const tv = d && d.total_value;
    if (IG_ACCOUNT_BREAKDOWNS[metric]) {
      // Keep the breakdown intact, but do not store an empty envelope as if it
      // were data.
      today[column] = tv && typeof tv === 'object' && Object.keys(tv).length ? tv : null;
    } else {
      today[column] = tv && typeof tv.value === 'number' ? tv.value : null;
    }
  }

  const rows = [...byDate.values()];
  if (Object.keys(errors).length) rows.forEach((r) => { r.errors = errors; });
  return { rows, errorCount: Object.keys(errors).length };
}

module.exports = {
  collectInstagram, collectAccountMetrics,
  IG_METRICS, IG_FEED_METRICS, IG_REELS_METRICS,
  IG_ACCOUNT_SERIES, IG_ACCOUNT_TOTALS, IG_ACCOUNT_BREAKDOWNS,
  IG_MEDIA_FIELDS,
};
