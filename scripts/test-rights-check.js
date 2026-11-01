#!/usr/bin/env node
'use strict';
// The nightly rights re-check (collector/rights-check.js, lib/rightscheck.js)
// against an in-memory engine and a fake Facebook: a token Facebook refuses
// loses its right, a blip keeps it, a right with no token goes, maintainer
// rights are never touched, and everything refused at once removes nothing.
// Usage: node scripts/test-rights-check.js

let passed = 0, failed = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${name}`); passed++; } else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failed++; }
}
const xauth = require('../lib/xauth');
const R = require('../lib/rightscheck');
const { run } = require('../collector/rights-check');

const keys = xauth.generateKeyPair();
const teams = [{ id: 'uk', accounts: [{ key: 'uk-fb', platform: 'facebook', page_id: '105' }, { key: 'uk-ig', platform: 'instagram', ig_id: '178' }, { key: 'sc-fb', platform: 'facebook', page_id: '200' }] }];
const tok = (who, account_key, token, page_id = '105', ig_id = '178') => ({ who, account_key, page_id, ig_id, sealed: xauth.seal(keys.publicKey, token) });

function memStore(tokens, rights) {
  const db = { tokens, rights, touched: [] };
  const same = (a, b) => a.who === b.who && a.account_key === b.account_key;
  return {
    db,
    async engineTeams() { return teams; },
    async engineConnectedTokens() { return db.tokens.map((t) => ({ ...t })); },
    async engineMetaRights() { return db.rights.filter((r) => r.source === 'meta').map((r) => ({ ...r })); },
    async engineDropRight(r) { db.rights = db.rights.filter((x) => !(same(x, r) && x.source === 'meta')); db.tokens = db.tokens.filter((x) => !same(x, r)); },
    async engineTouchRight(r, at) { db.touched.push(`${r.who}|${r.account_key}`); },
  };
}

// Fake Facebook: answers by token.
const answers = {
  GOOD: { me: { id: '105' }, 178: { id: '178' } },
  GONE: { error: { code: 190, message: 'Error validating access token' } },
  BUSY: { error: { code: 4, message: 'Application request limit reached' } },
  OTHERPAGE: { me: { id: '999' } },
};
const fakeFetch = async (url) => {
  const u = new URL(url);
  const a = answers[u.searchParams.get('access_token')];
  const node = u.pathname.split('/').pop();
  const body = a.error ? { error: a.error } : (a[node] || { error: { code: 100, error_subcode: 33, message: 'Unsupported get request' } });
  return { json: async () => body };
};

(async () => {
  eq('verdict: invalid token and lost permission are lost; rate limits and outages are unsure',
    [R.verdict({ code: 190 }), R.verdict({ code: 200 }), R.verdict({ code: 10 }), R.verdict({ code: 100, error_subcode: 33 }), R.verdict({ code: 4 }), R.verdict({ code: 2 }), R.verdict(null)],
    ['lost', 'lost', 'lost', 'lost', 'unsure', 'unsure', 'ok']);

  const mk = () => memStore(
    [tok('chris', 'uk-fb', 'GOOD'), tok('chris', 'uk-ig', 'GOOD'), tok('greg', 'uk-fb', 'GONE'), tok('tamara', 'uk-fb', 'BUSY'), tok('sam', 'sc-fb', 'OTHERPAGE', '200')],
    [
      { who: 'chris', account_key: 'uk-fb', source: 'meta' }, { who: 'chris', account_key: 'uk-ig', source: 'meta' },
      { who: 'greg', account_key: 'uk-fb', source: 'meta' }, { who: 'tamara', account_key: 'uk-fb', source: 'meta' },
      { who: 'sam', account_key: 'sc-fb', source: 'meta' }, { who: 'old', account_key: 'uk-ig', source: 'meta' },
      { who: 'chris', account_key: 'sc-fb', source: 'maintainer' },
    ]);

  const logs = [];
  const dry = mk();
  const t1 = await run({ store: dry, privateKey: keys.privateKey, live: false, fetchImpl: fakeFetch, log: (l) => logs.push(l) });
  eq('dry run: counts, and nothing is changed', [t1, dry.db.rights.length, dry.db.tokens.length, dry.db.touched.length], [{ ok: 2, lost: 2, unsure: 1, orphans: 1, held: false }, 7, 5, 0]);
  eq('the log names people and accounts, never a token', logs.some((l) => /GOOD|GONE|BUSY|OTHERPAGE|sealed/.test(l)), false);

  const live = mk();
  await run({ store: live, privateKey: keys.privateKey, live: true, fetchImpl: fakeFetch, log: () => {} });
  eq('live: greg (token refused), sam (token for another Page) and old (no token) lose their rights; chris keeps both, tamara (rate limit) is kept',
    live.db.rights.map((r) => `${r.who}|${r.account_key}|${r.source}`),
    ['chris|uk-fb|meta', 'chris|uk-ig|meta', 'tamara|uk-fb|meta', 'chris|sc-fb|maintainer']);
  eq('live: the lost people\'s tokens are removed too', live.db.tokens.map((t) => `${t.who}|${t.account_key}`), ['chris|uk-fb', 'chris|uk-ig', 'tamara|uk-fb']);
  eq('live: rights that passed are stamped as checked', live.db.touched, ['chris|uk-fb', 'chris|uk-ig']);

  const all = memStore([tok('a', 'uk-fb', 'GONE'), tok('b', 'uk-fb', 'GONE'), tok('c', 'uk-fb', 'GONE')], ['a', 'b', 'c'].map((who) => ({ who, account_key: 'uk-fb', source: 'meta' })));
  const t3 = await run({ store: all, privateKey: keys.privateKey, live: true, fetchImpl: fakeFetch, log: () => {} });
  eq('everything refused at once looks like the app, so nothing is removed', [t3.held, all.db.rights.length, all.db.tokens.length], [true, 3, 3]);

  const wrongKey = memStore([tok('chris', 'uk-fb', 'GOOD')], [{ who: 'chris', account_key: 'uk-fb', source: 'meta' }]);
  const t4 = await run({ store: wrongKey, privateKey: xauth.generateKeyPair().privateKey, live: true, fetchImpl: fakeFetch, log: () => {} });
  eq('a token this key cannot open is unsure, not lost', [t4.unsure, wrongKey.db.rights.length], [1, 1]);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
