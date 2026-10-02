#!/usr/bin/env node
'use strict';
// X (Twitter) collector. GROUNDWORK - runs only when X credentials exist.
//
// Sits beside collector/collect.js rather than inside it: different vendor,
// different auth (per-account OAuth with rotating refresh tokens), different
// economics (billed per post returned), different schedule (see lib/xschedule.js).
// Shares the sinks, the retry, the pool and the run-ledger conventions.
//
// What one run does, per authorised account:
//   1. Refresh the account's access token; re-seal and persist the ROTATED
//      refresh token before anything else, because the old one is now dead.
//   2. /2/users/me - who this is, follower count today. One billable user read.
//   3. DAILY pass - every post aged 0-7 days, all metric groups. Each post
//      returned is one billable read; that is the intended spend. An account's
//      first run reaches back 89 days instead, so checkpoints have posts to revisit.
//   4. BACKFILL, if asked (below).
//   5. CHECKPOINT pass - held posts at day 14, 28, 60 or 85 whose last snapshot
//      predates that checkpoint, fetched by id. Missed nights catch up on their
//      own (lib/xschedule.js dueForCheckpoint). Posts already read this run by
//      the passes above are skipped.
//   Optional BACKFILL (--backfill-days N) - posts older than the daily window,
//      all metric groups. X serves private groups past its documented 30 days
//      (to ~89 on 30 Sep 2026) and refuses older ones with a partial error;
//      public metrics always arrive.
//   6. A run row with reads and estimated cost. Refuses to START when the
//      month's estimated spend has reached X_MONTHLY_BUDGET_USD.
//
// Spokesperson accounts are collected only for posts carrying a CitizenGO link.
// Everything else on a personal account is discarded before it is written.
//
// Usage:
//   node collector/x.js [--dry-run] [--lookback-days 8] [--backfill-days 3650] [--backfill-from-days 90]
//                       [--no-checkpoints] [--include-retweets] [--accounts <id> <id>] [--budget-usd 100]
//
// Dry runs without a database can still exercise the API using
// X_ACCESS_TOKENS="label:access_token,..." - that is how the one-account spike
// runs before any of this is wired up. Output lands in data/x_*.ndjson.

const path = require('path');
const fs = require('fs');
const { loadEnv } = require('../lib/graph');
const { mapLimit } = require('../lib/pool');
const { withRetry } = require('../lib/retry');
const { makeSink } = require('./lib/sinks');
const xapi = require('../lib/xapi');
const xauth = require('../lib/xauth');
const sched = require('../lib/xschedule');

loadEnv();

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const DRY_RUN = args.includes('--dry-run');
const NO_CHECKPOINTS = args.includes('--no-checkpoints') || args.includes('--no-final');
// Retweets are excluded unless asked for. The first live probe showed why: a
// retweet reports its OWN impressions (tens) beside the ORIGINAL's repost count
// (thousands), serves no private metrics, and was a sixth of every read. Our
// replies and quote posts are our content and are kept.
const INCLUDE_RETWEETS = args.includes('--include-retweets');
const LOOKBACK_DAYS = Number(flag('lookback-days', process.env.X_LOOKBACK_DAYS || sched.DAILY_DAYS));
// Set when the caller chose the window, which then wins over the first-run widening.
const LOOKBACK_EXPLICIT = args.includes('--lookback-days');
const BACKFILL_DAYS = Number(flag('backfill-days', 0));
// Where the backfill stops, in days back. Default: where the daily window starts.
// Set 90 to take only history the daily and checkpoint passes never read, so a
// deep backfill of an account already collected does not pay again for 8-89.
const BACKFILL_FROM_DAYS = flag('backfill-from-days', null) === null ? null : Number(flag('backfill-from-days', null));
const MAX_POSTS = Number(flag('max-posts', process.env.X_MAX_POSTS || 1000));
const BUDGET_USD = Number(flag('budget-usd', process.env.X_MONTHLY_BUDGET_USD || 100));
const ONLY = (() => {
  const i = args.indexOf('--accounts');
  if (i === -1) return [];
  const out = [];
  for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j]);
  return out;
})();

const CLIENT_ID = process.env.X_CLIENT_ID || '';
// The X account that owns the developer app - the only one billed at the
// owned-read rate. Unset means every account is priced at the ordinary rate,
// which over- rather than under-estimates: the safe direction for a budget.
const APP_OWNER_ID = String(process.env.X_APP_OWNER_ID || '').trim();
const CLIENT_SECRET = process.env.X_CLIENT_SECRET || '';
// PEM in an env var arrives with literal "\n" more often than not.
const PRIVATE_KEY = String(process.env.X_TOKEN_PRIVATE_KEY || '').replace(/\\n/g, '\n');

