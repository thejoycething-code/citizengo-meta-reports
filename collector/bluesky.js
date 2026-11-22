#!/usr/bin/env node
'use strict';
// Listening D5 (Chris, 22 Nov 2026): the Bluesky public posts of the ally and
// opponent organisations we already watch on Instagram. Bluesky's public API
// (public.api.bsky.app), no key, no sign-in; public posts only, reposts and
// replies left out. Opponent posts are deleted after 120 days, as everywhere.
//
// Finding each organisation's account: a name search, accepted only when the
// handle is the organisation's own web domain (Bluesky checks domain handles)
// and the name or handle matches. config/listen-bluesky.json can set one by
// hand ({ "<instagram username>": "<bluesky handle>" or null }). Searches are
// repeated weekly; posts are read every run.
//
// Usage: node collector/bluesky.js [--dry-run]
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY.

const { loadEnv } = require('../lib/graph');
const { makePg } = require('./peers-ig');

const API = 'https://public.api.bsky.app/xrpc';
const UA = { 'User-Agent': 'CitizenGO-ContentDesk/1.0 (+https://meta-organic-reporting.vercel.app)' };
const KEEP_DAYS = 120;
const RESEARCH_DAYS = 7;

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\b(the|uk|org|org\.uk|co\.uk)\b/g, '').replace(/[^a-z0-9]/g, '');
const rootOf = (handle) => String(handle || '').toLowerCase().replace(/\.(bsky\.social)$/, '').split('.').slice(0, -1).join('.') || String(handle || '').toLowerCase();

// Pure: which search result is this organisation, or null.
function pickActor(account, actors) {
  const label = norm(account.label), user = norm(account.username);
  for (const a of actors || []) {
    const h = String(a.handle || '').toLowerCase();
    if (!h || h.endsWith('.bsky.social') || h === 'handle.invalid') continue;
    const name = norm(a.displayName), root = norm(rootOf(h));
    if ((label && (name === label || root === label)) || (user && (root === user || name === user))) return { handle: h, did: a.did || null };
  }
  return null;
}

// Pure: an author feed -> post rows (own posts only, no reposts or replies).
function parseFeed(feed, account, handle) {
  const out = [];
  for (const it of (feed && feed.feed) || []) {
    if (it.reason) continue;
    const p = it.post; if (!p || !p.uri || !p.record) continue;
    if (p.record.reply) continue;
    if (String((p.author && p.author.handle) || '').toLowerCase() !== handle) continue;
    const rkey = String(p.uri).split('/').pop();
    out.push({ uri: p.uri, handle, label: account.label || null, stance: account.stance || null, country: account.country || null,
      text: String(p.record.text || '').slice(0, 3000), url: `https://bsky.app/profile/${handle}/post/${rkey}`, created_at: new Date(p.record.createdAt || p.indexedAt).toISOString(),
      like_count: Number(p.likeCount) || 0, repost_count: Number(p.repostCount) || 0, reply_count: Number(p.replyCount) || 0, quote_count: Number(p.quoteCount) || 0 });
  }
  return out;
}

async function get(path, params) {
  const r = await fetch(`${API}/${path}?${new URLSearchParams(params)}`, { headers: UA });
  if (!r.ok) { const e = new Error(`${path} HTTP ${r.status}`); e.status = r.status; throw e; }
  return r.json();
}
const pause = (ms) => new Promise((res) => setTimeout(res, ms));

async function main() {
  loadEnv();
  const dryRun = process.argv.includes('--dry-run');
  const base = String(process.env.SUPABASE_URL || '').trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  const H = { apikey: key, Authorization: `Bearer ${key}` };
  const read = async (table, q) => { const r = await fetch(`${base}/rest/v1/${table}?${q}`, { headers: H }); if (!r.ok) throw new Error(`read ${table} HTTP ${r.status}`); return r.json(); };
  const pg = dryRun ? null : makePg();
  const manual = (() => { try { return require('../config/listen-bluesky.json'); } catch (e) { return {}; } })();
  const watched = await read('peer_ig_accounts', 'select=username,label,stance,country&limit=1000');
  const known = Object.fromEntries((await read('listen_bsky_accounts', 'select=*&limit=1000').catch(() => [])).map((a) => [a.ig_username, a]));
  const now = Date.now();
  let found = 0, posts = 0, failed = 0;
  const accounts = [];
  for (const w of watched) {
    let a = known[w.username];
    if (Object.prototype.hasOwnProperty.call(manual, w.username)) {
      const h = manual[w.username] ? String(manual[w.username]).replace(/^@/, '').toLowerCase() : null;
      a = { ig_username: w.username, handle: h, did: null, label: w.label, stance: w.stance, country: w.country, status: h ? 'manual' : 'none', checked_at: new Date().toISOString() };
    } else if (!a || now - Date.parse(a.checked_at) > RESEARCH_DAYS * 864e5) {
      try {
        const r = await get('app.bsky.actor.searchActors', { q: w.label || w.username, limit: 10 });
        const m = pickActor(w, r.actors);
        a = { ig_username: w.username, handle: m ? m.handle : null, did: m ? m.did : null, label: w.label, stance: w.stance, country: w.country, status: m ? 'matched' : 'none', checked_at: new Date().toISOString() };
      } catch (e) { console.log(`  search ${w.username}: ${e.message}`); failed++; continue; }
      await pause(400);
    } else a = { ...a, label: w.label, stance: w.stance, country: w.country };
    accounts.push(a);
  }
  if (pg) await pg.upsert('listen_bsky_accounts', accounts, 'ig_username');
  for (const a of accounts.filter((x) => x.handle)) {
    found++;
    try {
      const f = await get('app.bsky.feed.getAuthorFeed', { actor: a.handle, limit: 50, filter: 'posts_no_replies' });
      const rows = parseFeed(f, a, a.handle).filter((r) => now - Date.parse(r.created_at) <= 90 * 864e5);
      if (pg && rows.length) await pg.upsert('listen_bsky_posts', rows, 'uri');
      posts += rows.length;
      console.log(`  @${a.handle} (${a.stance}): ${rows.length} post(s)`);
    } catch (e) { console.log(`  @${a.handle}: ${e.message}`); failed++; }
    await pause(400);
  }
  if (pg) {
    const cut = new Date(now - KEEP_DAYS * 864e5).toISOString();
    await fetch(`${base}/rest/v1/listen_bsky_posts?created_at=lt.${encodeURIComponent(cut)}`, { method: 'DELETE', headers: { ...H, Prefer: 'return=minimal' } });
  }
  console.log(`done: ${found} of ${watched.length} watched organisations on Bluesky, ${posts} post(s)${failed ? `, ${failed} read(s) failed` : ''}`);
}

if (require.main === module) main().catch((e) => { console.error(`bluesky watch failed: ${e.message}`); process.exit(1); });

module.exports = { pickActor, parseFeed, norm };
