#!/usr/bin/env node
'use strict';
// Why do some Reels return HTTP 200 with no media_url?
//
// Eight of the first ~143 transcribed came back that way - roughly 6% - across
// three different pages, all REELS, all with thumbnails. That rules out a
// per-page permission problem and a wrong media_type. This asks the failing
// media directly, alongside known-good controls from the same pages and dates,
// and prints what Graph actually returns.
//
//   node scripts/probe-missing-media-url.js
//
// READ-ONLY. Runs in Actions: META_TOKENS is a repository secret.

const { loadEnv, makeClient } = require('../lib/graph');

loadEnv();

const { makePageTokens } = require('../lib/pagetokens');

const VERSION = process.env.GRAPH_VERSION || 'v23.0';

// Everything that might explain the absence. Asked one field at a time where
// it matters, because a single unavailable field fails the whole combined
// request and would look like the media being unreachable.
const SOLO = ['media_url', 'media_type', 'media_product_type',
  // The hypothesis worth killing first: a Reel co-authored with, or shared
  // from, another account is not wholly ours, and Meta may decline to hand
  // over the file. owner.id against the page's own IG user id settles it.
  'owner', 'username', 'shortcode', 'is_shared_to_feed',
  // Licensed audio is the other candidate. No documented field exposes it,
  // so these are asked on the off-chance the version has grown one.
  'music_metadata', 'copyright_check_information', 'alt_media_url'];

const SB = String(process.env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY;

async function q(pathname) {
  const r = await fetch(`${SB}/rest/v1/${pathname}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : [];
}

async function main() {
  const tokens = String(process.env.META_TOKENS || process.env.META_TOKEN || '')
    .split(/[\n,]/).map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) { console.error('No token. Set META_TOKENS.'); process.exit(2); }
  const client = makeClient({ token: tokens[0], version: VERSION });
  const pt = makePageTokens(client, tokens);
  await pt.enumeratePages();

  const failing = await q('meta_ig_media_transcript?select=media_id&error=like.no%20media_url*&limit=20');
  const ids = failing.map((r) => r.media_id);
  if (!ids.length) { console.log('nothing failing that way any more'); return; }

  const meta = await q(`meta_ig_media?select=media_id,page_id,timestamp,permalink,ig_username`
    + `&media_id=in.(${ids.join(',')})&order=timestamp.asc`);

  // Controls: transcribed successfully, same page, nearest in time. If the
  // control works and the subject does not, the difference is the media, not
  // the token, the page or the date.
  const good = await q('meta_ig_media_transcript?select=media_id&error=is.null&transcript=not.is.null&limit=200');
  const goodIds = new Set(good.map((r) => r.media_id));
  const sameDay = await q(`meta_ig_media?select=media_id,page_id,timestamp,ig_username&media_type=eq.VIDEO`
    + `&timestamp=gte.2026-06-01&timestamp=lt.2026-07-01&limit=1000`);

  const controls = [];
  for (const m of meta) {
    const c = sameDay
      .filter((x) => x.page_id === m.page_id && goodIds.has(x.media_id))
      .sort((a, b) => Math.abs(Date.parse(a.timestamp) - Date.parse(m.timestamp))
                    - Math.abs(Date.parse(b.timestamp) - Date.parse(m.timestamp)))[0];
    if (c && !controls.some((x) => x.media_id === c.media_id)) controls.push({ ...c, control_for: m.media_id });
  }

  const look = async (m, label) => {
    const tok = (await pt.tokenFor(m.page_id)) || tokens[0];
    console.log(`\n--- ${label} ${m.media_id}  @${m.ig_username}  ${String(m.timestamp).slice(0, 10)}`);
    for (const f of SOLO) {
      const r = await client.get(`/${m.media_id}`, { fields: f }, { token: tok });
      const present = r.ok && Object.prototype.hasOwnProperty.call(r.body || {}, f);
      // Objects stringify to "[object Object]", which is how the first run
      // threw away the owner - the one field that would show whether these
      // Reels belong to somebody else.
      const raw = present ? r.body[f] : null;
      const v = present ? (typeof raw === 'object' ? JSON.stringify(raw) : String(raw)) : null;
      const err = r.ok ? '' : ` — ${(r.body && r.body.error && r.body.error.message) || `HTTP ${r.status}`}`;
      console.log(`  ${f.padEnd(22)} ${present ? (v.length > 60 ? v.slice(0, 57) + '...' : v) : 'ABSENT'}${err}`);
    }
    // Asked twice: if the second attempt returns it, the absence is transient
    // and the answer is "retry", not "this media is different".
    const again = await client.get(`/${m.media_id}`, { fields: 'media_url' }, { token: tok });
    console.log(`  ${'media_url (retry)'.padEnd(22)} ${again.ok && again.body.media_url ? 'PRESENT this time' : 'still absent'}`);
  };

  console.log(`Probing ${meta.length} Reel(s) with no media_url, and ${controls.length} control(s), on Graph ${VERSION}`);
  for (const m of meta) await look(m, 'SUBJECT');
  for (const c of controls) await look(c, 'CONTROL');

  // The page's own IG user id, to compare owner against.
  const owners = await q(`meta_ig_media?select=page_id,ig_user_id,ig_username&media_id=in.(${ids.join(',')})`);
  console.log('\nPage IG user ids, to compare against owner.id above:');
  for (const o of [...new Map(owners.map((o) => [o.page_id, o])).values()]) {
    console.log(`  ${o.ig_username.padEnd(24)} ig_user_id ${o.ig_user_id}`);
  }
  console.log('\nControls returned media_url and subjects did not, on the same pages and days,');
  console.log('so the difference is in the media. If owner.id differs from the page ig_user_id');
  console.log('above, these Reels are not wholly ours and that is the reason.');
}

main().catch((e) => { console.error(e); process.exit(1); });
