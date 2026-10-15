#!/usr/bin/env node
'use strict';
// Instagram accounts connected by their holders: invites, the authorise page,
// token exchange, insights parsing, the spokesperson filter, the registry and
// the tool. No network: Instagram and Supabase are faked.
//
//   npm run test:ig

const xauth = require('../lib/xauth');
const igauth = require('../lib/igauth');
const igflow = require('../lib/igflow');
const { describe, keep, parseInsights } = require('../collector/ig-connected');
const { rowsFor } = require('../collector/links');
const { igConnectedPosts } = require('../mcp/link-tools');

let pass = 0; let fail = 0;
const ok = (name, cond, why = '') => { if (cond) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${why ? ' — ' + why : ''}`); } };
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const SECRET = 'test-invite-secret-at-least-24-chars';
const fakeRes = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

function mockRes() {
  const r = { statusCode: 200, headers: {}, body: '' };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.end = (b) => { r.body = String(b || ''); };
  return r;
}

(async () => {
  console.log('\nInvites');
  const ig = xauth.verifyInvite(SECRET, xauth.signInvite(SECRET, { label: "Rocío D'Angelo", kind: 'spokesperson', platform: 'instagram' }));
  eq('an Instagram invite carries its platform', ig.platform, 'instagram');
  const x = xauth.verifyInvite(SECRET, xauth.signInvite(SECRET, { label: 'CitizenGO UK', country: 'GB' }));
  eq('an X invite carries no platform (as every invite before it)', x.platform, undefined);

  console.log('\nThe authorise page');
  const { generateKeyPair } = xauth;
  const kp = generateKeyPair();
  Object.assign(process.env, { IG_APP_ID: '123', IG_APP_SECRET: 's', IG_REDIRECT_URI: 'https://example.test/api/ig/callback', X_INVITE_SECRET: SECRET, X_TOKEN_PUBLIC_KEY: kp.publicKey });
  const authorize = require('../api/ig/authorize');
  const t1 = xauth.signInvite(SECRET, { label: "Rocío D'Angelo", kind: 'spokesperson', platform: 'instagram' });
  let res = mockRes();
  await authorize({ method: 'GET', url: `/api/ig/authorize?t=${t1}`, headers: {} }, res);
  ok('valid Instagram invite: consent page with a link to instagram.com', res.statusCode === 200 && /instagram\.com\/oauth\/authorize/.test(res.body), res.body.slice(0, 200));
  ok('spokesperson consent names the links-and-mentions rule', /link .* or mention CitizenGO/.test(res.body));
  ok('asks for read-only scopes only', /instagram_business_basic/.test(res.body) && !/content_publish|manage_comments|manage_messages/.test(res.body));
  ok('sets the flow cookie, scoped to /api/ig', /ig_oauth_flow=.*Path=\/api\/ig/.test(res.headers['set-cookie'] || ''));
  ok('explains how to switch a personal account to professional', /Switch to professional account/.test(res.body));
  res = mockRes();
  await authorize({ method: 'GET', url: `/api/ig/authorize?t=${xauth.signInvite(SECRET, { label: 'CitizenGO UK' })}`, headers: {} }, res);
  ok('an X invite is refused on the Instagram route', res.statusCode === 400 && /for X, not Instagram/.test(res.body));
  res = mockRes();
  await authorize({ method: 'GET', url: '/api/ig/authorize?t=forged.mac', headers: {} }, res);
  ok('a forged invite is refused', res.statusCode === 400);
  const missing = igflow.config.call(null);
  ok('configured when all five settings are present', missing.ok, missing.missing.join());

  console.log('\nToken exchange');
  const got = await igauth.exchangeCode({ appId: '1', appSecret: 's', redirectUri: 'r', code: 'abc#_', fetchImpl: async (u, o) => { ok('code has the "#_" suffix stripped', !String(o.body).includes('%23_')); return fakeRes(200, { data: [{ access_token: 'short', user_id: 42, permissions: 'instagram_business_basic,instagram_business_manage_insights' }] }); } });
  eq('wrapped {data:[...]} response read', [got.access_token, got.user_id, got.permissions.length], ['short', '42', 2]);
  const flat = await igauth.exchangeCode({ appId: '1', appSecret: 's', redirectUri: 'r', code: 'c', fetchImpl: async () => fakeRes(200, { access_token: 't2', user_id: '7', permissions: ['instagram_business_basic'] }) });
  eq('flat response read', [flat.access_token, flat.user_id], ['t2', '7']);
  let threw = ''; try { await igauth.exchangeCode({ appId: '1', appSecret: 's', redirectUri: 'r', code: 'c', fetchImpl: async () => fakeRes(400, { error_type: 'OAuthException', error_message: 'code expired' }) }); } catch (e) { threw = e.message; }
  ok('a refused code says why', /code expired/.test(threw), threw);
  const ll = await igauth.longLived({ appSecret: 's', shortToken: 'short', fetchImpl: async (u) => { ok('long-lived exchange uses ig_exchange_token', /grant_type=ig_exchange_token/.test(u)); return fakeRes(200, { access_token: 'long', expires_in: 5183944 }); } });
  eq('long-lived token and its lifetime', [ll.access_token, ll.expires_in], ['long', 5183944]);
  let rs = null; try { await igauth.refresh({ token: 'dead', fetchImpl: async () => fakeRes(400, { error: { message: 'Error validating access token', code: 190 } }) }); } catch (e) { rs = e; }
  ok('a dead token fails refresh with its status (the collector then asks for reconnection)', rs && rs.status === 400 && /validating/.test(rs.message));
  const sealed = xauth.seal(kp.publicKey, 'long');
  eq('the token round-trips through the X key pair seal', xauth.open(kp.privateKey, sealed), 'long');

  console.log('\nWhat is kept');
  const sp = { kind: 'spokesperson' };
  ok('kept: caption with a cgo.ac link', keep(sp, { caption: 'Firmá acá 👉 cgo.ac/scAbC123 #VidaSi' }));
  ok('kept: @-mention of a country account', keep(sp, { caption: 'Gracias @citizengo_argentina por la campaña' }));
  ok('kept: #CitizenGO hashtag', keep(sp, { caption: 'Hoy en la marcha #CitizenGO' }));
  ok('dropped: a personal post', !keep(sp, { caption: 'Domingo en familia ☀️' }));
  ok('dropped: no caption', !keep(sp, { caption: null }));
  ok('an organisation account keeps everything', keep({ kind: 'organisation' }, { caption: 'Domingo en familia' }));
  eq('links found in a caption', describe('Link: cgo.ac/scAbC123.').citizengo_urls, ['https://cgo.ac/scAbC123']);

  console.log('\nInsights');
  eq('values and total_value shapes both read', parseInsights({ data: [{ name: 'reach', values: [{ value: 120 }] }, { name: 'views', total_value: { value: 340 } }, { name: 'shares', values: [{ value: 0 }] }] }), { reach: 120, views: 340, shares: 0 });
  eq('nothing served: empty, never zeros', parseInsights({}), {});

  console.log('\nLink registry');
  const rows = rowsFor({ igConnected: [{ media_id: 'm1', ig_user_id: 'u9', caption: 'Firmá: cgo.ac/scAbC123', permalink: 'https://instagram.com/p/m1', timestamp: '2026-10-16T10:00:00Z' }],
    igAccounts: [{ ig_user_id: 'u9', username: 'rociodangelo', label: "Rocío D'Angelo", kind: 'spokesperson' }],
    shortMap: new Map([['scAbC123', 'https://citizengo.org/es-ar/fr/19369?utm_source=ig&utm_medium=social&utm_campaign=ES_AR-2026_10_09-Frena-RDA-AA_NA-GL-LF-19369-IG2']]) });
  eq('a connected account\'s post becomes a link row with its code', [rows[0].platform, rows[0].account_label, rows[0].account_kind, rows[0].owner, rows[0].series], ['instagram', '@rociodangelo', 'spokesperson', 'rda', 'ig2']);

  console.log('\nEnrolment');
  const inv = { label: "Rocío D'Angelo", kind: 'spokesperson' };
  eq('first connection: no conflict', igflow.enrolmentConflict({ igUserId: 'u9', username: 'rociodangelo', invite: inv, existing: null, holders: [] }), null);
  eq('reconnecting the same account: allowed', igflow.enrolmentConflict({ igUserId: 'u9', username: 'rociodangelo', invite: inv, existing: { label: "Rocío D'Angelo", kind: 'spokesperson' }, holders: [{ ig_user_id: 'u9' }] }), null);
  eq('signed into another connected account: refused', igflow.enrolmentConflict({ igUserId: 'u1', username: 'citizengo', invite: inv, existing: { label: 'CitizenGO Global', kind: 'organisation' }, holders: [] }).code, 'ACCOUNT_ALREADY_CONNECTED');
  eq('label already held by another account: refused', igflow.enrolmentConflict({ igUserId: 'u2', username: 'other', invite: inv, existing: null, holders: [{ ig_user_id: 'u9', username: 'rociodangelo' }] }).code, 'LABEL_ALREADY_CONNECTED');

  console.log('\nThe tool');
  const none = await igConnectedPosts({ igConnectedAccounts: async () => [], igConnectedPosts: async () => [] }, {});
  ok('no accounts yet: says how to add one', /partner/.test(none.text));
  const store = {
    igConnectedAccounts: async () => [{ ig_user_id: 'u9', username: 'rociodangelo', label: "Rocío D'Angelo", kind: 'spokesperson', followers_count: 5200, is_active: true, token: { expires_at: '2026-12-15T00:00:00Z', last_error: null } }],
    igConnectedPosts: async () => [{ username: 'rociodangelo', permalink: 'https://instagram.com/p/m1', timestamp: '2026-10-16T10:00:00Z', media_type: 'IMAGE', caption: 'Firmá', reach: 900, views: 1500, likes: 80, comments: 4, shares: 12, saved: 3 }],
  };
  const t = await igConnectedPosts(store, { days: 30 });
  ok('lists the account, its token state and its posts', /@rociodangelo/.test(t.text) && /token valid to 2026-12-15/.test(t.text) && /\| 900 \|/.test(t.text), t.text.slice(0, 300));
  ok('states the spokesperson rule', /link to or mention CitizenGO/.test(t.text));
  const tp = await igConnectedPosts({ ...store, igConnectedAccounts: async () => [{ ig_user_id: '178', username: 'rociodangelo', label: "Rocío D'Angelo", kind: 'spokesperson', access: 'partner', is_active: true, last_seen_at: '2026-10-17T06:20:00Z', token: null }] }, {});
  ok('a partner account reads as shared, not as needing reconnection', /partner access/.test(tp.text) && !/needs reconnecting/.test(tp.text), tp.text.slice(0, 200));

  console.log('\nPartner access (shared with our Business Manager)');
  const igpartner = require('../lib/igpartner');
  const { accessFor } = require('../collector/ig-connected');
  // A fake Graph: token "tokB" sees business 200's client assets, which hold @rociodangelo.
  const fakeApi = (token) => ({ async get(path, params) {
    if (path === '200/client_instagram_assets' && token === 'tokB') return { ok: true, status: 200, body: { data: [{ id: '178', username: 'RocioDAngelo' }] } };
    if (path.endsWith('/client_instagram_assets') || path.endsWith('_accounts')) return { ok: false, status: 400, body: { error: { message: 'Unknown path' } } };
    return { ok: false, status: 400, body: {} };
  } });
  const f = await igpartner.findShared({ tokens: ['tokA', 'tokB'], businessIds: ['100', '200'], username: '@rociodangelo', makeApi: fakeApi });
  eq('found by username (any case, @ ignored) with the token and business that see it', f.found && [f.found.igUserId, f.found.tokenIndex, f.found.businessId, f.found.edge], ['178', 1, '200', 'client_instagram_assets']);
  ok('every edge tried is logged, without tokens', f.tried.length > 1 && f.tried.every((t) => typeof t.token === 'number'));
  eq('not shared: nothing found', (await igpartner.findShared({ tokens: ['tokA'], businessIds: ['100'], username: 'nobody', makeApi: fakeApi })).found, null);
  const bizApi = (token) => ({ async get(path) {
    if (path === 'me') return { ok: true, status: 200, body: { id: 'su1', business: { id: '200', name: 'CitizenGO' } } };
    if (path === 'me/businesses') return { ok: false, status: 400, body: {} };
    return fakeApi(token).get(path);
  } });
  const fb = await igpartner.findShared({ tokens: ['tokB'], businessIds: null, username: 'rociodangelo', makeApi: bizApi });
  eq('with no business list, each token says which business it belongs to', fb.found && fb.found.businessId, '200');
  const g = (map) => ({ async get(path) { const v = map[path]; return v ? { ok: true, status: 200, body: v } : { ok: false, status: 400, body: { error: { message: 'Insufficient permission' } } }; } });
  const full = await igpartner.checkAccess(g({ '178': { username: 'rociodangelo' }, '178/media': { data: [{ id: 'm1' }] }, 'm1/insights': { data: [] } }), '178');
  ok('posts and insights readable: accepted', full.ok && full.insights === true);
  const noIns = await igpartner.checkAccess(g({ '178': { username: 'rociodangelo' }, '178/media': { data: [{ id: 'm1' }] } }), '178');
  ok('posts readable but insights refused: rejected, saying Insights access is missing', !noIns.ok && /needs Insights access/.test(noIns.why));
  const unread = await igpartner.checkAccess(g({}), '178');
  ok('account not readable: rejected', !unread.ok && /cannot read the account/.test(unread.why));
  const realApi = igpartner.api;
  igpartner.api = (tok) => ({ async get(path) { return tok === 'good' && path === '178' ? { ok: true, status: 200, body: { id: '178' } } : { ok: false, status: 400, body: {} }; } });
  const acc = await accessFor({ ig_user_id: '178', access: 'partner' }, { metaTokens: ['bad', 'good'], log: () => {} });
  eq('collector picks the META token that can read the partner account, addressed by id', [Boolean(acc.g), acc.self], [true, '178']);
  const lost = await accessFor({ ig_user_id: '178', access: 'partner' }, { metaTokens: ['bad'], log: () => {} });
  ok('share removed: a clear failure, not a crash', /partner share was removed/.test(lost.error || ''));
  igpartner.api = realApi;
  const noTok = await accessFor({ ig_user_id: 'u9', access: 'login' }, { tokenRow: null, log: () => {} });
  eq('login account without a token: says so', noTok.error, 'no live token');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
