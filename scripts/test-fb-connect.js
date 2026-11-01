#!/usr/bin/env node
'use strict';
// End-to-end check of Connect Facebook (api/fb/authorize.js -> callback.js)
// against a fake Facebook and a fake database: the person named by the link
// gets rights for the Pages they can post to, each Page token is stored only
// sealed (and opens with the collector's private key), and rights they no
// longer have are removed. No network, no credentials.
// Usage: node scripts/test-fb-connect.js

const xauth = require('../lib/xauth');
const flow = require('../lib/fbflow');

let passed = 0, failed = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${name}`); passed++; } else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failed++; }
}
function fakeRes() {
  const r = { statusCode: 200, headers: {}, body: '' };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.end = (b) => { r.body = String(b || ''); };
  return r;
}

const keys = xauth.generateKeyPair();
Object.assign(process.env, {
  FB_APP_ID: 'app1', FB_APP_SECRET: 'sec1', FB_REDIRECT_URI: 'https://meta.example/api/fb/callback', OAUTH_SIGNING_SECRET: 'sign1',
  X_TOKEN_PUBLIC_KEY: keys.publicKey, SUPABASE_URL: 'https://db.example', SUPABASE_SERVICE_KEY: 'svc',
});

const writes = [];
const TEAMS = [{ id: 'uk', name: 'United Kingdom', accounts: [{ key: 'uk-fb', name: 'Citizen GO UK', platform: 'facebook', page_id: '105' }, { key: 'uk-ig', platform: 'instagram', ig_id: '178' }, { key: 'sc-fb', platform: 'facebook', page_id: '120' }] }];
let PAGES = [
  { id: '105', name: 'Citizen GO UK', tasks: ['CREATE_CONTENT'], access_token: 'PAGE-TOKEN-UK', instagram_business_account: { id: '178', username: 'citizengo_uk' } },
  { id: '120', name: 'Citizen GO Scotland', tasks: ['ANALYZE'], access_token: 'PAGE-TOKEN-SC' },
];
global.fetch = async (u, opts = {}) => {
  const url = new URL(u);
  const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  if (url.host === 'graph.facebook.com') {
    if (url.pathname.endsWith('/oauth/access_token')) return ok({ access_token: url.searchParams.get('code') ? 'SHORT' : 'LONG' });
    if (url.pathname.endsWith('/me')) return ok({ id: '42', name: 'Chris Joyce' });
    if (url.pathname.endsWith('/me/accounts')) return ok({ data: PAGES });
  }
  if (url.host === 'db.example') {
    const path = url.pathname.replace('/rest/v1/', '') + url.search;
    if ((opts.method || 'GET') === 'GET' && path.startsWith('engine_teams')) return ok(TEAMS);
    writes.push({ method: opts.method, path: decodeURIComponent(path), body: opts.body ? JSON.parse(opts.body) : null });
    return ok([]);
  }
  throw new Error(`unexpected fetch ${u}`);
};

const authorize = require('../api/fb/authorize');
const callback = require('../api/fb/callback');

(async () => {
  const link = flow.signLink('sign1', 'chris');
  const r1 = fakeRes();
  await authorize({ method: 'GET', url: `/api/fb/authorize?t=${encodeURIComponent(link)}`, headers: {} }, r1);
  const cookie = String(r1.headers['set-cookie']).split(';')[0];
  const state = flow.readCookie('sign1', { headers: { cookie } }).state;
  eq('authorize: names the person and sends them to Facebook with the publishing scopes', [r1.statusCode, /Signed in to the desk as <strong>chris/.test(r1.body), /dialog\/oauth.*pages_manage_posts/.test(r1.body.replace(/&amp;/g, '&'))], [200, true, true]);

  const bad = fakeRes();
  await authorize({ method: 'GET', url: `/api/fb/authorize?t=${encodeURIComponent(link.replace(/^./, 'x'))}`, headers: {} }, bad);
  eq('authorize: an altered link is refused', bad.statusCode, 400);

  const wrong = fakeRes();
  await callback({ method: 'GET', url: `/api/fb/callback?state=nope&code=c1`, headers: { cookie } }, wrong);
  eq('callback: a state that does not match is refused, nothing written', [wrong.statusCode, writes.length], [400, 0]);

  const r2 = fakeRes();
  await callback({ method: 'GET', url: `/api/fb/callback?state=${state}&code=c1`, headers: { cookie } }, r2);
  const tok = writes.find((w) => w.path.startsWith('engine_page_tokens?on_conflict'));
  const rights = writes.find((w) => w.path.startsWith('engine_publish_rights?on_conflict'));
  eq('callback: rights for the UK Page and its Instagram, not Scotland (analyst only)', rights.body.map((r) => [r.who, r.account_key, r.source]), [['chris', 'uk-fb', 'meta'], ['chris', 'uk-ig', 'meta']]);
  eq('callback: tokens stored only sealed, and they open with the private key', [JSON.stringify(tok.body).includes('PAGE-TOKEN'), xauth.open(keys.privateKey, tok.body[0].sealed)], [false, 'PAGE-TOKEN-UK']);
  eq('callback: removes Facebook rights they no longer have, keeps maintainer ones', writes.filter((w) => w.method === 'DELETE').map((w) => w.path), [
    'engine_page_tokens?who=eq.chris&account_key=not.in.("uk-fb","uk-ig")',
    'engine_publish_rights?who=eq.chris&source=eq.meta&account_key=not.in.("uk-fb","uk-ig")',
  ]);
  eq('callback: tells them what they can now approve', [r2.statusCode, /Citizen GO UK \(United Kingdom\)/.test(r2.body)], [200, true]);

  writes.length = 0; PAGES = [];
  const again = fakeRes();
  const r3 = fakeRes();
  await authorize({ method: 'GET', url: `/api/fb/authorize?t=${encodeURIComponent(flow.signLink('sign1', 'chris'))}`, headers: {} }, again);
  const c2 = String(again.headers['set-cookie']).split(';')[0];
  await callback({ method: 'GET', url: `/api/fb/callback?state=${flow.readCookie('sign1', { headers: { cookie: c2 } }).state}&code=c2`, headers: { cookie: c2 } }, r3);
  eq('reconnecting with no Pages shared clears their Facebook rights', writes.map((w) => `${w.method} ${w.path}`), ['DELETE engine_page_tokens?who=eq.chris', 'DELETE engine_publish_rights?who=eq.chris&source=eq.meta']);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
