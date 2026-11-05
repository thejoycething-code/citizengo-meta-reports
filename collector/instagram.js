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
  'thumbnail_url', 'media_url', 'timestamp', 'like_count', 'comments_count',
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
// returns one number for the whole range, not one per day, so each closed day
// is asked on its own (IG_TOTAL_DAYS, below). Before 5 Nov 2026 they were
// asked for the day still running and older rows hold part-day figures.
const IG_ACCOUNT_TOTALS = {
  views: 'views', profile_views: 'profile_views', website_clicks: 'website_clicks',
  accounts_engaged: 'accounts_engaged', total_interactions: 'total_interactions',
  replies: 'replies',
};

// Served as total_value with a breakdown rather than a scalar. Empty since
// follows_and_unfollows moved to its own per-day pass below: asked for here,
// without breakdown=follow_type and without a date range, it returned an empty
// envelope every night from August to 29 Sept 2026 and the jsonb column it
// filled holds nothing. The column is left in place; nothing writes to it.
const IG_ACCOUNT_BREAKDOWNS = {};

// How many of the latest closed days the total_value metrics are re-read for.
const IG_TOTAL_DAYS = 3;

// FOLLOWS AND UNFOLLOWS, one Meta day at a time - the only route to Instagram
// NET follower growth, which the Scorecard needs (29 Sept 2026). follower_count
// above is new followers only.
//
// Probed live (scripts/probe-ig-follows.js, three rounds on 29 Sept 2026):
// breakdown=follow_type returns FOLLOWER and NON_FOLLOWER counts for any range
// inside roughly the last five weeks. Meta sums every DAY WHOSE CLOSING TIME
// (end_time) FALLS INSIDE [since, until], both ends inclusive. So:
//
//   [end - 1 day, end]        covers TWO closings - two days summed. The first
//                             version of this code did exactly that, and stored
//                             every day as itself plus the day before
//                             (HazteOir 22 Sept: 1,209 = 670 + 539).
//   [end - 1 day + 1s, end]   covers ONE closing - one day. Used below.
//   a window holding no closing time returns an empty envelope, which is why
//   UTC-midnight and 08:00Z single days came back empty in round one.
//
// The closings are taken from follower_count's own end_time values rather than
// computed, which carries this through the November clock change without
// anyone remembering to. The control: FOLLOWER for one closing equals
// follower_count for the same end_time on every account probed (HazteOir 539,
// Citizen GO UK 2, CitizenGO Canada 0 for the day closing 23 Sept 07:00Z).
const IG_FOLLOW_SPLIT = { metric: 'follows_and_unfollows', metric_type: 'total_value', period: 'day', breakdown: 'follow_type' };

