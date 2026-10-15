#!/usr/bin/env node
'use strict';
// Instagram accounts connected by their holders (16 Oct 2026; lib/igauth.js).
//
//   node collector/ig-connected.js [--days 30] [--dry-run] [--accounts <username> ...]
//
// Two ways in (ig_accounts.access):
//   login   - the holder connected through Instagram Login (lib/igauth.js):
//             open the sealed token (X_TOKEN_PRIVATE_KEY); once it is a day
//             old, refresh it for another 60 days and write it back sealed.
//   partner - the holder shared the account with CitizenGO's Business Manager
//             in Meta Business Suite (lib/igpartner.js): read with the System
//             User token in META_TOKENS that can see it.
// Then, for each account:
//   2. refresh the account's profile (followers, posts);
//   3. read its posts (feed and reels) since the window - all of them, up to
//      1,000, on the first run - and keep, for a spokesperson, only those that
//      carry a CitizenGO link or mention CitizenGO (lib/xschedule.js isAboutUs);
//   4. read insights for every kept post and store one snapshot per day.
// Stories are not read: they last 24 hours and the API does not expose the
// link a sticker points to, so they cannot be matched to a campaign code.

const path = require('path');
const { loadEnv } = require('../lib/graph');
const igauth = require('../lib/igauth');
const igpartner = require('../lib/igpartner');
const xauth = require('../lib/xauth');
const links = require('../lib/links');
const sched = require('../lib/xschedule');
const { makeSink } = require('./lib/sinks');

loadEnv();
const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf('--' + name); return i !== -1 && args[i + 1] ? args[i + 1] : dflt; };
const DRY_RUN = args.includes('--dry-run');
const DAYS = Number(flag('days', 30));
const ONLY = (() => { const i = args.indexOf('--accounts'); return i === -1 ? [] : args.slice(i + 1).filter((a) => !a.startsWith('--')).map((a) => a.replace(/^@/, '').toLowerCase()); })();
const FIRST_RUN_MAX = 1000;
const REFRESH_AFTER_MS = 24 * 3600 * 1000;
const RUN_ID = `igrun-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`;
const TODAY = new Date().toISOString().slice(0, 10);

