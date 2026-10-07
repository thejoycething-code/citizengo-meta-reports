#!/usr/bin/env node
'use strict';
// Peer watch: reads the public Instagram posts of peer organisations listed in
// config/peers-ig.json through the Graph API's business_discovery field, and
// stores them in the peer_ig_* tables (sql/peer-schema.sql).
//
// Official and free: business_discovery is called AS our own linked Instagram
// account, reads only public Business/Creator profiles, and costs nothing. One
// call per peer returns the profile and its latest posts, so ~60 peers is ~60
// calls a week, well inside our Instagram rate limit. Personal (non-business)
// accounts cannot be read this way; they are recorded as not_business.
//
// Usage:
//   node collector/peers-ig.js [--dry-run] [--only handle1,handle2] [--posts 50]
// Env: META_TOKENS (or META_TOKEN), SUPABASE_URL, SUPABASE_SERVICE_KEY,
//      PEER_IG_VIA (optional: our Instagram username to call as; default the
//      first linked account found, preferring citizengo_uk),
//      PEER_IG_VIA_ID (optional: our Instagram user id to call as; tried first).

const fs = require('fs');
const path = require('path');
const { loadEnv, makeClient } = require('../lib/graph');
const { withRetry } = require('../lib/retry');

const VERSION = process.env.GRAPH_VERSION || 'v23.0';
const LIST = path.join(__dirname, '..', 'config', 'peers-ig.json');
const MEDIA_FIELDS = 'id,caption,like_count,comments_count,media_type,media_product_type,permalink,timestamp';
const PREFERRED_VIA = ['citizengo_uk', 'citizengo'];

function args(argv) {
  const out = { dryRun: false, only: null, posts: 50 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') out.dryRun = true;
    else if (argv[i] === '--only') out.only = String(argv[++i] || '').split(',').map(norm).filter(Boolean);
    else if (argv[i] === '--posts') out.posts = Math.max(1, Math.min(100, Number(argv[++i]) || 50));
  }
  return out;
}

function norm(h) {
  return String(h || '').trim().replace(/^@/, '').toLowerCase();
}

function loadList(file = LIST) {
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const username = norm(r.handle);
    if (!username || seen.has(username)) continue;
    if (/citizengo|hazteoir/.test(username)) continue;  // our own accounts are collected elsewhere
    seen.add(username);
    out.push({ username, label: r.name || null, country: r.country || null, topic: r.group || null });
  }
  return out;
}

// Our linked Instagram account to call business_discovery as.
async function findVia(get, wanted) {
  const res = await get('/me/accounts', { fields: 'instagram_business_account{id,username}', limit: 100 });
  if (!res.ok) throw new Error(`could not list Pages (${res.error ? res.error.message : 'unknown'})`);
  const linked = ((res.body && res.body.data) || [])
    .map((p) => p.instagram_business_account)
    .filter((ig) => ig && ig.id);
  if (!linked.length) throw new Error('no Instagram account is linked to any Page this token can read');
  const order = wanted ? [norm(wanted)] : PREFERRED_VIA;
  for (const name of order) {
    const hit = linked.find((ig) => norm(ig.username) === name);
    if (hit) return hit;
  }
  if (wanted) throw new Error(`PEER_IG_VIA @${norm(wanted)} is not linked to any Page this token can read`);
  return linked[0];
}

// Graph error -> status we store. 110/2207013 is "not a business account";
// a handle that does not exist comes back as 110 too, with a different message.
function classify(error) {
  if (!error) return 'ok';
  const msg = String(error.message || '').toLowerCase();
  if (error.error_subcode === 2207013 || msg.includes('business or creator')) return 'not_business';
  if (msg.includes('cannot be found') || msg.includes('does not exist') || msg.includes('invalid user id')) return 'not_found';
  if (error.code === 4 || error.code === 17 || error.code === 32 || error.code === 613) return 'rate_limited';
  return 'error';
}

async function discover(get, viaId, username, posts) {
  const fields = `business_discovery.username(${username}){id,username,name,followers_count,media_count,media.limit(${posts}){${MEDIA_FIELDS}}}`;
  const res = await get(`/${viaId}`, { fields });
  if (!res.ok) {
    const error = res.error || { message: res.transport_error || `HTTP ${res.status}` };
    return { status: classify(error), error: String(error.message || '').slice(0, 300) };
  }
  const bd = res.body && res.body.business_discovery;
  if (!bd) return { status: 'not_found', error: 'no business_discovery in response' };
  const media = ((bd.media && bd.media.data) || []).map((m) => ({
    media_id: m.id,
    username,
    media_type: m.media_type || null,
    media_product_type: m.media_product_type || null,
    caption: m.caption || null,
    permalink: m.permalink || null,
    timestamp: m.timestamp,
    like_count: typeof m.like_count === 'number' ? m.like_count : null,
    comments_count: typeof m.comments_count === 'number' ? m.comments_count : null,
  })).filter((m) => m.media_id && m.timestamp);
  return {
    status: 'ok',
    profile: {
      ig_id: bd.id || null,
      name: bd.name || null,
      followers_count: typeof bd.followers_count === 'number' ? bd.followers_count : null,
      media_count: typeof bd.media_count === 'number' ? bd.media_count : null,
    },
    media,
  };
}