// See collect.js: Meta's end_time is when the day closed (07:00Z, midnight
// Pacific), so the day it covers is the one before.
const dayDescribed = (endTime) =>
  new Date(Date.parse(endTime) - 86400000).toISOString().slice(0, 10);

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
        // A preview image for the desk's Instagram grid: a video's own
        // thumbnail, else the image itself (a carousel's media_url is its
        // first item). Signed CDN links that expire, refreshed every night.
        thumbnail_url: r.thumbnail_url || (r.media_type !== 'VIDEO' && r.media_url) || null,
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

  // Calendar-month totals for the monthly Instagram dashboard. Its own
  // try/catch: a month that fails must not cost the night its daily rows.
  let months = { rows: [], errorCount: 0 };
  try {
    months = await collectAccountMonths({ ig, page, as, call, runStarted });
  } catch (e) {
    log(`   instagram: @${ig.username} — monthly totals failed (${String(e.message).slice(0, 120)})`);
  }

  // Stories and audience: each in its own try, for the same reason.
  let stories = { media: [], metrics: [] };
  try {
    stories = await collectStories({ ig, page, as, call, runStarted, collectedDate });
    if (stories.error) log(`   instagram: @${ig.username} — stories unavailable (${String(stories.error.message).slice(0, 120)})`);
  } catch (e) {
    log(`   instagram: @${ig.username} — stories failed (${String(e.message).slice(0, 120)})`);
  }
  let audience = { rows: [], errorCount: 0 };
  try {
    audience = await collectAudience({ ig, page, as, call, runStarted, collectedDate });
  } catch (e) {
    log(`   instagram: @${ig.username} — audience failed (${String(e.message).slice(0, 120)})`);
  }

  return { linked: true, username: ig.username, ig_user_id: ig.id, media, metrics, account, months, stories, audience };
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
  // A row carries ONLY the columns observed for its date. Older dates get the
  // series metrics and nothing else; the current day also gets the snapshot
  // and the total_value metrics.
  //
  // This used to fill every row with every column, nulls included, to satisfy
  // PostgREST's rule that a bulk insert's objects share one key set (PGRST102).
  // Under merge-duplicates those nulls overwrote the stored values, so each
  // night blanked the follower count, views and profile visits that the night
  // before had saved - HazteOir held 52 days of rows and a follower count on
  // one of them (29 Sept 2026). The collector now upserts one batch per key
  // set (upsertByShape in collect.js), which is why the rows here may differ.
  const rowFor = (date) => {
    if (!byDate.has(date)) {
      byDate.set(date, {
        ig_user_id: ig.id,
        page_id: page.page_id,
        ig_username: ig.username || null,
        metric_date: date,
        collected_at: runStarted.toISOString(),
        errors: null,
      });
    }
    return byDate.get(date);
  };

  const days = Math.min(lookbackDays, 30);
  const until = Math.floor(runStarted.getTime() / 1000);
  const since = until - days * 86400;

  const dayEnds = [];
  for (const [metric, column] of Object.entries(IG_ACCOUNT_SERIES)) {
    const r = await call(`/${ig.id}/insights`, { metric, period: 'day', since, until }, as);
    if (!r.ok) {
      errors[metric] = { code: r.error ? r.error.code : null, message: r.error ? r.error.message : 'unknown' };
      continue;
    }
    const series = (r.body && r.body.data && r.body.data[0] && r.body.data[0].values) || [];
    if (metric === 'follower_count') {
      for (const point of series) if (point && point.end_time) dayEnds.push(point.end_time);
    }
    for (const point of series) {
      if (!point || point.end_time === undefined) continue;
      // The day the value DESCRIBES, not the day it closed - same rule and same
      // reason as the page series in collect.js. Only these series columns are
      // dated this way; the total_value columns below are keyed to the
      // collection date, which is why the two must never be shifted together.
      rowFor(dayDescribed(point.end_time))[column] =
        typeof point.value === 'number' ? point.value : null;
    }
  }

  // One call per day: a window holding exactly one closing time, the one
  // follower_count just reported. A day Meta answers with no results is left
  // UNSET rather than written as null or zero, so a hiccup cannot blank a day
  // an earlier night stored.
  let splitErrors = 0;
  for (const end of dayEnds) {
    const closing = Math.floor(Date.parse(end) / 1000);
    const r = await call(`/${ig.id}/insights`, { ...IG_FOLLOW_SPLIT, since: closing - 86400 + 1, until: closing }, as);
    if (!r.ok) {
      splitErrors++;
      errors.follows_and_unfollows = { code: r.error ? r.error.code : null, message: r.error ? r.error.message : 'unknown' };
      continue;
    }
    const d = r.body && r.body.data && r.body.data[0];
    const bd = d && d.total_value && d.total_value.breakdowns && d.total_value.breakdowns[0];
    const results = (bd && bd.results) || [];
    const valueOf = (type) => {
      const hit = results.find((x) => x.dimension_values && x.dimension_values[0] === type);
      return hit && typeof hit.value === 'number' ? hit.value : null;
    };
    const follows = valueOf('FOLLOWER');
    const unfollows = valueOf('NON_FOLLOWER');
    if (follows === null && unfollows === null) continue;
    const row = rowFor(dayDescribed(end));
    row.daily_follows = follows;
    row.daily_unfollows = unfollows;
  }
  if (splitErrors && splitErrors < dayEnds.length) {
    errors.follows_and_unfollows.days_failed = splitErrors;
  }

  // The current day gets the point-in-time totals.
  const today = rowFor(collectedDate);
  today.followers_snapshot = typeof ig.followers_count === 'number' ? ig.followers_count : null;
  today.media_count = typeof ig.media_count === 'number' ? ig.media_count : null;

  // The total_value metrics, for whole CLOSED days (5 Nov 2026). Until then
  // they were asked with no range, which answers for the day still running:
  // at 04:30 Madrid that is a few hours of a Pacific day, so the stored views,
  // interactions and profile visits were part-days and no daily chart or sum
  // built on them meant anything. Now each of the last IG_TOTAL_DAYS days that
  // follower_count reported closed is asked on its own, with a window holding
  // exactly its closing time (the same rule as follows_and_unfollows above),
  // and stored on the day it describes. Re-reading a few days lets a missed
  // night heal; a day Meta answers with nothing is left unset.
  const closings = [...new Set(dayEnds)].sort().slice(-IG_TOTAL_DAYS);
  for (const [metric, column] of Object.entries(IG_ACCOUNT_TOTALS)) {
    let failedDays = 0;
    for (const end of closings) {
      const closing = Math.floor(Date.parse(end) / 1000);
      const r = await call(`/${ig.id}/insights`, { metric, metric_type: 'total_value', period: 'day', since: closing - 86400 + 1, until: closing }, as);
      if (!r.ok) {
        failedDays++;
        errors[metric] = { code: r.error ? r.error.code : null, message: r.error ? r.error.message : 'unknown' };
        continue;
      }
      const d = r.body && r.body.data && r.body.data[0];
      const tv = d && d.total_value;
      if (tv && typeof tv.value === 'number') rowFor(dayDescribed(end))[column] = tv.value;
    }
    if (failedDays && failedDays < closings.length) errors[metric].days_failed = failedDays;
  }

  const rows = [...byDate.values()];
  if (Object.keys(errors).length) rows.forEach((r) => { r.errors = errors; });
  return { rows, errorCount: Object.keys(errors).length };
}