const BASE = (process.env.SUPABASE_URL || '').trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY || '';
async function pg(method, pathAndQuery, body, prefer) {
  const r = await fetch(`${BASE}/rest/v1/${pathAndQuery}`, {
    method, headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${method} ${pathAndQuery.split('?')[0]}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}

// Pure: what a post carries, and whether a spokesperson's post is kept.
function describe(caption) {
  const text = caption || '';
  return {
    text,
    citizengo_urls: links.extractLinks(text),
    hashtags: [...text.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1]),
    mentions: [...text.matchAll(/@([A-Za-z0-9._]+)/g)].map((m) => m[1].replace(/\.$/, '')),
  };
}
function keep(account, media) {
  return account.kind !== 'spokesperson' || sched.isAboutUs(describe(media.caption));
}

// Insights arrive as [{name, values:[{value}]}] or [{name, total_value:{value}}].
function parseInsights(body) {
  const out = {};
  for (const m of (body && Array.isArray(body.data) ? body.data : [])) {
    const v = m.total_value ? m.total_value.value : (Array.isArray(m.values) && m.values[0] ? m.values[0].value : null);
    out[m.name] = typeof v === 'number' ? v : (v === null || v === undefined ? null : Number(v));
  }
  return out;
}

async function insightsFor(mediaId, g) {
  const all = await g.get(`${mediaId}/insights`, { metric: igauth.INSIGHT_METRICS.join(',') });
  if (all.ok) return parseInsights(all.body);
  // One unsupported metric fails the whole batch: ask one at a time instead.
  const out = {};
  for (const m of igauth.INSIGHT_METRICS) {
    const one = await g.get(`${mediaId}/insights`, { metric: m });
    if (one.ok) Object.assign(out, parseInsights(one.body));
  }
  return out;
}

// The client for one account: { g: {get}, self, fields } or { error }.
async function accessFor(account, { tokenRow, privateKey, publicKey, metaTokens, log }) {
  if (account.access === 'partner') {
    // The token for the account's Business Manager first, then any other.
    for (const tok of metaTokens) {
      const g = igpartner.api(tok);
      const r = await g.get(account.ig_user_id, { fields: 'id' });
      if (r.ok) return { g, self: account.ig_user_id, fields: igpartner.USER_FIELDS };
    }
    return { error: 'no META_TOKENS token can read this account: the partner share was removed, or it is not assigned to the System User' };
  }
  if (!tokenRow) return { error: 'no live token' };
  let token;
  try { token = xauth.open(privateKey, tokenRow.sealed_token); } catch (e) { return { error: 'token could not be opened' }; }
  // Refresh once a day old: keeps the 60-day clock from ever running out.
  const age = Date.now() - Date.parse(tokenRow.refreshed_at || tokenRow.authorized_at);
  if (age > REFRESH_AFTER_MS) {
    try {
      const fresh = await igauth.refresh({ token });
      token = fresh.access_token;
      if (!DRY_RUN) {
        await pg('PATCH', `ig_oauth_tokens?id=eq.${tokenRow.id}`, { sealed_token: xauth.seal(publicKey, token), refreshed_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + fresh.expires_in * 1000).toISOString(), last_error: null }, 'return=minimal');
      }
      log('   token refreshed for another 60 days');
    } catch (e) {
      log(`   token refresh FAILED: ${e.message}`);
      if (!DRY_RUN) await pg('PATCH', `ig_oauth_tokens?id=eq.${tokenRow.id}`, { last_error: String(e.message).slice(0, 300) }, 'return=minimal').catch(() => {});
      // An expired or revoked token cannot be used either; the holder must reconnect.
      if (e.status === 400 || e.status === 401) return { error: `needs re-authorisation: ${e.message}`.slice(0, 300) };
    }
  }
  return { g: { get: (path, params) => igauth.get(path, params, token) }, self: 'me', fields: igauth.ME_FIELDS };
}

