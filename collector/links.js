#!/usr/bin/env node
'use strict';
// Link registry (15 Oct 2026). Every CitizenGO link that any connected account
// posted - Facebook Pages, Instagram and X, spokespeople included - with the
// campaign code it carries, so link_performance can join it to signatures.
//
//   node collector/links.js [--days 30] [--all] [--dry-run]
//
// Reads what the other collectors already stored (meta_posts, meta_ig_media,
// x_posts); it calls no social API. cgo.ac short links are resolved once each
// through the shortener's redirect and cached in link_shortcodes. A failed
// resolution is not cached, so the next run tries again.
//
// What it cannot see: links Facebook posts carry only in their FIRST COMMENT
// (comments are not collected), Stories, and DMs. Signatures from those still
// reach link_signatures through their campaign code; the tool lists them as
// codes not seen in any post.

const path = require('path');
const { loadEnv } = require('../lib/graph');
const links = require('../lib/links');
const { makeSink } = require('./lib/sinks');

loadEnv();
const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf('--' + name); return i !== -1 && args[i + 1] ? args[i + 1] : dflt; };
const DRY_RUN = args.includes('--dry-run');
const ALL = args.includes('--all');
const DAYS = Number(flag('days', 30));
const SINCE = ALL ? '2020-01-01T00:00:00Z' : new Date(Date.now() - DAYS * 86400000).toISOString();

const BASE = (process.env.SUPABASE_URL || '').trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY || '';

async function readAll(table, query) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await fetch(`${BASE}/rest/v1/${table}?${query}&limit=1000&offset=${offset}`, { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } });
    if (!r.ok) throw new Error(`read ${table}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

async function mapLimit(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

// Pure: posts in, link rows out. Exported for the tests.
function rowsFor({ fbPosts = [], igMedia = [], xPosts = [], pages = [], xAccounts = [], shortMap = new Map() }) {
  const pageName = new Map(pages.map((p) => [p.page_id, p.name]));
  const xAcc = new Map(xAccounts.map((a) => [a.account_id, a]));
  const rows = [];
  const add = (base, url) => {
    const short_code = links.shortCodeOf(url);
    const full_url = short_code ? (shortMap.get(short_code) || null) : url;
    const t = links.parseTracked(full_url);
    rows.push({ ...base, url, short_code, full_url, ...t, updated_at: new Date().toISOString() });
  };
  for (const p of fbPosts) {
    const base = { platform: 'facebook', post_id: p.post_id, account_id: p.page_id, account_label: pageName.get(p.page_id) || null,
      account_kind: 'organisation', posted_at: p.created_time, permalink_url: p.permalink_url || null };
    for (const u of links.extractLinks(`${p.link_url || ''} ${p.message || ''}`)) add(base, u);
  }
  for (const m of igMedia) {
    const base = { platform: 'instagram', post_id: m.media_id, account_id: m.ig_user_id, account_label: m.ig_username ? '@' + m.ig_username : (pageName.get(m.page_id) || null),
      account_kind: 'organisation', posted_at: m.timestamp, permalink_url: m.permalink || null };
    for (const u of links.extractLinks(m.caption)) add(base, u);
  }
  for (const x of xPosts) {
    const a = xAcc.get(x.account_id) || {};
    const base = { platform: 'x', post_id: x.post_id, account_id: x.account_id, account_label: a.username ? '@' + a.username : (a.label || null),
      account_kind: a.kind || 'organisation', posted_at: x.created_at, permalink_url: x.permalink_url || null };
    for (const u of new Set(x.citizengo_urls || [])) add(base, u);
  }
  return rows;
}

async function main() {
  if (!BASE || !KEY) { console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY are needed (the registry reads what the collectors stored).'); process.exit(2); }
  const since = encodeURIComponent(SINCE);
  console.log(`Link registry · posts since ${SINCE.slice(0, 10)}${DRY_RUN ? ' · dry run' : ''}`);
  const [pages, fbPosts, igMedia, xPosts, xAccounts] = await Promise.all([
    readAll('meta_pages', 'select=page_id,name'),
    readAll('meta_posts', `select=post_id,page_id,created_time,message,link_url,permalink_url&created_time=gte.${since}&or=(message.ilike.*citizengo*,message.ilike.*cgo.ac*,message.ilike.*hazteoir*,message.ilike.*derechoavivir*,link_url.not.is.null)`),
    readAll('meta_ig_media', `select=media_id,page_id,ig_user_id,ig_username,caption,permalink,timestamp&timestamp=gte.${since}&or=(caption.ilike.*citizengo*,caption.ilike.*cgo.ac*,caption.ilike.*hazteoir*,caption.ilike.*derechoavivir*)`),
    readAll('x_posts', `select=post_id,account_id,created_at,citizengo_urls,permalink_url&created_at=gte.${since}&citizengo_urls=neq.[]`),
    readAll('x_accounts', 'select=account_id,username,label,kind'),
  ]);
  console.log(`  read ${fbPosts.length} Facebook, ${igMedia.length} Instagram and ${xPosts.length} X posts that may carry our links`);

  // Short codes: cached ones first, then resolve the rest.
  const first = rowsFor({ fbPosts, igMedia, xPosts, pages, xAccounts });
  const codes = [...new Set(first.map((r) => r.short_code).filter(Boolean))];
  const shortMap = new Map();
  for (let i = 0; i < codes.length; i += 150) {
    const chunk = codes.slice(i, i + 150).map((c) => `"${c}"`).join(',');
    for (const r of await readAll('link_shortcodes', `select=short_code,full_url&full_url=not.is.null&short_code=in.(${encodeURIComponent(chunk)})`)) shortMap.set(r.short_code, r.full_url);
  }
  const todo = codes.filter((c) => !shortMap.has(c));
  console.log(`  ${codes.length} short links: ${shortMap.size} already resolved, ${todo.length} to resolve`);
  const resolved = [];
  let failed = 0;
  await mapLimit(todo, 6, async (c) => {
    const r = await links.resolveShortCode(c);
    if (r.full_url) { shortMap.set(c, r.full_url); resolved.push({ short_code: c, full_url: r.full_url, http_status: r.http_status, resolved_at: new Date().toISOString() }); } else failed++;
  });
  if (failed) console.log(`  ${failed} short link(s) could not be resolved; they are retried next run`);

  const rows = rowsFor({ fbPosts, igMedia, xPosts, pages, xAccounts, shortMap });
  const sink = makeSink({ dryRun: DRY_RUN, dir: path.join(__dirname, '..', 'data') });
  for (let i = 0; i < resolved.length; i += 500) await sink.upsert('link_shortcodes', resolved.slice(i, i + 500));
  // One post can list the same link twice (link_url and message): keyed rows only.
  const uniq = [...new Map(rows.map((r) => [`${r.platform}|${r.post_id}|${r.url}`, r])).values()];
  for (let i = 0; i < uniq.length; i += 500) await sink.upsert('link_posts', uniq.slice(i, i + 500));
  await sink.flush();
  const coded = uniq.filter((r) => r.campaign_code).length;
  console.log(`  wrote ${uniq.length} link rows (${coded} with a campaign code, ${uniq.length - coded} plain links) and ${resolved.length} new short-link resolutions`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { rowsFor };