function makePg() {
  const base = String(process.env.SUPABASE_URL || '').trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!base || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required (or use --dry-run)');
  return async function upsert(table, rows, onConflict) {
    if (!rows.length) return;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const res = await withRetry(`upsert ${table}`, async () => {
        const r = await fetch(`${base}/rest/v1/${table}?on_conflict=${onConflict}`, {
          method: 'POST',
          headers: {
            apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=minimal',
          },
          body: JSON.stringify(chunk),
        });
        const body = r.ok ? null : await r.json().catch(() => null);
        return { ok: r.ok, status: r.status, body };
      });
      if (!res.ok) {
        // Table names stay in the log, values do not.
        throw new Error(`write to ${table} failed (HTTP ${res.status} ${res.body && res.body.code ? res.body.code : ''})`);
      }
    }
  };
}

async function run({ get, upsert, list, opts, via, now = new Date(), log = console.log }) {
  via = via || await findVia(get, process.env.PEER_IG_VIA);
  log(`calling business_discovery as @${via.username} for ${list.length} peer account(s)`);

  const today = now.toISOString().slice(0, 10);
  const checkedAt = now.toISOString();
  const counts = { ok: 0, not_business: 0, not_found: 0, rate_limited: 0, error: 0, posts: 0 };

  for (const peer of list) {
    const r = await discover(get, via.id, peer.username, opts.posts);
    counts[r.status] = (counts[r.status] || 0) + 1;
    const account = {
      username: peer.username, label: peer.label, country: peer.country, topic: peer.topic,
      last_status: r.status, last_error: r.error || null, last_checked_at: checkedAt,
      ...(r.profile || {}),
    };
    if (r.status !== 'ok') {
      log(`  @${peer.username}: ${r.status}${r.error ? ` (${r.error.slice(0, 90)})` : ''}`);
      if (!opts.dryRun) await upsert('peer_ig_accounts', [account], 'username');
      if (r.status === 'rate_limited') { log('  stopping: rate limited; the rest wait for next run'); break; }
      continue;
    }
    counts.posts += r.media.length;
    const top = r.media.reduce((a, m) => ((m.like_count || 0) + (m.comments_count || 0) > (a ? (a.like_count || 0) + (a.comments_count || 0) : -1) ? m : a), null);
    log(`  @${peer.username}: ${r.profile.followers_count ?? '?'} followers, ${r.media.length} posts`
      + (top ? `; top ${(top.like_count || 0) + (top.comments_count || 0)} (${top.permalink})` : ''));
    if (opts.dryRun) continue;
    await upsert('peer_ig_accounts', [account], 'username');
    await upsert('peer_ig_media', r.media.map(({ like_count, comments_count, ...m }) => m), 'media_id');
    await upsert('peer_ig_media_metrics', r.media.map((m) => ({
      media_id: m.media_id, collected_date: today,
      like_count: m.like_count, comments_count: m.comments_count,
      followers_count: r.profile.followers_count,
    })), 'media_id,collected_date');
  }

  log(`done: ${counts.ok} read, ${counts.not_business} not business, ${counts.not_found} not found, `
    + `${counts.rate_limited} rate limited, ${counts.error} errors; ${counts.posts} posts${opts.dryRun ? ' (dry run, nothing written)' : ''}`);
  return counts;
}

async function main() {
  loadEnv();
  const opts = args(process.argv.slice(2));
  const tokens = String(process.env.META_TOKENS || process.env.META_TOKEN || '')
    .split(/[\n,]/).map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) throw new Error('META_TOKENS is not set');
  // One token per Business Portfolio: use the one that holds the account we
  // want to call as, falling back to the first linked account found.
  let client = null, via = null, fallback = null;
  // A direct id wins: some linked accounts (citizengo_uk among them) are not
  // listed by /me/accounts but are still readable, so try each token on it.
  const viaId = String(process.env.PEER_IG_VIA_ID || '').trim();
  if (viaId) {
    for (const token of tokens) {
      const c = makeClient({ token, version: VERSION });
      const r = await c.get(`/${viaId}`, { fields: 'id,username' });
      if (r.ok && r.body && r.body.id) { client = c; via = { id: r.body.id, username: r.body.username || viaId }; break; }
    }
    if (!client) console.log(`PEER_IG_VIA_ID ${viaId} is not readable with these tokens; falling back to a linked account`);
  }
  const wanted = process.env.PEER_IG_VIA ? [norm(process.env.PEER_IG_VIA)] : PREFERRED_VIA;
  for (const token of client ? [] : tokens) {
    const c = makeClient({ token, version: VERSION });
    const found = await findVia(c.get).catch(() => null);
    if (!found) continue;
    if (wanted.includes(norm(found.username))) { client = c; via = found; break; }
    if (!fallback) fallback = { c, found };
  }
  if (!client && process.env.PEER_IG_VIA) throw new Error(`PEER_IG_VIA @${wanted[0]} is not linked to any Page these tokens can read`);
  if (!client && fallback) ({ c: client, found: via } = fallback);
  if (!client) throw new Error('no token can see a linked Instagram account');
  let list = loadList();
  if (opts.only) list = list.filter((p) => opts.only.includes(p.username));
  const upsert = opts.dryRun ? null : makePg();
  const counts = await run({ get: client.get, upsert, list, opts, via });
  // Every account failing means something is wrong with the token or route, not the peers.
  if (list.length && counts.ok === 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((e) => { console.error(`peer watch failed: ${e.message}`); process.exit(1); });
}

module.exports = { args, norm, loadList, findVia, classify, discover, run };