async function collectAccount(account, ctx) {
  const { sink, log } = ctx;
  const started = new Date().toISOString();
  const run = (status, extra = {}) => ({ run_id: RUN_ID, ig_user_id: account.ig_user_id, started_at: started, finished_at: new Date().toISOString(),
    status, media_seen: 0, media_kept: 0, metrics_written: 0, error_message: null, ...extra });
  log(`\n── ${account.label || account.username} (@${account.username}, ${account.kind}, ${account.access || 'login'})`);
  const a = await accessFor(account, ctx);
  if (a.error) { log(`   ${a.error}`); return run('failed', { error_message: a.error }); }
  const { g, self } = a;

  const me = await g.get(self, { fields: a.fields });
  if (!me.ok) {
    log(`   profile read FAILED: HTTP ${me.status}`);
    return run('failed', { error_message: `me: HTTP ${me.status} ${JSON.stringify(me.body).slice(0, 200)}` });
  }
  await sink.upsert('ig_accounts', [{ ig_user_id: account.ig_user_id, username: me.body.username || account.username,
    followers_count: me.body.followers_count ?? null, media_count: me.body.media_count ?? null, last_seen_at: new Date().toISOString() }]);

  const firstRun = !(await pg('GET', `ig_media?select=media_id&ig_user_id=eq.${encodeURIComponent(account.ig_user_id)}&limit=1`) || []).length;
  const since = firstRun ? 0 : Date.now() - DAYS * 86400000;
  const media = [];
  let after = null;
  do {
    const page = await g.get(`${self}/media`, { fields: igauth.MEDIA_FIELDS, limit: 50, after });
    if (!page.ok) { log(`   media read FAILED: HTTP ${page.status}`); return run('failed', { error_message: `media: HTTP ${page.status}` }); }
    const rows = page.body.data || [];
    media.push(...rows.filter((m) => Date.parse(m.timestamp) >= since));
    const oldest = rows.length ? Date.parse(rows[rows.length - 1].timestamp) : 0;
    after = page.body.paging && page.body.paging.next && page.body.paging.cursors ? page.body.paging.cursors.after : null;
    if (oldest < since || media.length >= FIRST_RUN_MAX) after = null;
  } while (after);

  const kept = media.filter((m) => keep(account, m));
  log(`   ${media.length} post(s) in the window${firstRun ? ' (first run: full history)' : ''}; ${kept.length} kept${account.kind === 'spokesperson' ? ' (CitizenGO links and mentions only)' : ''}`);
  const mediaRows = kept.map((m) => ({ media_id: String(m.id), ig_user_id: account.ig_user_id, caption: m.caption || null, media_type: m.media_type || null,
    media_product_type: m.media_product_type || null, permalink: m.permalink || null, timestamp: m.timestamp, citizengo_urls: describe(m.caption).citizengo_urls }));
  if (mediaRows.length) await sink.upsert('ig_media', mediaRows);
  const metrics = [];
  for (const m of kept) {
    const i = await insightsFor(m.id, g);
    metrics.push({ media_id: String(m.id), collected_date: TODAY, collected_at: new Date().toISOString(),
      reach: i.reach ?? null, views: i.views ?? null, likes: i.likes ?? m.like_count ?? null, comments: i.comments ?? m.comments_count ?? null,
      shares: i.shares ?? null, saved: i.saved ?? null, total_interactions: i.total_interactions ?? null });
  }
  if (metrics.length) await sink.upsert('ig_media_metrics', metrics);
  return run('ok', { media_seen: media.length, media_kept: kept.length, metrics_written: metrics.length });
}

async function main() {
  const privateKey = String(process.env.X_TOKEN_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const metaTokens = String(process.env.META_TOKENS || process.env.META_TOKEN || '').split(/[\n,]/).map((t) => t.trim()).filter(Boolean);
  if (!BASE || !KEY) { console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY are needed.'); process.exit(2); }
  const publicKey = privateKey ? xauth.publicKeyOf(privateKey) : null;
  let accounts = await pg('GET', 'ig_accounts?select=ig_user_id,username,label,kind,access,business_id&is_active=eq.true') || [];
  if (ONLY.length) accounts = accounts.filter((a) => ONLY.includes(String(a.username).toLowerCase()));
  console.log(`Connected Instagram collector ${RUN_ID} · ${accounts.length} account(s)${DRY_RUN ? ' · dry run' : ''}`);
  if (!accounts.length) { console.log('No Instagram accounts connected yet.'); return; }
  const tokens = await pg('GET', 'ig_oauth_tokens?select=id,ig_user_id,sealed_token,authorized_at,refreshed_at&revoked_at=is.null') || [];
  const sink = makeSink({ dryRun: DRY_RUN, dir: path.join(__dirname, '..', 'data') });
  const runs = [];
  for (const a of accounts) {
    const t = tokens.find((x) => x.ig_user_id === a.ig_user_id);
    try { runs.push(await collectAccount(a, { tokenRow: t, privateKey, publicKey, metaTokens, sink, log: console.log })); } catch (e) {
      console.log(`   FAILED: ${e.message}`);
      runs.push({ run_id: RUN_ID, ig_user_id: a.ig_user_id, started_at: new Date().toISOString(), finished_at: new Date().toISOString(), status: 'failed', media_seen: 0, media_kept: 0, metrics_written: 0, error_message: String(e.message).slice(0, 300) });
    }
  }
  await sink.upsert('ig_collection_runs', runs);
  await sink.flush();
  const failed = runs.filter((r) => r.status !== 'ok').length;
  console.log(`\n${runs.length - failed} ok, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { describe, keep, parseInsights, accessFor };
