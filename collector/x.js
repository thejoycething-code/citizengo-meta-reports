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
//   3. DAILY pass - every post from the last 7 days, all metric groups.
//      Each post returned is one billable read; that is the intended spend.
//   4. FINAL pass - posts aged 26-29 days whose last snapshot predates the
//      band, fetched by id, all metric groups. The last value X will ever
//      serve for the private groups.
//   5. Optional BACKFILL (--backfill-days N) - older posts, PUBLIC metrics only.
//      One-off; X refuses the private groups past 30 days and nothing here asks.
//   6. A run row with reads and estimated cost. Refuses to START when the
//      month's estimated spend has reached X_MONTHLY_BUDGET_USD.
//
// Spokesperson accounts are collected only for posts carrying a CitizenGO link.
// Everything else on a personal account is discarded before it is written.
//
// Usage:
//   node collector/x.js [--dry-run] [--lookback-days 7] [--backfill-days 90]
//                       [--no-final] [--accounts <id> <id>] [--budget-usd 100]
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
const NO_FINAL = args.includes('--no-final');
const LOOKBACK_DAYS = Number(flag('lookback-days', process.env.X_LOOKBACK_DAYS || sched.DAILY_DAYS));
const BACKFILL_DAYS = Number(flag('backfill-days', 0));
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
const CLIENT_SECRET = process.env.X_CLIENT_SECRET || '';
// PEM in an env var arrives with literal "\n" more often than not.
const PRIVATE_KEY = String(process.env.X_TOKEN_PRIVATE_KEY || '').replace(/\\n/g, '\n');

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

function mediaFor(post, includes) {
  const keys = post.attachments && Array.isArray(post.attachments.media_keys) ? post.attachments.media_keys : [];
  if (!keys.length) return { has_media: false, media: null, video_views: null, video_playback_100: null };
  const all = includes && Array.isArray(includes.media) ? includes.media : [];
  const mine = all.filter((m) => keys.includes(m.media_key));
  let views = null; let p100 = null;
  for (const m of mine) {
    const v = m.public_metrics && num(m.public_metrics.view_count);
    if (v !== null) views = (views || 0) + v;
    const c = m.non_public_metrics && num(m.non_public_metrics.playback_100_count);
    if (c !== null) p100 = (p100 || 0) + c;
  }
  return {
    has_media: true,
    media: mine.map((m) => ({ media_key: m.media_key, type: m.type || null,
      view_count: m.public_metrics ? num(m.public_metrics.view_count) : null })),
    video_views: views, video_playback_100: p100,
  };
}

