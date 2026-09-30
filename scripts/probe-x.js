#!/usr/bin/env node
'use strict';
// The one-account spike from the scoping brief. Answers, against the live API
// and before any of the X source is switched on:
//
//   1. Which metric groups actually come back for our own posts, by post age -
//      X's docs say public always, private only under 30 days. Documentation
//      was wrong twice on the Meta side; this is the check.
//   2. What the request cost: resources returned, priced at the owned-read
//      rate, so the figure can be checked against the developer console after
//      the run. That comparison is what settles the $0.001 vs $0.005 question.
//   3. Rate-limit headroom.
//
// Usage:
//   X_PROBE_TOKEN=<user-context access token> npm run probe:x -- [--days 40] [--max 50]
//
// The token must be USER CONTEXT (OAuth 2.0 with tweet.read users.read) for the
// private groups to appear; an app-only bearer shows the public-only shape,
// which is also worth seeing. Get one from the X developer portal's OAuth 2.0
// playground, or run the authorise flow locally.
//
// Writes redacted fixtures to fixtures/x-<date>-*.json, the same evidence
// discipline as probe/probe.js. Costs cents.

const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../lib/graph');
const xapi = require('../lib/xapi');
const sched = require('../lib/xschedule');

loadEnv();

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i !== -1 && args[i + 1] ? Number(args[i + 1]) : d; };
const DAYS = opt('days', 40);
const MAX = opt('max', 50);
// --stored: use an enrolled account's sealed credential instead of a pasted
// token. Refreshing ROTATES the refresh token, so this goes through the
// collector's own accessTokenFor, which saves the new one before returning.
const STORED = args.includes('--stored');
const ACCOUNT = (() => { const i = args.indexOf('--account'); return i !== -1 ? args[i + 1] : null; })();
let token = process.env.X_PROBE_TOKEN;
if (!token && !STORED) { console.error('Set X_PROBE_TOKEN, or pass --stored to use an enrolled account.'); process.exit(2); }

const stamp = new Date().toISOString().slice(0, 10);
const outDir = path.join(__dirname, '..', 'fixtures');
const save = (name, obj) => {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `x-${stamp}-${name}.json`), JSON.stringify(xapi.redact(obj), null, 2));
};

const has = (o, k) => o && o[k] && typeof o[k] === 'object' && Object.keys(o[k]).length > 0;