// Spend in THIS run, shared across accounts collected in parallel, and what the
// month's budget leaves. The start-of-run guard alone could not stop one large
// run - a full-history backfill of 12 accounts is ~$86 - from overshooting the
// cap, so every backfill page is checked against these before it is requested.
const RUN_SPEND = { spent: 0, remaining: Infinity, nightlyReserve: 0, stoppedAtBudget: false };

// Days of history a new account's first run backfills. 3650 reaches X's
// 3,200-post limit for every account we hold. 0 turns the automatic backfill off.
const FIRST_RUN_BACKFILL_DAYS = Number(process.env.X_FIRST_RUN_BACKFILL_DAYS ?? 3650);

// What the nightly collection needs for the rest of the month. A backfill must
// never spend it: the start-of-run guard refuses to run at all once the budget
// is gone, so a backfill that emptied it would stop the NIGHTLY collection too,
// and posts passing day 89 meanwhile lose their link clicks for good. Priced at
// the ordinary rate from the measured ~2 posts a day per account (30 Sep 2026).
function nightlyReserveFor(accountCount, now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const daysLeft = Math.max(1, Math.ceil((end - now) / 86_400_000));
  const perAccountPerDay = sched.estimateCost({ postReads: 2 * sched.READS_PER_POST, userReads: 1, owned: false });
  return Math.round(accountCount * perAccountPerDay * daysLeft * 100) / 100;
}

const RUN_STARTED = new Date();
const RUN_ID = `xrun-${RUN_STARTED.toISOString().slice(0, 19).replace(/[:T]/g, '')}`;
const COLLECTED_DATE = RUN_STARTED.toISOString().slice(0, 10);

const sink = makeSink({ dryRun: DRY_RUN, dir: path.join(__dirname, '..', 'data') });
const SUPABASE = (!DRY_RUN || (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY))
  && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? { base: process.env.SUPABASE_URL.trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, ''), key: process.env.SUPABASE_SERVICE_KEY }
  : null;

