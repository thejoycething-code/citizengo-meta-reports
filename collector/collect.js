#!/usr/bin/env node
'use strict';
// Nightly collector. Reads organic post performance for every page the token can
// reach and writes it to Supabase (or to data/*.ndjson when no credentials are
// present, so the whole thing can be verified against the live API first).
//
// Shape of the work, all three steps forced on us by the Phase 0 probe:
//   1. Exchange the user token for PAGE tokens. Page-scoped edges reject user
//      tokens outright (#210 / #190).
//   2. List posts with ONLY ungated fields. One gated field (comments.summary,
//      reactions...) returns #10 and loses every post in the call.
//   3. Fetch metrics one call per metric. One invalid metric fails the whole
//      call, so batching is not an option.
//
// Usage:
//   node collector/collect.js [--dry-run] [--lookback-days N] [--max-posts N]
//                             [--concurrency N] [page_id ...]

const path = require('path');
const { loadEnv, makeClient } = require('../lib/graph');
const { mapLimit } = require('../lib/pool');
const { makeSink } = require('./lib/sinks');
const { collectInstagram } = require('./instagram');
const { collectAdSpend } = require('./adspend');

loadEnv();

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const DRY_RUN = args.includes('--dry-run');
const LOOKBACK_DAYS = Number(flag('lookback-days', process.env.LOOKBACK_DAYS || 30));
const MAX_POSTS = Number(flag('max-posts', process.env.MAX_POSTS || 200));
const CONCURRENCY = Number(flag('concurrency', process.env.CONCURRENCY || 4));
// Concurrency WITHIN a post. The insights calls for one post are independent of
// each other - separate metrics, separate breakdowns - but ran strictly in
// sequence, so only CONCURRENCY requests were ever in flight no matter how many
// posts were pending. A 90-day run measured 5.2 calls/second across 34,596 calls:
// 110 minutes, almost all of it waiting.
//
// Total in flight is CONCURRENCY x METRIC_CONCURRENCY. Meta's limit is per page
// and generous (4800 x engaged users per day), and this run spreads across 36
// pages, so latency rather than rate limiting is the constraint.
const METRIC_CONCURRENCY = Number(flag('metric-concurrency', process.env.METRIC_CONCURRENCY || 4));
// Pages processed at once. Kept modest: each page already runs
// CONCURRENCY x METRIC_CONCURRENCY requests, so this multiplies total in-flight.
const PAGE_CONCURRENCY = Number(flag('page-concurrency', process.env.PAGE_CONCURRENCY || 6));
// Accepts bare ids and comma-separated lists. Previously only bare numeric args
// matched, so "--page-ids 123,456" matched NOTHING and silently collected every
// page instead of two - which on a 90-day run is a very expensive typo.
const ONLY_PAGES = args
  .filter((a) => /^\d{6,}(,\d{6,})*$/.test(a))
  .flatMap((a) => a.split(','));

// META_TOKENS takes a newline- or comma-separated list, one System User token per
// Business Portfolio. META_TOKEN (singular) still works for a single-portfolio run.
const TOKENS = String(process.env.META_TOKENS || process.env.META_TOKEN || '')
  .split(/[\n,]/).map((t) => t.trim()).filter(Boolean);
const VERSION = process.env.GRAPH_VERSION || 'v23.0';
if (!TOKENS.length) {
  console.error('No token. Set META_TOKENS (list) or META_TOKEN (single). See README.md.');
  process.exit(2);
}

const client = makeClient({ token: TOKENS[0], version: VERSION });
const sink = makeSink({ dryRun: DRY_RUN, dir: path.join(__dirname, '..', 'data') });

// Deterministic run id — no Math.random, so a rerun on the same day is traceable
// to the same logical run.
const RUN_STARTED = new Date();
const RUN_ID = `run-${RUN_STARTED.toISOString().slice(0, 19).replace(/[:T]/g, '')}`;
const COLLECTED_DATE = RUN_STARTED.toISOString().slice(0, 10);