function toRows(post, { account, username, includes, errors, privateWindow, now }) {
  const ref = Array.isArray(post.referenced_tweets) && post.referenced_tweets[0] ? post.referenced_tweets[0] : null;
  const links = sched.extractUrls(post.entities);
  const md = mediaFor(post, includes);
  const pub = post.public_metrics || {};
  const np = post.non_public_metrics || {};
  const org = post.organic_metrics || {};
  const pro = post.promoted_metrics || {};
  const mine = (errors || []).filter((e) => e && String(e.resource_id || e.value || '') === String(post.id));
  return {
    post: {
      post_id: String(post.id), account_id: account.account_id, created_at: post.created_at,
      text: post.text || null, lang: post.lang || null, conversation_id: post.conversation_id || null,
      in_reply_to_user_id: post.in_reply_to_user_id || null,
      referenced_type: ref ? ref.type : null, referenced_post_id: ref ? String(ref.id) : null,
      has_media: md.has_media, media: md.media,
      urls: links.urls.length ? links.urls : null,
      citizengo_urls: links.citizengo_urls,
      source: post.source || null,
      permalink_url: username ? `https://x.com/${username}/status/${post.id}` : null,
    },
    metric: {
      post_id: String(post.id), account_id: account.account_id,
      collected_date: COLLECTED_DATE, collected_at: now.toISOString(),
      post_age_days: sched.ageDays(post.created_at, now), private_window_open: Boolean(privateWindow),
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
      video_views: md.video_views, video_playback_100: md.video_playback_100,
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
  }]);
  await sink.upsert('x_account_metrics', [{
    account_id: String(u.id), metric_date: COLLECTED_DATE, collected_at: started,
    followers_count: num(pm.followers_count), following_count: num(pm.following_count),
    post_count: num(pm.tweet_count), listed_count: num(pm.listed_count), errors: null,
  }]);
  log(`   @${u.username} · ${num(pm.followers_count) === null ? '?' : pm.followers_count.toLocaleString('en-GB')} followers`);

  const posts = new Map();
  const metrics = [];
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
      metrics.push(rows.metric);
      kept++;
    }
    if (errs.length) log(`   ${label}: ${errs.length} partial error(s) - ${String(errs[0].title || errs[0].detail || errs[0].message || '').slice(0, 80)}`);
    return { returned: data.length, kept };
  }

  // 3. Daily pass.
  const win = sched.dailyWindow(now, LOOKBACK_DAYS);
  const privateOk = LOOKBACK_DAYS <= sched.PRIVATE_WINDOW_DAYS;
  let token = null; let pages = 0; let returned = 0; let kept = 0;
  do {
    const res = await client.userPosts(u.id, { start_time: win.start_time, pagination_token: token, privateWindow: privateOk });
    if (!res.ok) {
      const why = res.detail || res.title || (res.errors && res.errors[0] && (res.errors[0].detail || res.errors[0].message)) || `HTTP ${res.status}`;
      log(`   daily pass FAILED on page ${pages + 1}: ${why}`);
      break;
    }
    const a = absorb(res, privateOk, 'daily');
    returned += a.returned; kept += a.kept; pages++;
    token = res.body && res.body.meta && res.body.meta.next_token;
  } while (token && returned < MAX_POSTS);
  log(`   ${win.label}: ${returned} post(s) returned, ${kept} kept, ${pages} page(s)`);

  // 4. Final pass - only with a database, since it is defined by what we hold.
  let finalDue = 0;
  if (!NO_FINAL && SUPABASE && !account.inline) {
    const from = new Date(now.getTime() - (sched.FINAL_READ_TO + 1) * 86_400_000).toISOString();
    const to = new Date(now.getTime() - (sched.FINAL_READ_FROM - 1) * 86_400_000).toISOString();
    const cand = await pg('GET', `x_posts?select=post_id,created_at&account_id=eq.${encodeURIComponent(String(u.id))}&created_at=gte.${encodeURIComponent(from)}&created_at=lte.${encodeURIComponent(to)}&limit=2000`);
    const ids = (cand.ok && Array.isArray(cand.body) ? cand.body : []);
    if (ids.length) {
      const idList = ids.map((r) => `"${r.post_id}"`).join(',');
      const snaps = await pg('GET', `x_post_metrics?select=post_id,collected_at&post_id=in.(${idList})&order=collected_at.desc&limit=10000`);
      const latest = new Map();
      for (const s of (snaps.ok && Array.isArray(snaps.body) ? snaps.body : [])) if (!latest.has(s.post_id)) latest.set(s.post_id, s.collected_at);
      const due = sched.dueForFinalRead(ids.map((r) => ({ ...r, last_collected_at: latest.get(r.post_id) || null })), now);
      finalDue = due.length;
      for (const batch of sched.chunk(due, 100)) {
        const res = await client.postsByIds(batch, { privateWindow: true });
        if (!res.ok) { log(`   final pass FAILED: ${res.detail || res.title || `HTTP ${res.status}`}`); break; }
        absorb(res, true, 'final');
      }
    }
    log(`   final reads: ${finalDue} post(s) due at day ${sched.FINAL_READ_FROM}-${sched.FINAL_READ_TO}`);
  }

  // 5. Backfill - public metrics only, older than the private window.
  if (BACKFILL_DAYS > sched.PRIVATE_WINDOW_DAYS) {
    const start = new Date(now.getTime() - BACKFILL_DAYS * 86_400_000).toISOString();
    const end = new Date(now.getTime() - (sched.PRIVATE_WINDOW_DAYS + 1) * 86_400_000).toISOString();
    let tok = null; let got = 0; let pg2 = 0;
    do {
      const res = await client.userPosts(u.id, { start_time: start, end_time: end, pagination_token: tok, privateWindow: false });
      if (!res.ok) { log(`   backfill FAILED: ${res.detail || res.title || `HTTP ${res.status}`}`); break; }
      got += absorb(res, false, 'backfill').returned; pg2++;
      tok = res.body && res.body.meta && res.body.meta.next_token;
    } while (tok && got < MAX_POSTS * 4);
    log(`   backfill ${BACKFILL_DAYS}d (public metrics only): ${got} post(s), ${pg2} page(s)`);
  }

  if (posts.size) await sink.upsert('x_posts', [...posts.values()]);
  if (metrics.length) await sink.upsert('x_post_metrics', metrics);

  const cost = sched.estimateCost({ postReads: client.tally.postReads, userReads: client.tally.userReads, owned: true });
  const withPrivate = metrics.filter((m) => m.url_link_clicks !== null).length;
  const status = metrics.length || returned === 0 ? 'ok' : 'partial';
  log(`   wrote ${posts.size} post(s), ${metrics.length} metric row(s) · ${withPrivate} with private metrics · `
    + `${client.tally.calls} calls · ${client.tally.postReads} post reads, ${client.tally.userReads} user read(s) · est $${cost.toFixed(4)}`);
  if (privateOk && metrics.length && !withPrivate) {
    log('   NO PRIVATE METRICS on any post inside the 30-day window. Either the token lacks');
    log('   user context (an app-only bearer), or X has changed what user context returns.');
  }

  await sink.upsert('x_collection_runs', [runRow(status, {
    posts_seen: posts.size, metrics_written: metrics.length, api_calls: client.tally.calls,
    post_reads: client.tally.postReads, user_reads: client.tally.userReads, est_cost_usd: cost,
    error_message: privateOk && metrics.length && !withPrivate ? 'no private metrics on any in-window post' : null,
  })]);
  return { status, posts: posts.size, metrics: metrics.length, cost, label: `@${u.username}` };
}