// CALENDAR-MONTH totals, for the monthly Instagram dashboard (Asana, Filip,
// Nov 2026). It wants Accounts reached, Views and Interactions per account per
// month, as Meta's own app shows them.
//
// None of these can be built from the daily rows above. Reach is UNIQUE
// accounts, so thirty daily reaches added together count a regular follower
// thirty times; and views and interactions are only held for the collection
// day, as a part-day figure. Meta does serve each of them as one total_value
// over a since/until range, which is the number the app shows - so ask for
// exactly that, once a month per account per metric.
//
// Instagram serves account insights for roughly the last 30 days, so a month
// has to be read while it is still inside that window: the month so far every
// night, and the month just ended on the first nights of the next. A month
// that has gone past the window cannot be filled in later - which is why this
// runs nightly rather than once on the 1st.
//
// Meta's days run midnight to midnight PACIFIC (end_time 07:00Z in summer,
// 08:00Z in winter), so the month is too.
const IG_MONTH_METRICS = ['reach', 'views', 'total_interactions', 'accounts_engaged'];
// Reach and accounts engaged are unique counts: two windows cannot be added.
const IG_MONTH_UNIQUE = new Set(['reach', 'accounts_engaged']);
// Keep reading the month just ended for this many days into the next one, so a
// night or two lost to an outage does not lose the month.
const IG_MONTH_GRACE_DAYS = 10;
const IG_MAX_RANGE = 30 * 86400;

// Unix seconds of midnight Pacific on y-m-d (m 1-based; overflow is fine).
function pacificMidnight(y, m, d) {
  const guess = Date.UTC(y, m - 1, d, 8);
  const part = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', timeZoneName: 'shortOffset' })
    .formatToParts(new Date(guess)).find((x) => x.type === 'timeZoneName');
  const off = Number(((part && part.value) || 'GMT-8').replace('GMT', '')) || -8;
  return Date.UTC(y, m - 1, d, -off) / 1000;
}

// The months to read on this run: this month's finished days so far, and last
// month while it is inside the grace days. Pacific calendar throughout.
function monthWindows(runStarted) {
  const now = Math.floor(runStarted.getTime() / 1000);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(runStarted).reduce((o, x) => { o[x.type] = Number(x.value); return o; }, {});
  const y = parts.year; const m = parts.month; const today = parts.day;
  const label = (yy, mm) => `${yy}-${String(mm).padStart(2, '0')}-01`;
  const out = [];
  // This month: the days that have closed, i.e. up to midnight this morning.
  if (today > 1) {
    out.push({ month: label(y, m), start: pacificMidnight(y, m, 1), end: pacificMidnight(y, m, today), lastDay: pacificMidnight(y, m, today - 1), days: today - 1, complete: false });
  }
  const py = m === 1 ? y - 1 : y; const pm = m === 1 ? 12 : m - 1;
  if (today <= IG_MONTH_GRACE_DAYS) {
    const daysIn = new Date(Date.UTC(py, pm, 0)).getUTCDate();
    out.push({ month: label(py, pm), start: pacificMidnight(py, pm, 1), end: pacificMidnight(y, m, 1), lastDay: pacificMidnight(py, pm, daysIn), days: daysIn, complete: true });
  }
  return out.filter((w) => w.end > w.start && now >= w.end);
}

