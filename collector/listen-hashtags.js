#!/usr/bin/env node
'use strict';
// Listening › Beyond our list: public Instagram posts for the hashtags in
// config/listen-hashtags.json, from anyone, not only the accounts we follow.
//
// Official and free: Instagram's hashtag search (ig_hashtag_search, then each
// hashtag's top_media and recent_media), called as our own linked Instagram
// account like collector/peers-ig.js. Meta allows 30 different hashtags in any
// 7 days per account, so the list stays at 25 or fewer. Hashtag results carry
// no usernames; we keep the caption, link, time and like/comment counts, and
// delete rows after 30 days.
//
// Usage: node collector/listen-hashtags.js [--dry-run] [--only tag1,tag2]
// Env: META_TOKENS, PEER_IG_VIA / PEER_IG_VIA_ID (as peers-ig), SUPABASE_URL,
//      SUPABASE_SERVICE_KEY.

const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../lib/graph');
const { connect, makePg } = require('./peers-ig');

const LIST = path.join(__dirname, '..', 'config', 'listen-hashtags.json');
const FIELDS = 'id,caption,permalink,timestamp,media_type,like_count,comments_count';
const MAX_TAGS = 25;
const KEEP_DAYS = 30;

function loadTags(file = LIST) {
  const seen = new Set();
  return JSON.parse(fs.readFileSync(file, 'utf8'))
    .map((r) => ({ tag: String(r.tag || '').toLowerCase().replace(/^#/, '').replace(/[^\p{L}\p{N}_]/gu, ''), topic: r.topic || null }))
    .filter((r) => r.tag && !seen.has(r.tag) && seen.add(r.tag))
    .slice(0, MAX_TAGS);
}

const row = (tag, m, top, now) => ({
  hashtag: tag, media_id: String(m.id), caption: m.caption ? String(m.caption).slice(0, 2000) : null, permalink: m.permalink || null,
  posted_at: m.timestamp || null, media_type: m.media_type || null, like_count: m.like_count ?? null, comments_count: m.comments_count ?? null,
  top, collected_at: now,
});

// get: Graph GET returning { ok, body, error }. Returns rows and a log line per tag.
async function readTag(get, viaId, tag, now = new Date().toISOString()) {
  const s = await get('/ig_hashtag_search', { user_id: viaId, q: tag });
  if (!s.ok) return { error: s.error ? `${s.error.code || ''} ${s.error.message || ''}`.trim() : `HTTP ${s.status}` };
  const id = s.body && s.body.data && s.body.data[0] && s.body.data[0].id;
  if (!id) return { rows: [] };
  const [top, recent] = await Promise.all([
    get(`/${id}/top_media`, { user_id: viaId, fields: FIELDS, limit: 50 }),
    get(`/${id}/recent_media`, { user_id: viaId, fields: FIELDS, limit: 50 }),
  ]);
  const rows = new Map();
  for (const m of (recent.ok && recent.body && recent.body.data) || []) rows.set(String(m.id), row(tag, m, false, now));
  for (const m of (top.ok && top.body && top.body.data) || []) rows.set(String(m.id), row(tag, m, true, now));
  return { rows: [...rows.values()], partial: !top.ok || !recent.ok };
}

async function main() {
  loadEnv();
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const only = (argv[argv.indexOf('--only') + 1] || '').split(',').filter((x) => argv.includes('--only') && x);
  const tokens = String(process.env.META_TOKENS || process.env.META_TOKEN || '').split(/[\n,]/).map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) throw new Error('META_TOKENS is not set');
  const { client, via } = await connect(tokens);
  let tags = loadTags();
  if (only.length) tags = tags.filter((t) => only.includes(t.tag));
  console.log(`hashtag watch as @${via.username}: ${tags.length} hashtag(s)${dryRun ? ', dry run' : ''}`);
  const pg = dryRun ? null : makePg();
  let stored = 0, failed = 0;
  for (const t of tags) {
    const r = await readTag(client.get, via.id, t.tag);
    if (r.error) {
      failed++;
      console.log(`  #${t.tag}: ${r.error.slice(0, 140)}`);
      // Hashtag search needs Meta's "Instagram Public Content Access" feature on the app.
      if (/permission|public content|\(#10\)|code 10\b/i.test(r.error)) { console.log('  stopping: this app may not have hashtag search access'); break; }
      continue;
    }
    console.log(`  #${t.tag}: ${r.rows.length} post(s)${r.partial ? ' (partial)' : ''}`);
    if (pg && r.rows.length) await pg.upsert('listen_hashtag_media', r.rows, 'hashtag,media_id');
    stored += r.rows.length;
  }
  if (pg) {
    const base = String(process.env.SUPABASE_URL).trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
    const key = process.env.SUPABASE_SERVICE_KEY;
    const cut = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString();
    const d = await fetch(`${base}/rest/v1/listen_hashtag_media?collected_at=lt.${encodeURIComponent(cut)}`, { method: 'DELETE', headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'return=minimal' } });
    if (!d.ok) console.log(`  retention delete failed (HTTP ${d.status})`);
  }
  console.log(`done: ${stored} post(s) from ${tags.length - failed} hashtag(s), ${failed} failed`);
  if (tags.length && failed === tags.length) process.exitCode = 1;
}

if (require.main === module) main().catch((e) => { console.error(`hashtag watch failed: ${e.message}`); process.exit(1); });

module.exports = { loadTags, readTag, MAX_TAGS };