let apiCalls = 0;
// Per-page call attribution.
//
// api_calls used to be a delta on the global counter: a start value at the top of
// a page, subtracted at the bottom. That was correct only while pages
// ran one at a time. Once six run concurrently every page counts every other
// page's calls too, and the first concurrent 90-day run reported 198,840 calls
// for work that takes about 35,000 - and an impossible 102 calls/second.
//
// AsyncLocalStorage attributes each call to whichever page's async context made
// it, which survives the awaits and the concurrency that broke the delta.
const { AsyncLocalStorage } = require('node:async_hooks');
const pageCalls = new AsyncLocalStorage();

async function call(pathname, params, opts) {
  apiCalls++;
  const ctx = pageCalls.getStore();
  if (ctx) ctx.n++;
  return client.get(pathname, params, opts);
}

// --- metric extraction -----------------------------------------------------

function firstValue(res) {
  if (!res || !res.ok) return null;
  const d = res.body && res.body.data && res.body.data[0];
  const v = d && d.values && d.values[0];
  return v ? v.value : null;
}

// Breakdown responses look like:
//   values: [{value: 789, is_from_ads: "0"}, {value: 0, is_from_ads: "1"}]
function breakdown(res, key) {
  const out = {};
  if (!res || !res.ok) return out;
  const d = res.body && res.body.data && res.body.data[0];
  for (const v of (d && d.values) || []) {
    if (v && v[key] !== undefined) out[String(v[key])] = v.value;
  }
  return out;
}

function num(v) {
  return typeof v === 'number' ? v : null;
}

// Meta's reaction keys are like/love/wow/haha/sorry/anger. Older docs say
// sad/angry, so accept either rather than silently dropping a column.
function reactionCol(map, ...keys) {
  for (const k of keys) if (map && typeof map[k] === 'number') return map[k];
  return null;
}

// One call per metric returns a VALUE PER DAY, so six calls fill the whole
// window for a page — very cheap next to nine calls per post.
const PAGE_METRICS = {
  page_views_total: 'views_total',
  page_media_view: 'media_view',
  page_total_media_view_unique: 'media_view_unique',
  page_post_engagements: 'post_engagements',
  page_follows: 'follows',
  page_daily_follows: 'daily_follows',
};

const METRICS = [
  'post_media_view',
  'post_total_media_view_unique',
  'post_reactions_by_type_total',
  'post_clicks',
  'post_clicks_by_type',
  'post_activity_by_action_type',
  'post_video_views',
  'post_video_view_time',
  'post_video_avg_time_watched',
  'post_video_complete_views_30s',
];

async function collectPostMetrics(post, as) {
  const errors = {};

  const results = {};
  for (const m of METRICS) {
    const r = await call(`/${post.id}/insights`, { metric: m }, as);
    results[m] = r;
    if (!r.ok) {
      // #200 on post_total_media_view_unique is expected on low-follower pages —
      // record it as unavailable, not as a failure.
      errors[m] = { code: r.error ? r.error.code : null, message: r.error ? r.error.message : 'unknown' };
    }
  }
  const ads = await call(`/${post.id}/insights`, { metric: 'post_media_view', breakdown: 'is_from_ads' }, as);
  const fol = await call(`/${post.id}/insights`, { metric: 'post_media_view', breakdown: 'is_from_followers' }, as);
  if (!ads.ok) errors.breakdown_is_from_ads = { code: ads.error && ads.error.code };
  if (!fol.ok) errors.breakdown_is_from_followers = { code: fol.error && fol.error.code };

  const byAds = breakdown(ads, 'is_from_ads');
  const byFol = breakdown(fol, 'is_from_followers');
  const reactions = firstValue(results.post_reactions_by_type_total) || {};
  const reactionTotal = Object.values(reactions).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);

  return {
    post_id: post.id,
    page_id: post.page_id,
    collected_date: COLLECTED_DATE,
    collected_at: RUN_STARTED.toISOString(),

    views_total: num(firstValue(results.post_media_view)),
    views_unique: num(firstValue(results.post_total_media_view_unique)),
    views_organic: num(byAds['0']),
    views_paid: num(byAds['1']),
    views_from_followers: num(byFol['1']),
    views_from_nonfollowers: num(byFol['0']),

    reactions_total: Object.keys(reactions).length ? reactionTotal : null,
    reactions_like: reactionCol(reactions, 'like'),
    reactions_love: reactionCol(reactions, 'love'),
    reactions_wow: reactionCol(reactions, 'wow'),
    reactions_haha: reactionCol(reactions, 'haha'),
    reactions_sorry: reactionCol(reactions, 'sorry', 'sad'),
    reactions_anger: reactionCol(reactions, 'anger', 'angry'),

    shares_total: post.shares_total,
    clicks_total: num(firstValue(results.post_clicks)),
    clicks_by_type: firstValue(results.post_clicks_by_type) || null,
    activity_by_type: firstValue(results.post_activity_by_action_type) || null,
    video_views: num(firstValue(results.post_video_views)),
    video_view_time_ms: num(firstValue(results.post_video_view_time)),
    // Meta reports this in milliseconds; stored as seconds because nobody
    // thinks about watch time in milliseconds.
    video_avg_seconds_watched: (() => {
      const ms = num(firstValue(results.post_video_avg_time_watched));
      return ms === null ? null : Number((ms / 1000).toFixed(1));
    })(),
    video_complete_views_30s: num(firstValue(results.post_video_complete_views_30s)),

    // Filled in by listCommentCounts() after this returns; stays null if the
    // token lacks pages_read_user_content.
    comments_total: null,

    errors: Object.keys(errors).length ? errors : null,
  };
}

