#!/usr/bin/env node
'use strict';
// Pins the X groundwork before any of it touches X or the database:
//   * the recollection schedule and the cost it implies (lib/xschedule.js)
//   * link attribution: which URLs count as ours
//   * the sealed box - Vercel can write a credential it cannot read
//   * PKCE, invites, and how X refusals surface (lib/xauth.js against a mock)
//   * the API client's billing tally and its one-shot 429 wait (lib/xapi.js)
//   * the X-object-to-row mapping the collector writes (collector/x.js)
//   * sink idempotency for the x_* tables
//
// Run: npm run test:x   (no network, no credentials; a local mock stands in for X)

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sched = require('../lib/xschedule');
const xauth = require('../lib/xauth');
const xapi = require('../lib/xapi');
const { toRows } = require('../collector/x');
const { jsonSink } = require('../collector/lib/sinks');

let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { console.log(`  ok    ${name}`); passed++; } else { console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`); failed++; }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const throws = (name, fn, re) => {
  try { fn(); ok(name, false, 'did not throw'); } catch (e) { ok(name, !re || re.test(e.message), `threw: ${e.message}`); }
};

const D = 86_400_000;
const NOW = new Date('2026-09-08T05:15:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * D).toISOString();

// ---------------------------------------------------------------------------
console.log('\nSchedule (lib/xschedule.js)\n');
eq('ageDays: 6.9 days ago floors to 6', sched.ageDays(daysAgo(6.9), NOW), 6);
ok('private window is inside X\'s 30 days', sched.PRIVATE_WINDOW_DAYS < 30);

eq('daily window covers days 0-7 (eight nights)', sched.dailyWindow(NOW).start_time, daysAgo(8));
eq('checkpoints are 14, 28, 60, 85; 12 reads per post', [sched.CHECKPOINTS, sched.READS_PER_POST], [[14, 28, 60, 85], 12]);
eq('checkpointFor maps an age to the last checkpoint reached', [5, 14, 27, 28, 59, 60, 84, 85, 89].map(sched.checkpointFor), [null, 14, 14, 28, 28, 60, 60, 85, 85]);
const dueC = sched.dueForCheckpoint([
  { post_id: 'young', created_at: daysAgo(10), last_collected_at: daysAgo(3) },     // no checkpoint yet
  { post_id: 'd14', created_at: daysAgo(14), last_collected_at: daysAgo(7) },       // read at 7, now 14
  { post_id: 'd14-late', created_at: daysAgo(20), last_collected_at: daysAgo(13) }, // missed nights: read at 7, now 20
  { post_id: 'd14-done', created_at: daysAgo(20), last_collected_at: daysAgo(5) },  // read at 15: done until 28
  { post_id: 'd28', created_at: daysAgo(28), last_collected_at: daysAgo(14) },      // read at 14, now 28
  { post_id: 'd60-never', created_at: daysAgo(61), last_collected_at: null },       // held, never read
  { post_id: 'd85', created_at: daysAgo(86), last_collected_at: daysAgo(26) },      // read at 60, now 86
  { post_id: 'past', created_at: daysAgo(90), last_collected_at: daysAgo(30) },     // beyond the ceiling
], NOW);
eq('due: each post at the checkpoint it has reached, only if not read since',
  dueC, [{ post_id: 'd14', checkpoint: 14 }, { post_id: 'd14-late', checkpoint: 14 }, { post_id: 'd28', checkpoint: 28 },
    { post_id: 'd60-never', checkpoint: 60 }, { post_id: 'd85', checkpoint: 85 }]);
// A post read on schedule every night gets exactly 12 reads over its life.
{
  const created = new Date('2026-06-01T12:00:00Z');
  let last = null; let reads = 0;
  for (let day = 0; day <= 120; day++) {
    const run = new Date(created.getTime() + day * D + 60_000);
    const age = sched.ageDays(created, run);
    const daily = age < sched.DAILY_DAYS;
    const cp = !daily && sched.dueForCheckpoint([{ post_id: 'p', created_at: created.toISOString(), last_collected_at: last }], run).length === 1;
    if (daily || cp) { reads++; last = run.toISOString(); }
  }
  eq('simulated nightly runs: one post is read exactly 12 times', reads, 12);
}
// Missing nights costs reads, never a checkpoint's worth of data.
{
  const created = new Date('2026-06-01T12:00:00Z');
  let last = null; const readAt = [];
  for (let day = 0; day <= 120; day++) {
    if (day % 3 !== 0) continue; // runs only every third night
    const run = new Date(created.getTime() + day * D + 60_000);
    const age = sched.ageDays(created, run);
    const cp = age >= sched.DAILY_DAYS && sched.dueForCheckpoint([{ post_id: 'p', created_at: created.toISOString(), last_collected_at: last }], run).length === 1;
    if (age < sched.DAILY_DAYS || cp) { readAt.push(age); last = run.toISOString(); }
  }
  eq('runs every third night: every checkpoint still gets a read, late', readAt.filter((a) => a >= 14), [15, 30, 60, 87]);
}
ok('private window open at 29 days', sched.privateWindowOpen(daysAgo(29), NOW));
ok('private window closed at 30 days', !sched.privateWindowOpen(daysAgo(30), NOW));
eq('chunk splits ids at 100', sched.chunk(Array.from({ length: 250 }, (_, i) => i)).map((c) => c.length), [100, 100, 50]);

const bw = sched.backfillWindow(NOW, 100, 8);
eq('backfill ends exactly where the daily window starts (no hole)', [bw.start_time, bw.end_time], [daysAgo(100), daysAgo(8)]);
eq('backfill ends at the widened first-run window too', sched.backfillWindow(NOW, 100, 29).end_time, daysAgo(29));
eq('no backfill when it would not reach past the daily window', sched.backfillWindow(NOW, 8, 8), null);
eq('first run for an account reaches the observed ceiling, so checkpoints have posts', [sched.firstRunDays(0), sched.firstRunDays(12)], [89, 8]);

console.log('\nEnrolment guard (lib/xflow.js)\n');
{
  const { enrolmentConflict } = require('../lib/xflow');
  const uk = { label: 'CitizenGO UK', kind: 'organisation', country: 'GB' };
  const globalRow = { account_id: '1264712994', username: 'CitizenGO', label: 'CitizenGO', kind: 'organisation', is_active: true };
  eq('new account, unused label: allowed', enrolmentConflict({ accountId: '9', username: 'CitizenGO_UK', invite: uk, existing: null, holders: [] }), null);
  eq('UK invite opened while signed in as @CitizenGO: refused, Global not relabelled',
    enrolmentConflict({ accountId: '1264712994', username: 'CitizenGO', invite: uk, existing: globalRow, holders: [] }).code, 'ACCOUNT_ALREADY_CONNECTED');
  eq('same account, same label (renewal): allowed',
    enrolmentConflict({ accountId: '1264712994', username: 'CitizenGO', invite: { label: 'citizengo ', kind: 'organisation' }, existing: globalRow, holders: [globalRow] }), null);
  eq('label already held by another X account: refused',
    enrolmentConflict({ accountId: '77', username: 'someone_else', invite: uk, existing: null, holders: [{ account_id: '9', username: 'CitizenGO_UK', label: 'CitizenGO UK', is_active: true }] }).code, 'LABEL_ALREADY_CONNECTED');
  eq('same account as spokesperson under an organisation label: refused',
    enrolmentConflict({ accountId: '1264712994', username: 'CitizenGO', invite: { label: 'CitizenGO', kind: 'spokesperson' }, existing: globalRow, holders: [] }).code, 'ACCOUNT_ALREADY_CONNECTED');
  eq('a retired (inactive) row does not block re-use', enrolmentConflict({ accountId: '9', username: 'x', invite: uk, existing: { ...globalRow, is_active: false }, holders: [] }), null);
}

console.log('\nCost (the figures in the scoping brief)\n');
eq('owned read is $0.001, user read $0.010', sched.estimateCost({ postReads: 1000, userReads: 10 }), 1.1);
eq('outsider rate is $0.005', sched.estimateCost({ postReads: 1000, userReads: 0, owned: false }), 5);
// Agreed 30 Sep 2026: 18 accounts x 5 posts/day, 12 reads per post, 540 follower lookups.
eq('18 accounts x 5/day on 0-7/14/28/60/85 = $37.80/month', sched.projectMonthly({ accounts: 18, postsPerDay: 5 }), 37.8);
eq('same at the ordinary read rate = $167.40/month', sched.projectMonthly({ accounts: 18, postsPerDay: 5, owned: false }), 167.4);
eq('one account at 2.4/day (@CitizenGO today) = $1.16/month', sched.projectMonthly({ accounts: 1, postsPerDay: 2.4 }), 1.164);

// 30 Sep 2026: the console said $10.40 for a day our all-owned ledger priced at $2.39.
eq('mixed projection: owner at $0.001, everyone else at $0.005',
  sched.projectMonthlyMixed([{ owned: true, postsPerDay: 2 }, { owned: false, postsPerDay: 2 }]), 1.02 + 3.9);

console.log('\nLink attribution\n');
const ent = { urls: [
  { url: 'https://t.co/abc', expanded_url: 'https://cgo.ac/scTOT5M4', display_url: 'cgo.ac/scTOT5M4' },
  { url: 'https://t.co/def', expanded_url: 'https://www.citizengo.org/en-gb/fm/1?utm_source=tw&utm_campaign=EN_GB-2026-Test-CJO', display_url: 'citizengo.org/…' },
  { url: 'https://t.co/ghi', expanded_url: 'https://www.bbc.co.uk/news/1', display_url: 'bbc.co.uk/…' },
  { url: 'https://t.co/jkl', expanded_url: 'not a url' },
  { url: 'https://t.co/mno', expanded_url: 'https://notcitizengo.org/x' },
] };
const ex = sched.extractUrls(ent);
eq('all parseable urls kept', ex.urls.length, 5);
eq('ours: cgo.ac short link and citizengo.org, not bbc or a look-alike domain',
  ex.citizengo_urls, ['https://cgo.ac/scTOT5M4', 'https://www.citizengo.org/en-gb/fm/1?utm_source=tw&utm_campaign=EN_GB-2026-Test-CJO']);
eq('utmOf reads campaign and source', sched.utmOf(ex.citizengo_urls[1]), { utm_source: 'tw', utm_campaign: 'EN_GB-2026-Test-CJO' });
eq('utmOf on a short link is null', sched.utmOf('https://cgo.ac/x'), null);
eq('no entities -> empty, not null', sched.extractUrls(undefined), { urls: [], citizengo_urls: [] });
ok('hazteoir subdomain is ours', sched.isOurHost('www.hazteoir.org'));
ok('trailing dot host is normalised', sched.isOurHost('citizengo.org.'));

// ---------------------------------------------------------------------------
console.log('\nSealed box (lib/xauth.js)\n');
const kp = xauth.generateKeyPair();
const secret = 'rt_' + crypto.randomBytes(24).toString('hex');
const blob = xauth.seal(kp.publicKey, secret);
eq('open(seal(x)) = x', xauth.open(kp.privateKey, blob), secret);
ok('two seals of the same secret differ (fresh ephemeral key + iv)', xauth.seal(kp.publicKey, secret) !== blob);
ok('blob is base64 (matches the CHECK constraint)', /^[A-Za-z0-9+/=]+$/.test(blob));
eq('public key derives from private', xauth.publicKeyOf(kp.privateKey), kp.publicKey);
const other = xauth.generateKeyPair();
throws('wrong private key cannot open', () => xauth.open(other.privateKey, blob));
const tampered = Buffer.from(blob, 'base64'); tampered[tampered.length - 1] ^= 1;
throws('tampered ciphertext is rejected', () => xauth.open(kp.privateKey, tampered.toString('base64')));
throws('short blob is rejected', () => xauth.open(kp.privateKey, 'AAAA'), /too short/);

console.log('\nPKCE and invites\n');
const pk = xauth.pkcePair();
eq('challenge is base64url(sha256(verifier))', pk.challenge, crypto.createHash('sha256').update(pk.verifier).digest('base64url'));
ok('verifier length within 43..128', pk.verifier.length >= 43 && pk.verifier.length <= 128);
const au = new URL(xauth.authorizeUrl({ clientId: 'cid', redirectUri: 'https://h/api/x/callback', state: 's1', challenge: pk.challenge }));
eq('authorize url: S256, read-only scopes', [au.searchParams.get('code_challenge_method'), au.searchParams.get('scope')], ['S256', 'tweet.read users.read offline.access']);
ok('authorize url points at x.com', au.hostname === 'x.com');
const inv = xauth.signInvite('invite-secret-0123456789abcdef', { label: 'CitizenGO UK', kind: 'organisation', country: 'GB' });
const got = xauth.verifyInvite('invite-secret-0123456789abcdef', inv);
eq('invite round-trips label/kind/country', [got.label, got.kind, got.country], ['CitizenGO UK', 'organisation', 'GB']);
eq('wrong secret -> null', xauth.verifyInvite('other-secret-0123456789abcdef', inv), null);
eq('expired invite -> null', xauth.verifyInvite('s', xauth.signInvite('s', { label: 'x', days: -1 })), null);
const [body] = inv.split('.');
const forgedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), kind: 'organisation', label: 'HazteOir' })).toString('base64url');
eq('altered payload -> null', xauth.verifyInvite('invite-secret-0123456789abcdef', `${forgedBody}.${inv.split('.')[1]}`), null);
eq('unknown kind -> null', xauth.verifyInvite('s', xauth.signInvite('s', { label: 'x', kind: 'admin' })), null);

// ---------------------------------------------------------------------------
// Mock X. Stands in for api.x.com: one 429 on the first timeline call, partial
// errors on the second, a refresh endpoint that rotates or refuses.
// ---------------------------------------------------------------------------
const TWEETS = [
  { id: '1001', text: 'Sign now https://t.co/abc', created_at: daysAgo(2), lang: 'en', conversation_id: '1001',
    entities: { urls: [{ url: 'https://t.co/abc', expanded_url: 'https://cgo.ac/scTOT5M4', display_url: 'cgo.ac/scTOT5M4' }] },
    attachments: { media_keys: ['13_1'] },
    public_metrics: { impression_count: 5000, like_count: 40, retweet_count: 12, reply_count: 3, quote_count: 1, bookmark_count: 7 },
    non_public_metrics: { impression_count: 5000, url_link_clicks: 88, user_profile_clicks: 9 },
    organic_metrics: { impression_count: 4800, like_count: 39, retweet_count: 12, reply_count: 3, url_link_clicks: 85, user_profile_clicks: 9 },
    promoted_metrics: { impression_count: 200, like_count: 1, retweet_count: 0, reply_count: 0, url_link_clicks: 3 },
    source: 'X Web App' },
  { id: '1002', text: 'RT something', created_at: daysAgo(1), lang: 'en', referenced_tweets: [{ type: 'retweeted', id: '999' }],
    public_metrics: { impression_count: 0, like_count: 0, retweet_count: 5, reply_count: 0, quote_count: 0, bookmark_count: 0 } },
];
const INCLUDES = { media: [{ media_key: '13_1', type: 'video', public_metrics: { view_count: 1234 }, non_public_metrics: { playback_100_count: 200 } }] };
let timelineCalls = 0;
let flaky = 0;
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const rate = (rem) => ({ 'x-rate-limit-limit': '900', 'x-rate-limit-remaining': String(rem), 'x-rate-limit-reset': String(Math.ceil(Date.now() / 1000) + 1) });
  const json = (code, obj, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
  if (!/^Bearer /.test(req.headers.authorization || '') && !u.pathname.startsWith('/2/oauth2')) return json(401, { title: 'Unauthorized' });
  if (u.pathname === '/2/users/me') return json(200, { data: { id: '42', username: 'citizengo_uk', name: 'CitizenGO UK', public_metrics: { followers_count: 1000, following_count: 10, tweet_count: 500, listed_count: 3 } } }, rate(74));
  if (u.pathname === '/2/users/42/tweets') {
    timelineCalls++;
    if (timelineCalls === 1) return json(429, { title: 'Too Many Requests' }, rate(0));
    return json(200, { data: TWEETS, includes: INCLUDES, errors: [{ resource_id: '1002', title: 'Field Authorization Error', detail: 'non_public_metrics not available for retweets' }], meta: { result_count: 2 } }, rate(898));
  }
  if (u.pathname === '/2/tweets') return json(200, { data: [TWEETS[0]], includes: INCLUDES }, rate(299));
  if (u.pathname === '/2/users/503once/tweets') { flaky++; return flaky === 1 ? json(503, { title: 'Service Unavailable' }) : json(200, { data: [], meta: { result_count: 0 } }); }
  if (u.pathname === '/2/users/503always/tweets') return json(503, { title: 'Service Unavailable' });
  if (u.pathname === '/2/oauth2/token' && req.method === 'POST') {
    let bodyStr = ''; req.on('data', (c) => bodyStr += c); req.on('end', () => {
      const p = new URLSearchParams(bodyStr);
      if (p.get('grant_type') === 'refresh_token' && p.get('refresh_token') === 'dead') return json(400, { error: 'invalid_grant', error_description: 'Value passed for the token was invalid.' });
      if (p.get('grant_type') === 'refresh_token') return json(200, { token_type: 'bearer', expires_in: 7200, access_token: 'at_new', refresh_token: 'rt_' + p.get('refresh_token'), scope: 'tweet.read users.read offline.access' });
      if (p.get('grant_type') === 'authorization_code' && p.get('code_verifier')) return json(200, { token_type: 'bearer', expires_in: 7200, access_token: 'at_1', refresh_token: 'rt_1', scope: 'tweet.read users.read offline.access' });
      return json(400, { error: 'invalid_request' });
    });
    return undefined;
  }
  return json(404, { title: 'Not Found' });
});

mock.listen(0, '127.0.0.1', async () => {
  const host = `http://127.0.0.1:${mock.address().port}`;
  try {
    console.log('\nAPI client (lib/xapi.js) against a mock\n');
    const client = xapi.makeClient({ token: 'user-ctx-token', host });
    const me = await client.me();
    ok('users/me ok', me.ok && me.body.data.username === 'citizengo_uk');
    eq('user lookup billed as 1 user read, 0 post reads', [client.tally.userReads, client.tally.postReads], [1, 0]);
    eq('rate headers parsed', [me.rate.limit, me.rate.remaining], [900, 74]);
    const t0 = Date.now();
    const tl = await client.userPosts('42', { start_time: daysAgo(7), privateWindow: true });
    ok('429 once -> waited for reset and succeeded', tl.ok && client.tally.waits === 1 && Date.now() - t0 >= 900, `ok=${tl.ok} waits=${client.tally.waits}`);
    eq('two posts billed as 2 post reads (429 not billed)', client.tally.postReads, 2);
    eq('partial errors surfaced', tl.errors.length, 1);
    ok('request asked for the private groups', /non_public_metrics/.test(tl.request) && /organic_metrics/.test(tl.request));
    const pub = await client.userPosts('42', { start_time: daysAgo(60), end_time: daysAgo(30), privateWindow: false });
    ok('public-only request omits the private groups', pub.ok && !/non_public_metrics/.test(pub.request));
    const byIds = await client.postsByIds(['1001'], { privateWindow: true });
    eq('by-id read billed', [byIds.ok, client.tally.postReads], [true, 5]);
    eq('calls tallied (incl. the 429)', client.tally.calls, 5);
    ok('media expansion is attachments.media_keys (media_ids returns no media)', /expansions=attachments\.media_keys/.test(tl.request) && !/media_ids/.test(tl.request));
    const noRt = await client.userPosts('42', { start_time: daysAgo(7), excludeRetweets: true });
    ok('excludeRetweets sends exclude=retweets', /exclude=retweets/.test(noRt.request));
    ok('retweets are included when not excluded', !/exclude=/.test(tl.request));
    ok('redact strips bearer tokens', !/user-ctx-token/.test(xapi.redact('Authorization: Bearer user-ctx-token')));
    eq('countResources counts data + includes.tweets, users separately', xapi.countResources({ data: [1, 2], includes: { tweets: [1], users: [1, 1] } }), { posts: 3, users: 2 });

    console.log('\nToken refresh and exchange against the mock\n');
    if (String(process.env.GITHUB_ACTIONS) === 'true') {
      console.log('  skip  X_TOKEN_URL override is refused in GitHub Actions by design (lib/env-guard.js)');
    } else {
      process.env.X_TOKEN_URL = host + '/2/oauth2/token';
      const r = await xauth.refresh({ clientId: 'cid', refreshToken: 'rt_old' });
      eq('refresh rotates the refresh token', r.refresh_token, 'rt_rt_old');
      let code = null;
      try { await xauth.refresh({ clientId: 'cid', refreshToken: 'dead' }); } catch (e) { code = e.code; }
      eq('invalid_grant surfaces as REAUTHORIZE, not a retry', code, 'REAUTHORIZE');
      const x = await xauth.exchangeCode({ clientId: 'cid', redirectUri: 'https://h/cb', code: 'c', verifier: 'v' });
      eq('code exchange returns tokens', [x.access_token, x.refresh_token], ['at_1', 'rt_1']);
      delete process.env.X_TOKEN_URL;
    }

    console.log('\nX server errors (a 503 hit the second live probe)\n');
    const c2 = xapi.makeClient({ token: 't', host });
    const once = await c2.userPosts('503once', {}, { _backoffMs: 10 });
    eq('one 503 is retried and succeeds', [once.ok, c2.tally.retries], [true, 1]);
    const always = await c2.userPosts('503always', {}, { _backoffMs: 10 });
    eq('a persistent 503 gives up after two retries and returns the failure', [always.ok, always.status, c2.tally.retries], [false, 503, 3]);
    const four = await c2.get('/nope', {}, { _backoffMs: 10 });
    eq('a 4xx is never retried', [four.status, c2.tally.retries], [404, 3]);

    console.log('\nExpected refusals (seen on the first live probe, 30 Sep 2026)\n');
    const promo = { title: 'Disallowed Resource', detail: "The 'promoted_metrics.impression_count' field cannot be queried for this resource.", resource_id: '1001' };
    const rtRefusal = { title: 'Disallowed Resource', detail: "The 'non_public_metrics.url_link_clicks' field cannot be queried for Retweets.", resource_id: '1002' };
    const real = { title: 'Field Authorization Error', detail: "Sorry, you are not authorized to see the 'non_public_metrics' field.", resource_id: '1001' };
    ok('promoted_metrics on an unboosted post is expected', xapi.expectedRefusal(promo));
    ok('private metrics on a retweet are expected', xapi.expectedRefusal(rtRefusal));
    ok('the age refusal is expected (public metrics still arrive)', xapi.expectedRefusal({ title: 'Disallowed Resource', detail: "The 'organic_metrics.impression_count' field cannot be queried for Tweets older than 30 days." }));
    ok('a field X could not resolve on the other side of a reply is expected', xapi.expectedRefusal({ title: 'Not Found Error', detail: "The 'in_reply_to_user_id' field could not be fully resolved for this request and may be missing or incomplete." }));
    ok('anything else is NOT expected', !xapi.expectedRefusal(real) && !xapi.expectedRefusal({ title: 'Field Authorization Error', detail: 'x' }));
    const filtered = toRows(TWEETS[0], { account: { account_id: '42' }, username: 'u', includes: INCLUDES, errors: [promo, real], privateWindow: true, now: NOW });
    eq('expected refusals are dropped, unexpected ones kept', filtered.metric.errors.map((e) => e.detail), [real.detail]);

    console.log('\nRow mapping (collector/x.js toRows)\n');
    const rows = toRows(TWEETS[0], { account: { account_id: '42' }, username: 'citizengo_uk', includes: INCLUDES, errors: tl.errors, privateWindow: true, now: NOW });
    eq('permalink built from handle', rows.post.permalink_url, 'https://x.com/citizengo_uk/status/1001');
    eq('our link extracted', rows.post.citizengo_urls, ['https://cgo.ac/scTOT5M4']);
    eq('original post has no referenced type', rows.post.referenced_type, null);
    eq('video views and playback from includes.media', [rows.metric.video_views, rows.metric.video_playback_100], [1234, 200]);
    eq('public metrics mapped', [rows.metric.impressions, rows.metric.likes, rows.metric.reposts, rows.metric.bookmarks], [5000, 40, 12, 7]);
    eq('private metrics mapped', [rows.metric.url_link_clicks, rows.metric.organic_impressions, rows.metric.promoted_impressions], [88, 4800, 200]);
    eq('age and window recorded', [rows.metric.post_age_days, rows.metric.private_window_open], [2, true]);
    const asked = toRows({ ...TWEETS[0], non_public_metrics: undefined, organic_metrics: undefined }, { account: { account_id: '42' }, username: 'u', includes: INCLUDES, errors: [], privateWindow: true, now: NOW });
    eq('private_window_open means private metrics CAME BACK, not that they were asked for', asked.metric.private_window_open, false);
    eq('errors for OTHER posts are not attached to this one', rows.metric.errors, null);
    const rt = toRows(TWEETS[1], { account: { account_id: '42' }, username: 'citizengo_uk', includes: INCLUDES, errors: tl.errors, privateWindow: true, now: NOW });
    eq('retweet keeps its reference', [rt.post.referenced_type, rt.post.referenced_post_id], ['retweeted', '999']);
    eq('the retweet\'s partial error is attached to it', rt.metric.errors && rt.metric.errors.length, 1);
    eq('missing private group -> null, never zero', rt.metric.url_link_clicks, null);
    eq('no entities -> citizengo_urls is [] (not null) so the view can count it', rt.post.citizengo_urls, []);

    console.log('\nSink idempotency for x_* tables\n');
    const dir = path.join(__dirname, '..', 'data', 'test-x-sink');
    fs.rmSync(dir, { recursive: true, force: true });
    const sink = jsonSink({ dir });
    await sink.upsert('x_posts', [rows.post, rt.post]);
    await sink.upsert('x_posts', [rows.post]);
    await sink.upsert('x_post_metrics', [rows.metric, rows.metric]);
    await sink.upsert('x_account_metrics', [{ account_id: '42', metric_date: '2026-09-08', followers_count: 1 }, { account_id: '42', metric_date: '2026-09-08', followers_count: 2 }]);
    await sink.upsert('x_collection_runs', [{ run_id: 'a' }, { run_id: 'a' }]);
    const written = await sink.flush();
    eq('posts keyed on post_id', written.x_posts, 2);
    eq('metrics keyed on post_id|collected_date', written.x_post_metrics, 1);
    eq('account metrics keyed on account_id|metric_date (last write wins)', written.x_account_metrics, 1);
    eq('collection runs append-only', written.x_collection_runs, 2);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    console.log(`  FAIL  suite crashed: ${e.stack}`); failed++;
  } finally {
    mock.close();
    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed ? 1 : 0);
  }
});