async function main() {
  if (!token) {
    const { loadAccounts, accessTokenFor } = require('../collector/x');
    const all = (await loadAccounts()).filter((a) => !a.inline);
    const acc = ACCOUNT ? all.find((a) => [a.account_id, a.username, a.label].includes(ACCOUNT)) : all[0];
    if (!acc) { console.error('No enrolled account found' + (ACCOUNT ? ` matching ${ACCOUNT}` : '') + '.'); process.exit(2); }
    const cred = await accessTokenFor(acc, (m) => console.log(m));
    if (cred.error) { console.error(`Could not get an access token for @${acc.username}: ${cred.error}`); process.exit(1); }
    token = cred.token;
    console.log(`Using the stored credential for @${acc.username} (refresh token rotated and saved).`);
  }
  const client = xapi.makeClient({ token });
  console.log(`X probe · ${DAYS} days back · up to ${MAX} posts\n`);

  const me = await client.me();
  save('01-me', me);
  if (!me.ok) {
    console.error(`/2/users/me failed: HTTP ${me.status} ${me.title || ''} ${me.detail || ''}`);
    console.error('An app-only bearer cannot call /2/users/me. Use a user-context token.');
    process.exit(1);
  }
  const u = me.body.data;
  console.log(`Account: @${u.username} (${u.id}) · ${u.public_metrics ? u.public_metrics.followers_count : '?'} followers`);
  console.log(`  rate limit: ${me.rate.remaining}/${me.rate.limit} remaining\n`);

  // Pass A: inside the private window, ALL groups requested.
  const inWin = new Date(Date.now() - Math.min(DAYS, sched.PRIVATE_WINDOW_DAYS) * 86_400_000).toISOString();
  const a = await client.userPosts(u.id, { start_time: inWin, max_results: Math.min(MAX, 100), privateWindow: true });
  save('02-posts-private-window', a);
  console.log(`Pass A  posts since ${inWin.slice(0, 10)} with public+non_public+organic+promoted: HTTP ${a.status}${a.ok ? '' : ` ${a.title || ''} ${a.detail || ''}`}`);
  if (a.errors && a.errors.length) {
    const unexpected = a.errors.filter((e) => !xapi.expectedRefusal(e));
    console.log(`  ${a.errors.length} partial error(s), ${a.errors.length - unexpected.length} expected (promoted on unboosted posts, private on retweets)`
      + `${unexpected.length ? `; UNEXPECTED: ${JSON.stringify(unexpected[0]).slice(0, 200)}` : ''}`);
  }

  // Pass B: older than the window, PUBLIC only - what a backfill would see.
  let b = null;
  if (DAYS > sched.PRIVATE_WINDOW_DAYS) {
    const start = new Date(Date.now() - DAYS * 86_400_000).toISOString();
    const end = new Date(Date.now() - (sched.PRIVATE_WINDOW_DAYS + 1) * 86_400_000).toISOString();
    b = await client.userPosts(u.id, { start_time: start, end_time: end, max_results: Math.min(MAX, 100), privateWindow: false });
    save('03-posts-public-only-older', b);
    console.log(`Pass B  posts ${start.slice(0, 10)}..${end.slice(0, 10)} public only: HTTP ${b.status}${b.ok ? '' : ` ${b.title || ''} ${b.detail || ''}`}`);

    // Pass C: the documented refusal - private groups on an old post. We WANT
    // to see how X refuses (whole request vs partial error), because the
    // collector's design depends on it.
    // An ORIGINAL post, not whatever came first. The first live run picked a
    // retweet, and what it measured was the retweet refusal, not the age one.
    const old = b.ok && b.body && b.body.data
      && b.body.data.find((t) => !(t.referenced_tweets && t.referenced_tweets.length));
    if (old) {
      const c = await client.postsByIds([old.id], { privateWindow: true });
      save('04-old-post-private-requested', c);
      console.log(`Pass C  private groups requested on a ${sched.ageDays(old.created_at)}-day-old ORIGINAL post: HTTP ${c.status}`
        + `${c.ok ? (c.errors ? ` with ${c.errors.length} partial error(s)` : ' and no error at all') : ` ${c.title || ''} ${c.detail || ''}`}`);
      if (c.ok && c.body && c.body.data && c.body.data[0]) {
        const t = c.body.data[0];
        console.log(`        groups present: public=${has(t, 'public_metrics')} non_public=${has(t, 'non_public_metrics')} organic=${has(t, 'organic_metrics')} promoted=${has(t, 'promoted_metrics')}`);
        const why = [...new Set((c.errors || []).map((e) => e.detail))].slice(0, 3);
        if (why.length) console.log(`        X said: ${why.join(' | ').slice(0, 300)}`);
      }
    }
  }

  // Availability matrix.
  const posts = (a.ok && a.body && a.body.data) || [];
  console.log(`\nMetric groups returned (pass A, ${posts.length} posts):`);
  const mediaCount = (a.body && a.body.includes && a.body.includes.media || []).length;
  console.log(`  includes.media: ${mediaCount} item(s)${mediaCount ? '' : ' - if posts have media, the expansion name is wrong'}`);
  console.log('  age  public  non_public  organic  promoted  media  links(ours)  text');
  for (const t of posts.slice(0, 25)) {
    const links = sched.extractUrls(t.entities);
    console.log(`  ${String(sched.ageDays(t.created_at)).padStart(3)}  ${String(has(t, 'public_metrics')).padEnd(6)}  ${String(has(t, 'non_public_metrics')).padEnd(10)}  ${String(has(t, 'organic_metrics')).padEnd(7)}  ${String(has(t, 'promoted_metrics')).padEnd(8)}  ${String(Boolean(t.attachments && t.attachments.media_keys)).padEnd(5)}  ${String(links.citizengo_urls.length).padEnd(11)}  ${(t.text || '').replace(/\s+/g, ' ').slice(0, 40)}`);
  }
  const withPrivate = posts.filter((t) => has(t, 'non_public_metrics')).length;
  if (posts.length && !withPrivate) {
    console.log('\n  NO post returned non_public_metrics. If this is a user-context token, that is a finding');
    console.log('  that contradicts the docs and changes the design. If it is an app-only bearer, expected.');
  }
  if (posts.length && withPrivate) {
    const sample = posts.find((t) => has(t, 'non_public_metrics'));
    console.log(`\n  non_public keys: ${Object.keys(sample.non_public_metrics).join(', ')}`);
    if (has(sample, 'organic_metrics')) console.log(`  organic keys:    ${Object.keys(sample.organic_metrics).join(', ')}`);
    console.log(`  public keys:     ${Object.keys(sample.public_metrics || {}).join(', ')}`);
  }

  // Cost.
  const t = client.tally;
  const owned = sched.estimateCost({ postReads: t.postReads, userReads: t.userReads, owned: true });
  const notOwned = sched.estimateCost({ postReads: t.postReads, userReads: t.userReads, owned: false });
  console.log(`\nResources: ${t.postReads} post(s), ${t.userReads} user(s) in ${t.calls} call(s)${t.waits ? `, ${t.waits} rate-limit wait(s)` : ''}`);
  console.log(`Estimated cost: $${owned.toFixed(4)} at the owned-read rate, $${notOwned.toFixed(4)} if billed as ordinary reads.`);
  console.log('Compare against the developer console usage page for today. Whichever it matches is the rate we pay.');
  console.log(`\nFixtures written to fixtures/x-${stamp}-*.json (tokens redacted).`);
}

main().catch((e) => { console.error('probe crashed:', e); process.exit(1); });