// Collects the daily page series and folds the six metrics into one row per
// date. Meta caps an insights date range at roughly 93 days, so a longer
// lookback is clamped rather than silently returning nothing.
async function collectPageInsights(page, as, followersSnapshot) {
  const days = Math.min(LOOKBACK_DAYS, 90);
  const until = new Date(RUN_STARTED);
  const since = new Date(RUN_STARTED.getTime() - days * 86400000);
  const byDate = new Map();
  const errors = {};

  for (const [metric, column] of Object.entries(PAGE_METRICS)) {
    const res = await call(`/${page.page_id}/insights`, {
      metric,
      period: 'day',
      since: Math.floor(since.getTime() / 1000),
      until: Math.floor(until.getTime() / 1000),
    }, as);

    if (!res.ok) {
      errors[metric] = { code: res.error ? res.error.code : null, message: res.error ? res.error.message : 'unknown' };
      continue;
    }
    const series = (res.body && res.body.data && res.body.data[0] && res.body.data[0].values) || [];
    for (const point of series) {
      if (!point || point.end_time === undefined) continue;
      // end_time is the END of the day the value covers.
      const date = String(point.end_time).slice(0, 10);
      if (!byDate.has(date)) {
        byDate.set(date, {
          page_id: page.page_id,
          metric_date: date,
          followers_snapshot: followersSnapshot ?? null,
          collected_at: RUN_STARTED.toISOString(),
          errors: null,
        });
      }
      byDate.get(date)[column] = typeof point.value === 'number' ? point.value : null;
    }
  }

  const rows = [...byDate.values()];
  if (Object.keys(errors).length) rows.forEach((r) => { r.errors = errors; });
  return { rows, errorCount: Object.keys(errors).length };
}

// --- post listing ----------------------------------------------------------

const POST_FIELDS = [
  'id', 'created_time', 'message', 'permalink_url', 'status_type',
  'is_published', 'full_picture',
  // unshimmed_url is the real destination; target.url is Facebook's wrapped
  // version. Prefer the former, fall back to the latter.
  'attachments{media_type,type,unshimmed_url,target{url}}',
  'shares',
].join(',');

