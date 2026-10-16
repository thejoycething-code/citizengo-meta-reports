#!/usr/bin/env node
'use strict';
// When did these X accounts last post? (16 Oct 2026: which old CitizenGO
// country accounts are still active.) One users/by call, through a connected
// account's credential; the date comes from the most recent post's id (X ids
// carry their timestamp), so no timelines are read.
//
//   node scripts/x-lookup.js <username> [<username> ...] [--via CitizenGO]
//
// Run by the "X account lookup" workflow (it has the X secrets). Uses the
// collector's own credential handling (collector/x.js accessTokenFor), which
// saves X's ROTATED refresh token before the access token is used - anything
// else would break nightly collection for the --via account. Billed as one user
// read per account found (about $0.01 each).

const { loadEnv } = require('../lib/graph');
loadEnv();
const xapi = require('../lib/xapi');
const { accessTokenFor, loadAccounts } = require('../collector/x');

const args = process.argv.slice(2);
const viaI = args.indexOf('--via');
const via = (viaI !== -1 ? args[viaI + 1] : 'CitizenGO').replace(/^@/, '').toLowerCase();
const names = args.filter((a, i) => !a.startsWith('--') && !(viaI !== -1 && i === viaI + 1)).map((a) => a.replace(/^@/, '')).filter(Boolean);

// X ids are snowflakes: milliseconds since 2010-11-04 sit above bit 22.
const dateOfId = (id) => new Date(Number(BigInt(id) >> 22n) + 1288834974657);

async function main() {
  const handles = [...new Set(names.filter((n) => n.toLowerCase() !== via))];
  if (!handles.length || handles.length > 100) { console.error('Give 1-100 usernames.'); process.exit(2); }
  const accounts = await loadAccounts();
  const acct = accounts.find((a) => String(a.username || '').toLowerCase() === via);
  if (!acct) { console.error(`@${via} is not a connected account.`); process.exit(2); }
  const cred = await accessTokenFor(acct, console.log);
  if (cred.error) { console.error(`credential: ${cred.error}`); process.exit(1); }
  const client = xapi.makeClient({ token: cred.token });
  const r = await client.get('/2/users/by', { usernames: handles.join(','), 'user.fields': 'created_at,public_metrics,most_recent_tweet_id,description,protected' }, { countAs: 'user' });
  const users = (r.body && r.body.data) || [];
  const errs = (r.body && r.body.errors) || [];
  console.log(`\nLooked up ${handles.length} handle(s) via @${acct.username}: ${users.length} found (~$${(users.length * 0.01).toFixed(2)})\n`);
  const now = Date.now();
  for (const u of users.sort((a, b) => (b.most_recent_tweet_id ? 1 : 0) - (a.most_recent_tweet_id ? 1 : 0))) {
    const last = u.most_recent_tweet_id ? dateOfId(u.most_recent_tweet_id) : null;
    const days = last ? Math.floor((now - last) / 86400000) : null;
    const pm = u.public_metrics || {};
    console.log(`@${u.username} (${u.name}) · ${pm.followers_count ?? '?'} followers · ${pm.tweet_count ?? '?'} posts · `
      + (last ? `last post ${last.toISOString().slice(0, 10)} (${days} days ago)` : 'no posts') + (u.protected ? ' · protected' : ''));
  }
  for (const e of errs) console.log(`not found: ${e.value || e.resource_id || ''} (${e.title || e.detail || 'error'})`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