// ---------------------------------------------------------------------------
// PostgREST helpers for the things the sink does not do: reads, and the PATCH
// of a credential row.
// ---------------------------------------------------------------------------
async function pg(method, pathAndQuery, body, prefer) {
  if (!SUPABASE) return { ok: false, status: 0, body: null };
  const res = await withRetry(`${method} ${pathAndQuery.split('?')[0]}`, async () => {
    const r = await fetch(`${SUPABASE.base}/rest/v1/${pathAndQuery}`, {
      method,
      headers: {
        apikey: SUPABASE.key, Authorization: `Bearer ${SUPABASE.key}`,
        'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let parsed = null;
    if (text) { try { parsed = JSON.parse(text); } catch (e) { parsed = text; } }
    return { status: r.status, ok: r.ok, body: parsed };
  });
  return res;
}

async function loadAccounts() {
  // Spike / dry path: tokens straight from the environment, no database.
  const inline = String(process.env.X_ACCESS_TOKENS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (inline.length) {
    return inline.map((entry) => {
      const i = entry.indexOf(':');
      return { label: entry.slice(0, i), access_token: entry.slice(i + 1), kind: 'organisation', inline: true };
    });
  }
  if (!SUPABASE) return [];
  const acc = await pg('GET', 'x_accounts?select=*&is_active=eq.true&order=account_id.asc&limit=1000');
  const tok = await pg('GET', 'x_oauth_tokens?select=id,account_id,sealed_refresh,scopes&revoked_at=is.null&limit=1000');
  if (!acc.ok || !tok.ok) {
    throw new Error(`could not read accounts/tokens (HTTP ${acc.status}/${tok.status}). Has sql/x-schema.sql been applied?`);
  }
  const byAccount = new Map((tok.body || []).map((t) => [t.account_id, t]));
  return (acc.body || []).map((a) => ({ ...a, label: a.label || a.username, token_row: byAccount.get(a.account_id) || null }));
}

async function monthToDateSpend() {
  if (!SUPABASE) return 0;
  const r = await pg('GET', 'x_spend_month_to_date?select=est_cost_usd');
  if (!r.ok || !Array.isArray(r.body) || !r.body.length) return 0;
  return Number(r.body[0].est_cost_usd) || 0;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------
async function accessTokenFor(account, log) {
  if (account.inline) return { token: account.access_token };
  if (!account.token_row) return { error: 'no live credential - account has not authorised, or its token was revoked' };
  if (!PRIVATE_KEY) return { error: 'X_TOKEN_PRIVATE_KEY is not set - cannot open sealed refresh tokens' };
  if (!CLIENT_ID) return { error: 'X_CLIENT_ID is not set' };

  let refreshToken;
  try {
    refreshToken = xauth.open(PRIVATE_KEY, account.token_row.sealed_refresh);
  } catch (e) {
    return { error: `sealed refresh token could not be opened (${e.message}) - was it sealed to a different key?` };
  }

  let granted;
  try {
    granted = await xauth.refresh({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken });
  } catch (e) {
    if (e.code === 'REAUTHORIZE') {
      // The holder must click Allow again. Mark it so the health check and the
      // tools say "needs re-authorisation" rather than "no data".
      await pg('PATCH', `x_oauth_tokens?id=eq.${account.token_row.id}`,
        { revoked_at: new Date().toISOString(), last_error: e.message.slice(0, 300) }, 'return=minimal');
      log(`   credential REVOKED by X (${e.message}). Needs re-authorisation.`);
    } else {
      await pg('PATCH', `x_oauth_tokens?id=eq.${account.token_row.id}`,
        { last_error: e.message.slice(0, 300) }, 'return=minimal');
    }
    return { error: e.message, code: e.code };
  }

  // Persist the ROTATED refresh token before using the access token. If this
  // write fails we stop here: proceeding would leave us with a dead credential
  // on disk and a live one only in memory.
  if (granted.refresh_token && granted.refresh_token !== refreshToken) {
    const pub = xauth.publicKeyOf(PRIVATE_KEY);
    const sealed = xauth.seal(pub, granted.refresh_token);
    const w = await pg('PATCH', `x_oauth_tokens?id=eq.${account.token_row.id}`,
      { sealed_refresh: sealed, last_refreshed_at: new Date().toISOString(), last_error: null,
        scopes: granted.scope || account.token_row.scopes || null }, 'return=minimal');
    if (!w.ok) return { error: `rotated refresh token could not be saved (HTTP ${w.status}); refusing to continue with a credential we cannot keep` };
  }
  return { token: granted.access_token };
}

// ---------------------------------------------------------------------------
// Mapping X objects to rows
// ---------------------------------------------------------------------------
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const QUARTILES = [0, 25, 50, 75, 100];

function mediaFor(post, includes) {
  const keys = post.attachments && Array.isArray(post.attachments.media_keys) ? post.attachments.media_keys : [];
  const none = { has_media: false, media: null, video_views: null };
  for (const q of QUARTILES) none[`video_playback_${q}`] = null;
  if (!keys.length) return none;
  const all = includes && Array.isArray(includes.media) ? includes.media : [];
  const mine = all.filter((m) => keys.includes(m.media_key));
  let views = null;
  // How far viewers got through the video: started (0), a quarter, half,
  // three quarters, the end. Summed over a post's videos, like view_count.
  const play = Object.fromEntries(QUARTILES.map((q) => [q, null]));
  for (const m of mine) {
    const v = m.public_metrics && num(m.public_metrics.view_count);
    if (v !== null) views = (views || 0) + v;
    for (const q of QUARTILES) {
      const c = m.non_public_metrics && num(m.non_public_metrics[`playback_${q}_count`]);
      if (c !== null) play[q] = (play[q] || 0) + c;
    }
  }
  const out = {
    has_media: true,
    media: mine.map((m) => ({ media_key: m.media_key, type: m.type || null,
      view_count: m.public_metrics ? num(m.public_metrics.view_count) : null,
      duration_ms: num(m.duration_ms), alt_text: m.alt_text || null,
      width: num(m.width), height: num(m.height),
      image_url: m.url || m.preview_image_url || null })),
    video_views: views,
  };
  for (const q of QUARTILES) out[`video_playback_${q}`] = play[q];
  return out;
}
// X's own topic labels (context_annotations): a domain such as "Politician"
// and an entity such as "Gavin Newsom". X repeats an entity under several
// domains, so they are kept as pairs, de-duplicated.
function topicsOf(post) {
  const seen = new Set(); const out = [];
  for (const a of post.context_annotations || []) {
    const d = a && a.domain && a.domain.name; const e = a && a.entity && a.entity.name;
    if (!d || !e || seen.has(d + '|' + e)) continue;
    seen.add(d + '|' + e); out.push({ domain: d, entity: e });
  }
  return out.length ? out : null;
}
const listOf = (arr, key) => {
  const v = [...new Set((arr || []).map((x) => x && x[key]).filter(Boolean))];
  return v.length ? v : null;
};

function toRows(post, { account, username, includes, errors, privateWindow, now }) {
  const ref = Array.isArray(post.referenced_tweets) && post.referenced_tweets[0] ? post.referenced_tweets[0] : null;
  // A long post's `text` stops at 280 characters; the whole post, and the
  // links and tags past that point, are in note_tweet.
  const note = post.note_tweet && post.note_tweet.text ? post.note_tweet : null;
  const ents = (note && note.entities) || post.entities || {};
  const links = sched.extractUrls(ents);
  const md = mediaFor(post, includes);
  const pub = post.public_metrics || {};
  const np = post.non_public_metrics || {};
  const org = post.organic_metrics || {};
  const pro = post.promoted_metrics || {};
  const mine = (errors || []).filter((e) => e && String(e.resource_id || e.value || '') === String(post.id) && !xapi.expectedRefusal(e));
  return {
    post: {
      post_id: String(post.id), account_id: account.account_id, created_at: post.created_at,
      text: (note ? note.text : post.text) || null, is_long_post: Boolean(note),
      lang: post.lang || null, conversation_id: post.conversation_id || null,
      in_reply_to_user_id: post.in_reply_to_user_id || null,
      referenced_type: ref ? ref.type : null, referenced_post_id: ref ? String(ref.id) : null,
      has_media: md.has_media, media: md.media,
      urls: links.urls.length ? links.urls : null,
      citizengo_urls: links.citizengo_urls,
      source: post.source || null,
      permalink_url: username ? `https://x.com/${username}/status/${post.id}` : null,
      hashtags: listOf(ents.hashtags, 'tag'), mentions: listOf(ents.mentions, 'username'),
      topics: topicsOf(post),
      edit_count: Array.isArray(post.edit_history_tweet_ids) ? Math.max(post.edit_history_tweet_ids.length - 1, 0) : null,
      reply_settings: post.reply_settings || null,
      possibly_sensitive: typeof post.possibly_sensitive === 'boolean' ? post.possibly_sensitive : null,
    },
    metric: {
      post_id: String(post.id), account_id: account.account_id,
      collected_date: COLLECTED_DATE, collected_at: now.toISOString(),
      // Whether private metrics actually CAME BACK, not whether they were asked
      // for. X serves them past its documented 30 days (to ~76-89 on 30 Sep
      // 2026), so "asked" and "got" are different facts and only one is useful.
      post_age_days: sched.ageDays(post.created_at, now),
      private_window_open: Boolean(privateWindow && (post.non_public_metrics || post.organic_metrics)),
      impressions: num(pub.impression_count), likes: num(pub.like_count), reposts: num(pub.retweet_count),
      replies: num(pub.reply_count), quotes: num(pub.quote_count), bookmarks: num(pub.bookmark_count),
      url_link_clicks: num(np.url_link_clicks), user_profile_clicks: num(np.user_profile_clicks),
      engagements: num(np.engagements),
      organic_impressions: num(org.impression_count), organic_likes: num(org.like_count),
      organic_reposts: num(org.retweet_count), organic_replies: num(org.reply_count),
      organic_url_clicks: num(org.url_link_clicks), organic_profile_clicks: num(org.user_profile_clicks),
      promoted_impressions: num(pro.impression_count), promoted_likes: num(pro.like_count),
      promoted_reposts: num(pro.retweet_count), promoted_replies: num(pro.reply_count),
      promoted_url_clicks: num(pro.url_link_clicks),
      video_views: md.video_views, video_playback_0: md.video_playback_0, video_playback_25: md.video_playback_25,
      video_playback_50: md.video_playback_50, video_playback_75: md.video_playback_75, video_playback_100: md.video_playback_100,
      errors: mine.length ? mine : null,
    },
  };
}

// ---------------------------------------------------------------------------
// One account
// ---------------------------------------------------------------------------
async function collectAccount(account, out) {
  const log = out;
  const started = new Date().toISOString();
  const now = new Date();
  log(`\n── ${account.label || account.account_id || '?'}${account.kind === 'spokesperson' ? ' (spokesperson: link posts only)' : ''}`);

  const runRow = (status, extra = {}) => ({
    run_id: RUN_ID, account_id: account.account_id || null, started_at: started,
    finished_at: new Date().toISOString(), status,
    posts_seen: 0, metrics_written: 0, api_calls: 0, post_reads: 0, user_reads: 0, est_cost_usd: 0,
    error_code: null, error_message: null, ...extra,
  });

  const cred = await accessTokenFor(account, log);
  if (cred.error) {
    log(`   FAILED: ${cred.error}`);
    await sink.upsert('x_collection_runs', [runRow('failed', { error_message: cred.error.slice(0, 500) })]);
    return { status: 'failed', posts: 0, metrics: 0, cost: 0 };
  }
  const client = xapi.makeClient({ token: cred.token });

  // Who is this, today.
  const me = await client.me();
  if (!me.ok || !me.body || !me.body.data) {
    const why = me.detail || me.title || (me.errors && me.errors[0] && me.errors[0].message) || `HTTP ${me.status}`;
    log(`   /2/users/me FAILED: ${why}`);
    await sink.upsert('x_collection_runs', [runRow('failed', { api_calls: client.tally.calls, error_code: me.status || null, error_message: String(why).slice(0, 500) })]);
    return { status: 'failed', posts: 0, metrics: 0, cost: 0 };
  }
  const u = me.body.data;
  account.account_id = account.account_id || String(u.id);
  const pm = u.public_metrics || {};
  await sink.upsert('x_accounts', [{
    account_id: String(u.id), username: u.username, name: u.name || null,
    kind: account.kind || 'organisation', country: account.country || null,
    label: account.label || u.username, is_active: true,
    followers_count: num(pm.followers_count), last_seen_at: started,
    description: u.description || null, location: u.location || null, website_url: u.url || null,
    pinned_post_id: u.pinned_tweet_id || null, profile_image_url: u.profile_image_url || null,
    verified_type: u.verified_type || null, subscription_type: u.subscription_type || null,
  }]);
  await sink.upsert('x_account_metrics', [{
    account_id: String(u.id), metric_date: COLLECTED_DATE, collected_at: started,
    followers_count: num(pm.followers_count), following_count: num(pm.following_count),
    post_count: num(pm.tweet_count), listed_count: num(pm.listed_count),
    like_count: num(pm.like_count), media_count: num(pm.media_count), errors: null,
  }]);
  log(`   @${u.username} · ${num(pm.followers_count) === null ? '?' : pm.followers_count.toLocaleString('en-GB')} followers`);

  const posts = new Map();
  // Keyed on post_id: one snapshot per post per run. Two passes returning the
  // same post would otherwise put it in one upsert batch twice, which Postgres
  // refuses ("ON CONFLICT DO UPDATE command cannot affect row a second time").
  const metricsById = new Map();
  // Every pass that fails is recorded here. A failed daily pass returns zero
  // posts, and "zero posts" must never be reported as "ok" - that is the
  // silent-failure shape this project keeps meeting (see README, Failure modes).
  const passFailures = [];
  const keep = (p) => account.kind !== 'spokesperson' || (p.citizengo_urls && p.citizengo_urls.length);

  function absorb(res, privateWindow, label) {
    const data = (res.body && res.body.data) || [];
    const includes = res.body && res.body.includes;
    const errs = res.errors || (res.body && res.body.errors) || [];
    let kept = 0;
    for (const t of data) {
      const rows = toRows(t, { account: { account_id: String(u.id) }, username: u.username, includes, errors: errs, privateWindow, now });
      if (!keep(rows.post)) continue;
      posts.set(rows.post.post_id, rows.post);
      metricsById.set(rows.metric.post_id, rows.metric);
      kept++;
    }
    const unexpected = errs.filter((e) => !xapi.expectedRefusal(e));
    if (unexpected.length) log(`   ${label}: ${unexpected.length} unexpected partial error(s) - ${String(unexpected[0].detail || unexpected[0].title || unexpected[0].message || '').slice(0, 100)}`);
    return { returned: data.length, kept };
  }

  // 3. Daily pass. An account we hold no posts for gets a first-run window of
  // the observed private ceiling (89 days), because the checkpoint pass only
  // revisits posts already held.
  let dailyDays = LOOKBACK_DAYS;
  let firstRunForAccount = false;
  if (SUPABASE && !account.inline && !LOOKBACK_EXPLICIT) {
    const held = await pg('GET', `x_posts?select=post_id&account_id=eq.${encodeURIComponent(String(u.id))}&limit=1`);
    const firstRun = held.ok && Array.isArray(held.body) && held.body.length === 0;
    dailyDays = firstRun ? sched.firstRunDays(0) : LOOKBACK_DAYS;
    if (firstRun) log(`   first collection for this account: daily window widened to ${dailyDays} days`);
    firstRunForAccount = firstRun;
  }
  const win = sched.dailyWindow(now, dailyDays);
  // Private groups are always requested. The groundwork withheld them past 29
  // days for fear X would fail the whole request; the probe showed X answers
  // with per-field partial errors and still sends public metrics.
  const privateOk = true;
  let token = null; let pages = 0; let returned = 0; let kept = 0;
  do {
    const res = await client.userPosts(u.id, { start_time: win.start_time, pagination_token: token, privateWindow: privateOk, excludeRetweets: !INCLUDE_RETWEETS });
    if (!res.ok) {
      const why = res.detail || res.title || (res.errors && res.errors[0] && (res.errors[0].detail || res.errors[0].message)) || `HTTP ${res.status}`;
      log(`   daily pass FAILED on page ${pages + 1}: ${why}`);
      passFailures.push({ pass: 'daily', status: res.status, why: String(why) });
      break;
    }
    const a = absorb(res, privateOk, 'daily');
    returned += a.returned; kept += a.kept; pages++;
    token = res.body && res.body.meta && res.body.meta.next_token;
  } while (token && returned < MAX_POSTS);
  log(`   ${win.label}: ${returned} post(s) returned, ${kept} kept, ${pages} page(s)`);

  // What this account has cost so far in the run, and a way to add it to the
  // shared counter as it grows.
  const owned = Boolean(APP_OWNER_ID) && String(u.id) === APP_OWNER_ID;
  let charged = 0;
  const charge = () => {
    const now = sched.estimateCost({ postReads: client.tally.postReads, userReads: client.tally.userReads, owned });
    RUN_SPEND.spent += now - charged;
    charged = now;
  };
  const perPostRate = owned ? sched.PRICES.ownedPostRead : sched.PRICES.postRead;

  // 4. Backfill of posts older than the daily window. Private
  // groups ARE requested: X documents 30 days but served them to ~76-89 days on
  // 30 Sep 2026, refusing older posts with a partial error while still sending
  // public metrics. So one request per page gets whatever X will give, and a
  // tightening by X costs nothing but the private columns.
  // Every account gets its FULL history, to X's 3,200-post limit - the same as
  // the 12 accounts backfilled by hand on 30 Sep 2026, and what the team was
  // told. x_accounts.history_complete records when that is done; until then
  // each night resumes the backfill from the oldest post held, so a backfill
  // paused by the budget or a dropped connection finishes on its own.
  const historyPending = SUPABASE && !account.inline && account.history_complete !== true;
  const backfillDays = BACKFILL_DAYS || (historyPending ? FIRST_RUN_BACKFILL_DAYS : 0);
  if (!BACKFILL_DAYS && historyPending && backfillDays) log(`   full history not yet collected: backfilling (to X's 3,200-post limit)`);
  const bw = sched.backfillWindow(now, backfillDays, BACKFILL_FROM_DAYS === null ? dailyDays : Math.max(BACKFILL_FROM_DAYS, dailyDays));
  if (bw) {
    const start = bw.start_time;
    let end = bw.end_time;
    // RESUMABLE: start below the oldest post already held, so a run that stops
    // (budget, credits, an outage) continues where it left off. Without this a
    // re-run re-fetches the whole window, and X only waives repeat charges
    // within the same UTC day.
    if (SUPABASE && !account.inline) {
      const oldest = await pg('GET', `x_posts?select=created_at&account_id=eq.${encodeURIComponent(String(u.id))}&order=created_at.asc&limit=1`);
      const o = oldest.ok && Array.isArray(oldest.body) && oldest.body[0] ? oldest.body[0].created_at : null;
      if (o && Date.parse(o) < Date.parse(end)) {
        end = new Date(Date.parse(o) - 1000).toISOString();
        log(`   backfill resumes below the oldest post held (${o.slice(0, 10)})`);
      }
    }
    let tok = null; let got = 0; let pg2 = 0;
    do {
      if (Date.parse(end) <= Date.parse(start)) break;
      charge();
      // Assume a full page (100 posts) so the check can only err on the safe side.
      if (RUN_SPEND.spent + 100 * perPostRate > RUN_SPEND.remaining - RUN_SPEND.nightlyReserve) {
        RUN_SPEND.stoppedAtBudget = true;
        log(`   backfill PAUSED at the monthly budget (less the nightly reserve) after ${got} post(s). It resumes on its own next month, or re-run after raising X_MONTHLY_BUDGET_USD.`);
        passFailures.push({ pass: 'backfill', status: null, why: 'stopped at the monthly budget; resumable' });
        break;
      }
      const res = await client.userPosts(u.id, { start_time: start, end_time: end, pagination_token: tok, privateWindow: true, excludeRetweets: !INCLUDE_RETWEETS });
      if (!res.ok) {
        const why = res.detail || res.title || `HTTP ${res.status}`;
        log(`   backfill FAILED: ${why}`);
        passFailures.push({ pass: 'backfill', status: res.status, why: String(why) });
        break;
      }
      got += absorb(res, true, 'backfill').returned; pg2++;
      tok = res.body && res.body.meta && res.body.meta.next_token;
    // X serves at most the 3,200 most recent posts, so 4,000 is a loop guard,
    // not a limit anyone should reach.
    } while (tok && got < Math.max(MAX_POSTS * 4, 4000));
    log(`   backfill ${backfillDays}d: ${got} post(s), ${pg2} page(s) (private metrics wherever X still serves them)`);
    // Finished only if X ran out of pages (or the window was already empty),
    // not if the budget or a failure ended the loop.
    const finished = !tok && !passFailures.some((f) => f.pass === 'backfill');
    if (finished && SUPABASE && !account.inline && !DRY_RUN) {
      await pg('PATCH', `x_accounts?account_id=eq.${encodeURIComponent(String(u.id))}`, { history_complete: true }, 'return=minimal');
      log('   full history collected; nightly runs will not backfill this account again');
    }
  }

  // 5. Checkpoint pass - only with a database, since it is defined by what we
  // hold. Reads x_post_last_collected, one row per post with its newest
  // snapshot time, rather than every snapshot: at 18 accounts that is ~400 rows
  // per account instead of ~5,000, and PostgREST caps a response at 1,000.
  let checkpointDue = 0;
  const dueBy = {};
  if (!NO_CHECKPOINTS && SUPABASE && !account.inline) {
    const from = new Date(now.getTime() - (sched.OBSERVED_PRIVATE_DAYS + 1) * 86_400_000).toISOString();
    const to = new Date(now.getTime() - (sched.CHECKPOINTS[0] - 1) * 86_400_000).toISOString();
    const held = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await pg('GET', `x_post_last_collected?select=post_id,created_at,last_collected_at`
        + `&account_id=eq.${encodeURIComponent(String(u.id))}`
        + `&created_at=gte.${encodeURIComponent(from)}&created_at=lte.${encodeURIComponent(to)}`
        + `&order=post_id.asc&limit=1000&offset=${offset}`);
      if (!page.ok) {
        passFailures.push({ pass: 'checkpoint', status: page.status, why: `could not read x_post_last_collected (HTTP ${page.status})` });
        log(`   checkpoint pass FAILED: could not read x_post_last_collected (HTTP ${page.status})`);
        break;
      }
      const rows = Array.isArray(page.body) ? page.body : [];
      held.push(...rows);
      if (rows.length < 1000) break;
    }
    // Skip anything the daily pass or backfill already read this run.
    const due = sched.dueForCheckpoint(held, now).filter((d) => !metricsById.has(d.post_id));
    checkpointDue = due.length;
    for (const d of due) dueBy[d.checkpoint] = (dueBy[d.checkpoint] || 0) + 1;
    for (const batch of sched.chunk(due.map((d) => d.post_id), 100)) {
      const res = await client.postsByIds(batch, { privateWindow: true });
      if (!res.ok) {
        const why = res.detail || res.title || `HTTP ${res.status}`;
        log(`   checkpoint pass FAILED: ${why}`);
        passFailures.push({ pass: 'checkpoint', status: res.status, why: String(why) });
        break;
      }
      absorb(res, true, 'checkpoint');
    }
    const split = sched.CHECKPOINTS.map((c) => `d${c}:${dueBy[c] || 0}`).join(' ');
    log(`   checkpoint reads: ${checkpointDue} post(s) due (${split})`);
  }

  if (posts.size) await sink.upsert('x_posts', [...posts.values()]);
  const metrics = [...metricsById.values()];
  if (metrics.length) await sink.upsert('x_post_metrics', metrics);

  // X bills $0.001 only when the account read IS the account that owns the
  // developer app; every other account is $0.005 ("not a discount for client
  // or managed accounts" - docs.x.com pricing). Pricing every account as owned
  // under-counted spend five-fold: the ledger said $2.39 on 30 Sep 2026 when
  // the X console said $10.40, so the budget guard would have let spend run
  // well past the cap. X_APP_OWNER_ID names the owning account.
  charge();
  const cost = sched.estimateCost({ postReads: client.tally.postReads, userReads: client.tally.userReads, owned });
  // Counted on private_window_open, NOT on url_link_clicks: X returns link
  // clicks only for posts that contain a link, so counting those reported 24 of
  // 190 when all 169 in-window posts had private metrics (30 Sep 2026).
  const withPrivate = metrics.filter((m) => m.private_window_open).length;
  // failed: the daily pass failed and nothing was collected.
  // partial: something failed but some data landed.
  // ok: every pass that ran succeeded (zero posts is fine on a quiet week).
  const status = passFailures.length ? (metrics.length ? 'partial' : 'failed') : 'ok';
  log(`   wrote ${posts.size} post(s), ${metrics.length} metric row(s) · ${withPrivate} with private metrics · `
    + `${client.tally.calls} calls · ${client.tally.postReads} post reads, ${client.tally.userReads} user read(s) · est $${cost.toFixed(4)}`);
  if (privateOk && metrics.length && !withPrivate) {
    log('   NO PRIVATE METRICS on any post inside the 30-day window. Either the token lacks');
    log('   user context (an app-only bearer), or X has changed what user context returns.');
  }

  await sink.upsert('x_collection_runs', [runRow(status, {
    posts_seen: posts.size, metrics_written: metrics.length, api_calls: client.tally.calls,
    post_reads: client.tally.postReads, user_reads: client.tally.userReads, est_cost_usd: cost,
    error_code: passFailures.length ? (passFailures[0].status || null) : null,
    error_message: passFailures.length
      ? passFailures.map((f) => `${f.pass}: ${f.why}`).join('; ').slice(0, 500)
      : (privateOk && metrics.length && !withPrivate ? 'no private metrics on any in-window post' : null),
  })]);
  return { status, posts: posts.size, metrics: metrics.length, cost, label: `@${u.username}` };
}

// ---------------------------------------------------------------------------
async function main() {
  console.log(`X collector ${RUN_ID} · sink=${sink.name}${DRY_RUN ? ' (dry run)' : ''} · daily window ${LOOKBACK_DAYS}d`
    + `${BACKFILL_DAYS ? ` · backfill ${BACKFILL_DAYS}d` : ''}${NO_CHECKPOINTS ? ' · no checkpoint pass' : ''}`);

  // Budget guard first. A collector that has already spent the month's money
  // must not spend more; and it must say so, not skip quietly.
  const spent = await monthToDateSpend();
  if (spent >= BUDGET_USD) {
    console.error(`REFUSING TO RUN: estimated X spend this month is $${spent.toFixed(2)}, budget is $${BUDGET_USD}.`);
    console.error('Raise X_MONTHLY_BUDGET_USD deliberately, or wait for the month to roll over.');
    process.exit(1);
  }
  if (spent) console.log(`  month to date: est $${spent.toFixed(2)} of $${BUDGET_USD} budget`);
  RUN_SPEND.remaining = BUDGET_USD - spent;

  let accounts = await loadAccounts();
  // The nightly reserve covers EVERY collected account, not just the ones this
  // run is limited to: a backfill of two accounts must not spend what the other
  // thirteen need tonight (30 Sep 2026: a 2-account run reserved $8, not $60).
  const allAccounts = accounts.length;
  if (ONLY.length) accounts = accounts.filter((a) => ONLY.includes(a.account_id) || ONLY.includes(a.label) || ONLY.includes(a.username));
  if (!accounts.length) {
    console.log('No X accounts to collect. Nothing has authorised yet (or X_ACCESS_TOKENS is unset for a dry run).');
    console.log('This is expected until the go-live checklist in README.md is worked through.');
    process.exit(0);
  }
  console.log(`${accounts.length} account(s)`);
  RUN_SPEND.nightlyReserve = nightlyReserveFor(allAccounts);
  if (Number.isFinite(RUN_SPEND.remaining)) console.log(`  backfill may spend up to $${Math.max(0, RUN_SPEND.remaining - RUN_SPEND.nightlyReserve).toFixed(2)} (keeping $${RUN_SPEND.nightlyReserve.toFixed(2)} for the rest of the month's nightly runs)`);

  const summary = new Array(accounts.length);
  await mapLimit(accounts, 3, async (a, idx) => {
    const buffered = [];
    let result;
    try {
      result = await collectAccount(a, (line) => buffered.push(line));
    } catch (e) {
      buffered.push(`   CRASHED: ${e.message}`);
      result = { status: 'failed', posts: 0, metrics: 0, cost: 0 };
    }
    process.stdout.write(buffered.join('\n') + '\n');
    summary[idx] = { label: result.label || a.label || a.account_id, ...result };
  });

  const written = await sink.flush();
  const totals = summary.reduce((t, s) => ({
    posts: t.posts + s.posts, metrics: t.metrics + s.metrics, cost: t.cost + (s.cost || 0),
    failed: t.failed + (s.status === 'failed' ? 1 : 0),
  }), { posts: 0, metrics: 0, cost: 0, failed: 0 });

  console.log('\nSummary');
  for (const s of summary) console.log(`  ${String(s.status).padEnd(8)} ${s.label} — ${s.posts} posts, ${s.metrics} metric rows, est $${(s.cost || 0).toFixed(4)}`);
  console.log(`  estimated cost this run: $${totals.cost.toFixed(4)} · month to date after run: $${(spent + totals.cost).toFixed(2)} of $${BUDGET_USD}`);
  if (RUN_SPEND.stoppedAtBudget) console.log('  NOTE: the backfill stopped at the monthly budget. Re-run it next month (or after raising X_MONTHLY_BUDGET_USD); it resumes where it stopped.');
  if (Object.keys(written).length) {
    console.log('\nWritten to data/:');
    for (const [t, n] of Object.entries(written)) console.log(`  ${t}.ndjson — ${n} rows`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = ['### X collection', '',
      `- Accounts: **${summary.length}** (${totals.failed} failed)`,
      `- Posts seen: **${totals.posts}** · metric rows: **${totals.metrics}**`,
      `- Estimated cost: **$${totals.cost.toFixed(4)}** this run · **$${(spent + totals.cost).toFixed(2)}** month to date of $${BUDGET_USD}`,
      '', '| Account | Status | Posts | Metrics | Est. cost |', '| --- | --- | --- | --- | --- |',
      ...summary.map((s) => `| ${s.label} | ${s.status} | ${s.posts} | ${s.metrics} | $${(s.cost || 0).toFixed(4)} |`),
    ].join('\n');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  }
  if (totals.failed === summary.length && summary.length) {
    console.error('\nFAIL: every account failed.');
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('\nX collector crashed:', e); process.exit(1); });
}

// Exported for scripts/test-x.js, which pins the X-object-to-row mapping.
// accessTokenFor/loadAccounts are exported for scripts/probe-x.js --stored, so
// the probe refreshes through the same path that persists the rotated token.
module.exports = { toRows, mediaFor, accessTokenFor, loadAccounts };