// ---------------------------------------------------------------------------
async function main() {
  console.log(`X collector ${RUN_ID} · sink=${sink.name}${DRY_RUN ? ' (dry run)' : ''} · daily window ${LOOKBACK_DAYS}d`
    + `${BACKFILL_DAYS ? ` · backfill ${BACKFILL_DAYS}d` : ''}${NO_FINAL ? ' · no final pass' : ''}`);

  // Budget guard first. A collector that has already spent the month's money
  // must not spend more; and it must say so, not skip quietly.
  const spent = await monthToDateSpend();
  if (spent >= BUDGET_USD) {
    console.error(`REFUSING TO RUN: estimated X spend this month is $${spent.toFixed(2)}, budget is $${BUDGET_USD}.`);
    console.error('Raise X_MONTHLY_BUDGET_USD deliberately, or wait for the month to roll over.');
    process.exit(1);
  }
  if (spent) console.log(`  month to date: est $${spent.toFixed(2)} of $${BUDGET_USD} budget`);

  let accounts = await loadAccounts();
  if (ONLY.length) accounts = accounts.filter((a) => ONLY.includes(a.account_id) || ONLY.includes(a.label) || ONLY.includes(a.username));
  if (!accounts.length) {
    console.log('No X accounts to collect. Nothing has authorised yet (or X_ACCESS_TOKENS is unset for a dry run).');
    console.log('This is expected until the go-live checklist in README.md is worked through.');
    process.exit(0);
  }
  console.log(`${accounts.length} account(s)`);

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
module.exports = { toRows, mediaFor };
