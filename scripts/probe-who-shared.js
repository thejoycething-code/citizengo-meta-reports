#!/usr/bin/env node
'use strict';
// WHO shared our posts? We measure the effect of resharing already
// (meta_post_amplification: reactions on reshares vs reactions on the post)
// but hold no identity for a single sharer.
//
// Graph's /{post-id}/sharedposts is the only documented route, and it is
// heavily restricted - it has historically returned only shares the token can
// already see, which for a Page token may be nothing at all. Rather than
// design a feature around a hope, ask it, on real posts that were shared
// hundreds of times, and print exactly what comes back.
//
//   node scripts/probe-who-shared.js
//
// READ-ONLY. Runs in Actions: META_TOKENS is a repository secret.

const { loadEnv, makeClient } = require('../lib/graph');

loadEnv();

const { makePageTokens } = require('../lib/pagetokens');

const VERSION = process.env.GRAPH_VERSION || 'v23.0';

const SB = String(process.env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY;

async function q(pathname) {
  const r = await fetch(`${SB}/rest/v1/${pathname}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : [];
}

// Each asked separately: one unavailable edge must not take the others down,
// and "which of these works" is the entire question.
const ATTEMPTS = [
  { label: 'sharedposts (edge)', path: (id) => `/${id}/sharedposts`, params: { limit: 5 } },
  { label: 'sharedposts + fields', path: (id) => `/${id}/sharedposts`, params: { limit: 5, fields: 'id,from,created_time,permalink_url' } },
  { label: 'sharedposts (as field)', path: (id) => `/${id}`, params: { fields: 'sharedposts.limit(5){id,from}' } },
  { label: 'reactions (who reacted)', path: (id) => `/${id}/reactions`, params: { limit: 5, fields: 'id,name,type' } },
  { label: 'comments (who commented)', path: (id) => `/${id}/comments`, params: { limit: 3, fields: 'id,from,message' } },
  // Not identity, but worth knowing whether a share COUNT is broken out anywhere.
  { label: 'insights: post_activity_by_action_type', path: (id) => `/${id}/insights`, params: { metric: 'post_activity_by_action_type' } },
];

async function main() {
  const tokens = String(process.env.META_TOKENS || process.env.META_TOKEN || '')
    .split(/[\n,]/).map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) { console.error('No token. Set META_TOKENS.'); process.exit(2); }
  const client = makeClient({ token: tokens[0], version: VERSION });
  const pt = makePageTokens(client, tokens);
  await pt.enumeratePages();

  // The most-shared posts we hold: if sharing identity is visible anywhere, it
  // is visible on these. A null result on a post shared 600 times is decisive.
  const posts = await q('meta_post_latest?select=post_id,page_id,page_name,shares_total,created_time'
    + '&shares_total=not.is.null&order=shares_total.desc&limit=4');

  console.log(`Probing ${posts.length} of our most-shared posts on Graph ${VERSION}\n`);

  const worked = new Set();
  for (const post of posts) {
    const tok = (await pt.tokenFor(post.page_id)) || tokens[0];
    console.log(`--- ${post.post_id}  ${post.page_name}  ${String(post.created_time).slice(0, 10)}  ${post.shares_total} shares`);
    for (const a of ATTEMPTS) {
      const r = await client.get(a.path(post.post_id), a.params, { token: tok });
      if (!r.ok) {
        const msg = (r.body && r.body.error && r.body.error.message) || `HTTP ${r.status}`;
        console.log(`  ${a.label.padEnd(36)} REFUSED — ${String(msg).slice(0, 95)}`);
        continue;
      }
      const data = r.body.data || r.body.sharedposts?.data || null;
      if (Array.isArray(data)) {
        console.log(`  ${a.label.padEnd(36)} ${data.length} row(s)`
          + (data.length ? ` — e.g. ${JSON.stringify(data[0]).slice(0, 110)}` : ' — EMPTY'));
        if (data.length) worked.add(a.label);
      } else {
        console.log(`  ${a.label.padEnd(36)} ${JSON.stringify(r.body).slice(0, 110)}`);
      }
    }
    console.log();
  }

  console.log(worked.size
    ? `VERDICT: these returned rows — ${[...worked].join('; ')}`
    : 'VERDICT: nothing returned sharer identity. An empty edge on a post shared '
      + 'hundreds of times is Meta declining, not us asking wrongly.');
}

main().catch((e) => { console.error(e); process.exit(1); });