async function monthTotal(call, igId, metric, since, until, as) {
  const r = await call(`/${igId}/insights`, { metric, metric_type: 'total_value', period: 'day', since, until }, as);
  if (!r.ok) return { error: { code: r.error ? r.error.code : null, message: r.error ? r.error.message : 'unknown' } };
  const d = r.body && r.body.data && r.body.data[0];
  const v = d && d.total_value && d.total_value.value;
  return typeof v === 'number' ? { value: v } : { value: null };
}

async function collectAccountMonths({ ig, page, as, call, runStarted }) {
  const rows = [];
  let errorCount = 0;
  for (const w of monthWindows(runStarted)) {
    // since one second after the month opens: Meta counts every day whose
    // CLOSING falls inside [since, until], both ends inclusive (probed for
    // follows, 29 Sept 2026), and the previous month's last day closes at
    // exactly w.start.
    const since = w.start + 1; const until = w.end;
    const row = {
      ig_user_id: ig.id, page_id: page.page_id, ig_username: ig.username || null,
      month: w.month, days_covered: w.days, complete: w.complete,
      collected_at: runStarted.toISOString(),
    };
    const errors = {};
    for (const metric of IG_MONTH_METRICS) {
      let got = await monthTotal(call, ig.id, metric, since, until, as);
      // A 31-day month is past the 30-day range Meta allows. Read all but the
      // last day, then the last day: views and interactions add up; a unique
      // count does not, so it keeps the first days and says how many.
      if (got.error && until - since > IG_MAX_RANGE) {
        const cut = w.lastDay;
        const a = await monthTotal(call, ig.id, metric, since, cut, as);
        if (!a.error && IG_MONTH_UNIQUE.has(metric)) {
          got = a; row[`${metric}_days`] = w.days - 1;
        } else if (!a.error) {
          const b = await monthTotal(call, ig.id, metric, cut + 1, until, as);
          // Both halves or nothing: a missing half would write a short total
          // over a stored one.
          got = b.error ? b : { value: a.value === null || b.value === null ? null : a.value + b.value };
        } else got = a;
      }
      if (got.error) { errors[metric] = got.error; continue; }
      // Only what was observed is written, so a bad night cannot blank a
      // figure an earlier night stored.
      if (got.value !== null) {
        row[metric] = got.value;
        if (IG_MONTH_UNIQUE.has(metric) && row[`${metric}_days`] === undefined) row[`${metric}_days`] = w.days;
      }
    }
    row.errors = Object.keys(errors).length ? errors : null;
    if (row.errors) errorCount++;
    rows.push(row);
  }
  return { rows, errorCount };
}

// STORIES (5 Nov 2026). The /media edge never returns them, so until now not
// one Story was held - while the app's own monthly Views count them. A Story
// lives 24 hours and so do its insights, so each one is read while it is live:
// nightly here, and hourly by collector/ig-stories.js where the Mini runs it.
// Every reading overwrites the day's row, so the last one before expiry is the
// one kept.
const IG_STORY_METRICS = ['reach', 'views', 'replies', 'shares', 'total_interactions', 'follows', 'profile_visits'];

// Media insights come back as values[0].value on some metrics and as
// total_value.value on others, depending on version and metric.
function mediaValue(res) {
  if (!res || !res.ok) return null;
  const d = res.body && res.body.data && res.body.data[0];
  if (!d) return null;
  if (d.total_value && typeof d.total_value.value === 'number') return d.total_value.value;
  const v = d.values && d.values[0];
  return v && typeof v.value === 'number' ? v.value : null;
}