async function listPosts(pageId, as) {
  const cutoff = new Date(RUN_STARTED.getTime() - LOOKBACK_DAYS * 86400000);
  const out = [];
  let next = null;

  while (out.length < MAX_POSTS) {
    const params = next
      ? { fields: POST_FIELDS, limit: 100, after: next }
      : { fields: POST_FIELDS, limit: 100 };
    const res = await call(`/${pageId}/published_posts`, params, as);
    if (!res.ok) return { posts: out, error: res.error };

    const rows = (res.body && res.body.data) || [];
    if (!rows.length) break;

    let reachedCutoff = false;
    for (const r of rows) {
      if (new Date(r.created_time) < cutoff) { reachedCutoff = true; break; }
      out.push({
        post_id: r.id,
        id: r.id,
        page_id: pageId,
        created_time: r.created_time,
        message: r.message || null,
        permalink_url: r.permalink_url || null,
        status_type: r.status_type || null,
        media_type: (r.attachments && r.attachments.data && r.attachments.data[0]
          && (r.attachments.data[0].media_type || r.attachments.data[0].type)) || null,
        link_url: (() => {
          const a = r.attachments && r.attachments.data && r.attachments.data[0];
          if (!a) return null;
          const u = a.unshimmed_url || (a.target && a.target.url) || null;
          // Photo and video attachments carry a facebook.com URL pointing back
          // at the post itself. That is not an outbound link and recording it
          // as one would corrupt any analysis of what we link to.
          if (!u || /^https?:\/\/(www\.)?facebook\.com\//.test(u)) return null;
          return u;
        })(),
        // Signature params (oh/oe/_nc_gid) rotate on every request AND expire, so
        // the signed URL is both churn and dead-on-arrival for historical posts.
        // Keep only the stable path, as a media identity key — not a fetchable URL.
        full_picture: r.full_picture ? r.full_picture.split('?')[0] : null,
        is_published: r.is_published === undefined ? null : r.is_published,
        shares_total: (r.shares && typeof r.shares.count === 'number') ? r.shares.count : null,
      });
      if (out.length >= MAX_POSTS) break;
    }
    if (reachedCutoff) break;
    next = res.body && res.body.paging && res.body.paging.cursors && res.body.paging.cursors.after;
    if (!next) break;
  }
  return { posts: out, error: null };
}

// --- status classification -------------------------------------------------
//
// Three distinct outcomes that a naive "did anything error?" check conflates:
//   - views_unique missing on its own is EXPECTED. Meta returns #200 for it on
//     low-follower pages, so it must not colour the page's status.
//   - a row with no metrics at all is a real loss, even though the post object
//     still gave us shares.
//   - a page only failed if the post listing failed, or if every single row came
//     back empty.
function hasAnyMetric(m) {
  return m.views_total !== null || m.reactions_total !== null
    || m.clicks_total !== null || m.video_views !== null;
}

function isBenign(errors) {
  if (!errors) return true;
  const keys = Object.keys(errors);
  return keys.length === 1 && keys[0] === 'post_total_media_view_unique';
}

// The signature of a missing read_insights scope: every metric empty on every
// post, and NOT A SINGLE ERROR recorded, because Meta returned 200 with an empty
// array each time. A genuine per-post refusal (#200 on a low-follower page)
// records an error, so the two are distinguishable.
function looksLikeMissingInsightsScope(metrics) {
  if (!metrics.length) return false;
  return metrics.every((m) => !hasAnyMetric(m) && !m.errors);
}

function classify(posts, metrics) {
  if (!posts.length) return { status: 'ok', empty: 0, degraded: 0 };
  const empty = metrics.filter((m) => !hasAnyMetric(m)).length;
  const degraded = metrics.filter((m) => hasAnyMetric(m) && !isBenign(m.errors)).length;
  if (empty === metrics.length) return { status: 'failed', empty, degraded };
  if (empty || degraded) return { status: 'partial', empty, degraded };
  return { status: 'ok', empty, degraded };
}

// Comment counts live behind pages_read_user_content. They are fetched in their
// OWN listing pass rather than added to POST_FIELDS, because a gated field in the
// main query fails the entire call with #10 and loses every post — which is
// exactly what happened during the Phase 0 probe. Here a permission failure costs
// only the comment counts, and every other metric still lands.
//
// One extra call per page (plus pagination), not one per post.
// Comment AND reaction counts, from the post object.
//
// Reactions used to come from the post_reactions_by_type_total insights metric
// while comments and shares came from the post object - two different counting
// systems inside one engagement rate. They do not agree, and the difference is
// not noise.
//
// Measured across 406 posts on 30 Aug 2026: insights is NEVER lower than the
// object count, identical on 39% of posts, and higher on the rest. Splitting by
// whether the post was shared at all is what explains it:
//
//   posts WITH shares   323 posts   75% differ   average gap +22.2%
//   posts WITHOUT       83 posts     7% differ   average gap  +6.0%
//
// So post_reactions_by_type_total counts reactions the post attracted INCLUDING
// on reshares of it, while reactions.summary on the post object counts reactions
// on that post alone - which is the number Facebook's own UI shows, and the one
// a campaigner will compare against.
//
// The total therefore comes from here. The per-type breakdown still comes from
// insights, because the object does not offer one - so reactions_like..anger
// will not sum exactly to reactions_total, and that is deliberate rather than a
// rounding error.
const ENGAGEMENT_FIELDS =
  'id,created_time,comments.summary(true).limit(0),reactions.summary(true).limit(0)';

async function listCommentCounts(pageId, as) {
  const cutoff = new Date(RUN_STARTED.getTime() - LOOKBACK_DAYS * 86400000);
  const counts = new Map();
  const reactions = new Map();
  let next = null;

  while (counts.size < MAX_POSTS) {
    const params = next
      ? { fields: ENGAGEMENT_FIELDS, limit: 100, after: next }
      : { fields: ENGAGEMENT_FIELDS, limit: 100 };
    const res = await call(`/${pageId}/published_posts`, params, as);
    if (!res.ok) {
      return { counts, reactions, error: res.error ? res.error.message : 'unknown' };
    }
    const rows = (res.body && res.body.data) || [];
    if (!rows.length) break;

    let reachedCutoff = false;
    for (const r of rows) {
      if (new Date(r.created_time) < cutoff) { reachedCutoff = true; break; }
      const total = r.comments && r.comments.summary
        ? r.comments.summary.total_count : null;
      if (typeof total === 'number') counts.set(r.id, total);
        // Reactions from the same object as comments and shares, so all three
        // components of the engagement rate are counted the same way.
        const react = r.reactions && r.reactions.summary
          ? r.reactions.summary.total_count : null;
        if (typeof react === 'number') reactions.set(r.id, react);
    }
    if (reachedCutoff) break;
    next = res.body && res.body.paging && res.body.paging.cursors && res.body.paging.cursors.after;
    if (!next) break;
  }
  return { counts, reactions, error: null };
}

// --- per page --------------------------------------------------------------

async function collectPage(page, pageToken, out) {
  return pageCalls.run({ n: 0 }, () => collectPageInner(page, pageToken, out));
}

async function collectPageInner(page, pageToken, out) {
  // Pages run in parallel, so their progress lines must not interleave. Each page
  // writes into its own buffer and the caller flushes it in one go when the page
  // finishes. Shadowing console here keeps the 19 existing log calls unchanged.
  const console = { log: out || ((...a) => global.console.log(...a)) };
  const as = pageToken ? { token: pageToken } : {};
  const started = new Date().toISOString();
  console.log(`\n── ${page.name} (${page.page_id})`);

  await sink.upsert('meta_pages', [{
    page_id: page.page_id,
    name: page.name,
    platform: 'facebook',
    followers_count: page.followers_count ?? null,
    is_active: true,
    last_seen_at: started,
  }]);

  const { posts, error } = await listPosts(page.page_id, as);
  if (error) {
    console.log(`   published_posts FAILED #${error.code}: ${error.message.slice(0, 90)}`);
    await sink.upsert('meta_collection_runs', [{
      run_id: RUN_ID, page_id: page.page_id, started_at: started,
      finished_at: new Date().toISOString(), status: 'failed',
      posts_seen: 0, metrics_written: 0, api_calls: pageCalls.getStore().n,
      error_code: error.code || null, error_message: error.message.slice(0, 500),
    }]);
    return { status: 'failed', posts: 0, metrics: 0 };
  }

  console.log(`   ${posts.length} posts in the last ${LOOKBACK_DAYS}d · fetching metrics (${CONCURRENCY} posts x ${METRIC_CONCURRENCY} metrics = ${CONCURRENCY * METRIC_CONCURRENCY} in flight) ...`);
  if (posts.length) {
    await sink.upsert('meta_posts', posts.map((p) => ({
      post_id: p.post_id, page_id: p.page_id, created_time: p.created_time,
      message: p.message, permalink_url: p.permalink_url, status_type: p.status_type,
      media_type: p.media_type, full_picture: p.full_picture, is_published: p.is_published,
      link_url: p.link_url,
    })));
  }

  const metrics = await mapLimit(posts, CONCURRENCY, (p) => collectPostMetrics(p, as));

  // Merged in after the fact so a failure here cannot affect anything else.
  const { counts: commentCounts, reactions: reactionCounts, error: commentError } = await listCommentCounts(page.page_id, as);
  if (commentError) {
    console.log(`   comment counts unavailable — ${commentError.slice(0, 80)}`);
    console.log('     (needs the pages_read_user_content scope; every other metric is unaffected)');
  } else {
    let applied = 0;
    let reactionsApplied = 0;
    for (const m of metrics) {
      if (commentCounts.has(m.post_id)) { m.comments_total = commentCounts.get(m.post_id); applied++; }
      // Overrides the insights figure with the post object's own count, which is
      // what Facebook's UI shows. The per-type breakdown still comes from
      // insights, so the parts will not sum exactly to the total.
      if (reactionCounts.has(m.post_id)) {
        m.reactions_total = reactionCounts.get(m.post_id); reactionsApplied++;
      }
    }
    console.log(`   comment counts: ${applied}/${metrics.length} · reactions: ${reactionsApplied}/${metrics.length}`);
  }

  if (metrics.length) await sink.upsert('meta_post_metrics', metrics);

  // Instagram. Silently skipped when no account is linked - most Pages have
  // none, and reporting that as a failure would be noise.
  try {
    const ig = await collectInstagram({
      page, as, call,
      lookbackDays: LOOKBACK_DAYS, maxPosts: MAX_POSTS,
      runStarted: RUN_STARTED, collectedDate: COLLECTED_DATE,
      log: (m) => console.log(m),
    });
    if (ig.linked && ig.media.length) {
      await sink.upsert('meta_ig_media', ig.media);
      await sink.upsert('meta_ig_media_metrics', ig.metrics);
      const withReach = ig.metrics.filter((m) => m.reach !== null).length;
      console.log(`   instagram: @${ig.username} — ${ig.media.length} posts, ${withReach} with reach`);
    }
  } catch (e) {
    // Never let Instagram break the Facebook collection it runs alongside.
    console.log(`   instagram: failed — ${e.message.slice(0, 80)}`);
  }

  // Page-level series. Independent of posts: a page with nothing published in
  // the window still has views and follower movement worth recording.
  const { rows: pageRows, errorCount: pageErrors } = await collectPageInsights(page, as, page.followers_count);
  if (pageRows.length) {
    await sink.upsert('meta_page_metrics', pageRows);
    console.log(`   page insights: ${pageRows.length} day(s)${pageErrors ? ` · ${pageErrors} metric(s) unavailable` : ''}`);
  } else {
    console.log(`   page insights: none returned${pageErrors ? ` · ${pageErrors} metric(s) errored` : ''}`);
  }

  const { status, empty, degraded } = classify(posts, metrics);
  const scopeProblem = looksLikeMissingInsightsScope(metrics);
  if (scopeProblem) {
    console.log('   NO METRICS AT ALL, and Meta reported no error on any call.');
    console.log('     That is the signature of a token without the read_insights scope:');
    console.log('     Meta answers 200 with an empty result instead of refusing.');
    console.log('     Check the PAGE token, not just the user token:');
    console.log('       graph.facebook.com/v23.0/debug_token?input_token=PAGE_TOKEN&access_token=PAGE_TOKEN');
    console.log('     read_insights must appear in "scopes". Regenerate the token after');
    console.log('     changing app permissions — existing tokens never gain new scopes.');
  }
  const reach = metrics.filter((m) => m.views_unique !== null).length;
  console.log(`   wrote ${metrics.length} metric rows · ${reach} with unique reach` +
    (empty ? ` · ${empty} with NO metrics` : '') +
    (degraded ? ` · ${degraded} degraded` : '') +
    ` · ${pageCalls.getStore().n} API calls`);

  await sink.upsert('meta_collection_runs', [{
    run_id: RUN_ID, page_id: page.page_id, started_at: started,
    finished_at: new Date().toISOString(), status,
    posts_seen: posts.length, metrics_written: metrics.length,
    api_calls: pageCalls.getStore().n, error_code: null,
    error_message: scopeProblem
      ? 'no metrics and no errors on any post - token probably lacks read_insights'
      : (empty || degraded) ? `${empty} rows with no metrics, ${degraded} degraded` : null,
  }]);
  return { status, posts: posts.length, metrics: metrics.length };
}

async function main() {
  console.log(`Collector ${RUN_ID} · Graph ${VERSION} · sink=${sink.name}${DRY_RUN ? ' (dry run)' : ''}`);

  // Step 1: page tokens, per user token. Without a PAGE token every page-scoped
  // edge below returns #210. Tokens are merged: first token to reach a page wins,
  // so overlapping portfolio grants are harmless.
  const byPageId = new Map();
  let tokenFailures = 0;
  for (let i = 0; i < TOKENS.length; i++) {
    const pagesForToken = [];
    let accountsCursor = null;
    let accounts;
    do {
      accounts = await call('/me/accounts', accountsCursor
        ? { fields: 'id,name,followers_count,access_token', limit: 100, after: accountsCursor }
        : { fields: 'id,name,followers_count,access_token', limit: 100 }, { token: TOKENS[i] });
      if (!accounts.ok) break;
      const batch = (accounts.body && accounts.body.data) || [];
      pagesForToken.push(...batch);
      accountsCursor = accounts.body && accounts.body.paging
        && accounts.body.paging.cursors && accounts.body.paging.cursors.after;
      // Meta returns a cursor even on the final page, so stop on an empty batch
      // rather than trusting the cursor's presence.
      if (!batch.length) break;
    } while (accountsCursor && pagesForToken.length < 500);

    if (!accounts.ok) {
      tokenFailures++;
      const msg = accounts.error ? accounts.error.message : 'unknown';
      // One dead token must not abort the run — the other portfolios still work.
      console.error(`  token ${i + 1}/${TOKENS.length}: FAILED — ${msg}`);
      // "Session has expired" is diagnostic: only short-lived USER tokens carry a
      // session. A System User token has none and never expires, so this error
      // means someone pasted a Graph API Explorer token into automation — an easy
      // mistake to repeat once per Business Portfolio.
      if (/session has expired|session is invalid/i.test(msg)) {
        console.error('        ^ that is a short-lived USER token, not a System User token.');
        console.error('          Explorer tokens last ~1 hour and cannot drive a scheduled job.');
        console.error('          Get one at: business.facebook.com > Business Settings >');
        console.error('          Users > System Users > Generate New Token.');
      }
      continue;
    }
    const found = pagesForToken;
    let added = 0;
    for (const p of found) {
      if (byPageId.has(p.id)) continue;
      byPageId.set(p.id, {
        page_id: p.id, name: p.name, followers_count: p.followers_count,
        token: p.access_token, token_index: i + 1,
      });
      added++;
    }
    console.log(`  token ${i + 1}/${TOKENS.length}: ${found.length} page(s), ${added} new`);
  }
  if (tokenFailures === TOKENS.length) {
    console.error('Every token failed. Nothing to collect.');
    process.exit(1);
  }
  // Step 1b: RECOVER pages that /me/accounts no longer lists.
  //
  // /me/accounts returns only pages the user holds a DIRECT role on. Pages
  // reached through a Business Portfolio need business_management to enumerate -
  // but they are perfectly readable without it. On 29 Aug 2026 enumeration
  // dropped from 36 pages to 14 while every one of the missing 22 still handed
  // over a page token when asked for it by id.
  //
  // So: for any page we have collected before but did not just enumerate, ask
  // for it directly. Costs one call per missing page and makes the collector
  // self-healing - once a page is known, losing it from enumeration no longer
  // loses the page.
  const known = await sink.knownPageIds ? await sink.knownPageIds() : [];
  const toRecover = known.filter((id) => !byPageId.has(id));
  const recoveredRows = await mapLimit(toRecover, 8, async (known_id) => {
    for (let i = 0; i < TOKENS.length; i++) {
      const r = await call(`/${known_id}`, { fields: 'id,name,followers_count,access_token' },
        { token: TOKENS[i] });
      if (!r.ok || !r.body || !r.body.access_token) continue;
      return { id: known_id, body: r.body, token_index: i + 1 };
    }
    return null;
  });
  const recovered = [];
  for (const row of recoveredRows.filter(Boolean)) {
    byPageId.set(row.id, {
      page_id: row.body.id, name: row.body.name, followers_count: row.body.followers_count,
      token: row.body.access_token, token_index: row.token_index,
    });
    recovered.push(row.body.name || row.id);
  }
  if (recovered.length) {
    console.log(`  recovered ${recovered.length} page(s) absent from /me/accounts but still readable: ${recovered.slice(0, 6).join(', ')}${recovered.length > 6 ? `, +${recovered.length - 6} more` : ''}`);
  }

  let pages = [...byPageId.values()];
  if (ONLY_PAGES.length) {
    pages = pages.filter((p) => ONLY_PAGES.includes(p.page_id));
    console.log(`  restricted to ${pages.length} of ${byPageId.size} page(s) by --page-ids`);
    if (!pages.length) {
      console.error('  --page-ids matched no reachable page. Nothing to do.');
      process.exit(1);
    }
  }
  console.log(`${pages.length} page(s) reachable across ${TOKENS.length} token(s) · page tokens: ${pages.filter((p) => p.token).length}`);
  if (tokenFailures) console.log(`WARNING: ${tokenFailures} of ${TOKENS.length} tokens failed — coverage is incomplete.`);

  // Pages in parallel. Each page carries roughly 35 seconds of fixed cost that no
  // amount of per-post concurrency touches: listing published_posts, and the
  // comments.summary query, which Meta answers slowly regardless of size. Run
  // sequentially that is ~35s x 36 pages before a single metric is fetched, and it
  // is most of why a 90-day run took 110 minutes.
  //
  // Meta's rate limits are per PAGE, so running different pages at once spends
  // separate budgets rather than competing for one.
  //
  // Output is buffered per page and flushed when that page finishes, otherwise
  // four pages interleave their progress lines and the log becomes unreadable at
  // exactly the moment someone is trying to debug a failure.
  const summary = new Array(pages.length);
  await mapLimit(pages, PAGE_CONCURRENCY, async (page, idx) => {
    const buffered = [];
    const result = await collectPage(page, page.token, (line) => buffered.push(line));
    process.stdout.write(buffered.join('\n') + '\n');
    summary[idx] = { page: page.name, ...result };
  });

  // Once per run. Ad accounts span pages, so doing this per page would repeat
  // identical work for every one of them.
  try {
    const ads = await collectAdSpend({
      call, lookbackDays: LOOKBACK_DAYS, runStarted: RUN_STARTED,
      log: (m) => console.log(m.replace(/^ {3}/, '')),
    });
    if (ads.rows.length) await sink.upsert('meta_post_ad_spend', ads.rows);
  } catch (e) {
    console.log(`ad spend: failed — ${e.message.slice(0, 80)}`);
  }

  const written = await sink.flush();
  console.log('\nSummary');
  for (const s of summary) console.log(`  ${s.status.padEnd(8)} ${s.page} — ${s.posts} posts, ${s.metrics} metric rows`);
  console.log(`  ${apiCalls} API calls total`);
  if (Object.keys(written).length) {
    console.log('\nWritten to data/:');
    for (const [t, n] of Object.entries(written)) console.log(`  ${t}.ndjson — ${n} rows`);
  }

  // Machine-readable summary for CI to surface, and a real exit code. A green
  // nightly run over zero rows is the failure mode most likely to go unnoticed.
  const totals = summary.reduce((a, s) => ({
    posts: a.posts + s.posts, metrics: a.metrics + s.metrics,
    failed: a.failed + (s.status === 'failed' ? 1 : 0),
    partial: a.partial + (s.status === 'partial' ? 1 : 0),
  }), { posts: 0, metrics: 0, failed: 0, partial: 0 });
  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = ['### Nightly collection', '',
      `- Pages: **${summary.length}** (${totals.failed} failed, ${totals.partial} partial)`,
      `- Posts seen: **${totals.posts}**`, `- Metric rows written: **${totals.metrics}**`,
      `- API calls: **${apiCalls}**`,
      tokenFailures ? `- **${tokenFailures} token(s) failed** — coverage incomplete` : '',
      '', '| Page | Status | Posts | Metrics |', '| --- | --- | --- | --- |',
      ...summary.map((s) => `| ${s.page} | ${s.status} | ${s.posts} | ${s.metrics} |`),
    ].filter(Boolean).join('\n');
    require('fs').appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  }
  if (pages.length && totals.metrics === 0) {
    console.error('\nFAIL: pages were reachable but zero metric rows were written.');
    process.exit(1);
  }
  if (totals.failed === summary.length && summary.length) {
    console.error('\nFAIL: every page failed.');
    process.exit(1);
  }
}

main().catch((e) => { console.error('\nCollector crashed:', e); process.exit(1); });