async function collectStories({ ig, page, as, call, runStarted, collectedDate }) {
  const res = await call(`/${ig.id}/stories`, { fields: IG_MEDIA_FIELDS, limit: 100 }, as);
  if (!res.ok) return { media: [], metrics: [], error: res.error || { message: 'unknown' } };
  const media = []; const metrics = [];
  for (const r of (res.body && res.body.data) || []) {
    media.push({
      media_id: r.id, page_id: page.page_id, ig_user_id: ig.id, ig_username: ig.username || null,
      media_type: r.media_type || null, media_product_type: r.media_product_type || 'STORY',
      caption: r.caption || null, permalink: r.permalink || null,
      thumbnail_url: r.thumbnail_url || (r.media_type !== 'VIDEO' && r.media_url) || null,
      timestamp: r.timestamp,
    });
    const errors = {}; const values = {};
    for (const metric of IG_STORY_METRICS) {
      const m = await call(`/${r.id}/insights`, { metric }, as);
      if (m.ok) values[metric] = mediaValue(m);
      else errors[metric] = { code: m.error ? m.error.code : null, message: m.error ? m.error.message : 'unknown' };
    }
    // Taps forward and back, exits and swipes away: how far people watched.
    let navigation = null;
    const nav = await call(`/${r.id}/insights`, { metric: 'navigation', breakdown: 'story_navigation_action_type' }, as);
    if (nav.ok) {
      const d = nav.body && nav.body.data && nav.body.data[0];
      const bd = d && d.total_value && d.total_value.breakdowns && d.total_value.breakdowns[0];
      const out = {};
      for (const x of (bd && bd.results) || []) {
        if (x.dimension_values && typeof x.value === 'number') out[String(x.dimension_values[0]).toLowerCase()] = x.value;
      }
      navigation = Object.keys(out).length ? out : null;
    } else errors.navigation = { code: nav.error ? nav.error.code : null, message: nav.error ? nav.error.message : 'unknown' };
    metrics.push({
      media_id: r.id, page_id: page.page_id, collected_date: collectedDate, collected_at: runStarted.toISOString(),
      reach: values.reach ?? null, views: values.views ?? null, saved: null,
      total_interactions: values.total_interactions ?? null,
      likes: null, comments: null, shares: values.shares ?? null,
      follows: values.follows ?? null, profile_visits: values.profile_visits ?? null, profile_activity: null,
      reels_avg_watch_time_ms: null, reels_total_watch_time_ms: null,
      replies: values.replies ?? null, navigation,
      errors: Object.keys(errors).length ? errors : null,
    });
  }
  return { media, metrics };
}

// AUDIENCE (5 Nov 2026): who follows each account and who engaged with it, by
// age, gender, country and city. Facebook withdrew Page demographics in 2024;
// Instagram still serves these, as lifetime total_value with one breakdown per
// call. Meta withholds them below 100 followers - that comes back as an error
// and is stored as one, not as an empty audience.
const IG_AUDIENCE = [
  { kind: 'followers', metric: 'follower_demographics' },
  { kind: 'engaged', metric: 'engaged_audience_demographics', timeframe: 'this_month' },
];
const IG_AUDIENCE_BREAKDOWNS = ['age', 'gender', 'country', 'city'];

async function collectAudience({ ig, page, as, call, runStarted, collectedDate }) {
  const rows = [];
  for (const a of IG_AUDIENCE) {
    for (const breakdown of IG_AUDIENCE_BREAKDOWNS) {
      const params = { metric: a.metric, period: 'lifetime', metric_type: 'total_value', breakdown };
      let r = await call(`/${ig.id}/insights`, a.timeframe ? { ...params, timeframe: a.timeframe } : params, as);
      // follower_demographics has taken a timeframe in some versions and
      // refused one in others: ask the other way once before giving up.
      if (!r.ok && !a.timeframe) r = await call(`/${ig.id}/insights`, { ...params, timeframe: 'this_month' }, as);
      const row = {
        ig_user_id: ig.id, page_id: page.page_id, ig_username: ig.username || null,
        collected_date: collectedDate, kind: a.kind, breakdown, data: null, errors: null,
        collected_at: runStarted.toISOString(),
      };
      if (!r.ok) {
        row.errors = { code: r.error ? r.error.code : null, message: r.error ? r.error.message : 'unknown' };
      } else {
        const d = r.body && r.body.data && r.body.data[0];
        const bd = d && d.total_value && d.total_value.breakdowns && d.total_value.breakdowns[0];
        const out = {};
        for (const x of (bd && bd.results) || []) {
          if (x.dimension_values && typeof x.value === 'number') out[String(x.dimension_values[0])] = x.value;
        }
        row.data = Object.keys(out).length ? out : null;
      }
      rows.push(row);
    }
  }
  return { rows, errorCount: rows.filter((r) => r.errors).length };
}

module.exports = {
  collectStories, collectAudience, IG_STORY_METRICS, IG_AUDIENCE, IG_AUDIENCE_BREAKDOWNS, IG_TOTAL_DAYS,
  collectInstagram, collectAccountMetrics, collectAccountMonths, monthWindows, pacificMidnight,
  IG_MONTH_METRICS,
  IG_METRICS, IG_FEED_METRICS, IG_REELS_METRICS,
  IG_ACCOUNT_SERIES, IG_ACCOUNT_TOTALS, IG_ACCOUNT_BREAKDOWNS, IG_FOLLOW_SPLIT,
  IG_MEDIA_FIELDS,
};
