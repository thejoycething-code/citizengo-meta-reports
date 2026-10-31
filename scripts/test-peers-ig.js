#!/usr/bin/env node
'use strict';
// Pins collector/peers-ig.js against a fake Graph API: which account it calls
// as, how errors are classified, what reaches each table, and that a dry run
// writes nothing. Usage: node scripts/test-peers-ig.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadList, classify, run, findVia, args, gate, LISTS } = require('../collector/peers-ig');

let passed = 0, failed = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failed++; }
}

const accounts = { ok: true, body: { data: [
  { instagram_business_account: { id: '1', username: 'citizengo' } },
  {},
  { instagram_business_account: { id: '2', username: 'citizengo_uk' } },
] } };

function fakeGet(calls) {
  return async (pathname, params) => {
    calls.push([pathname, params.fields]);
    if (pathname === '/me/accounts') return accounts;
    const handle = params.fields.match(/username\(([^)]+)\)/)[1];
    if (handle === 'personal') return { ok: false, error: { code: 110, error_subcode: 2207013, message: 'The user must be a business or creator account' } };
    if (handle === 'slow') return { ok: false, error: { code: 4, message: 'Application request limit reached' } };
    return { ok: true, body: { business_discovery: {
      id: '9', username: handle, name: 'Peer', followers_count: 1000, media_count: 2,
      media: { data: [
        { id: 'm1', caption: 'hi', like_count: 10, comments_count: 2, media_type: 'IMAGE', media_product_type: 'FEED', permalink: 'https://instagram.com/p/1', timestamp: '2026-10-01T10:00:00+0000' },
        { id: 'm2', comments_count: 5, media_type: 'VIDEO', media_product_type: 'REELS', permalink: 'https://instagram.com/p/2', timestamp: '2026-10-02T10:00:00+0000' },
      ] },
    } } };
  };
}

(async () => {
  const tmp = path.join(os.tmpdir(), `peers-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify([
    { handle: '@Peer_One', name: 'Peer One', country: 'UK', group: 'pro-life' },
    { handle: 'peer_one' }, { handle: 'citizengo_uk' }, { handle: 'personal' }, { handle: '' },
  ]));
  const list = loadList(tmp);
  fs.unlinkSync(tmp);
  eq('list: normalised, de-duplicated, own accounts dropped', list.map((p) => p.username), ['peer_one', 'personal']);
  eq('list: keeps labels', list[0], { username: 'peer_one', label: 'Peer One', country: 'UK', topic: 'pro-life' });

  eq('classify: not business', classify({ code: 110, error_subcode: 2207013, message: 'x' }), 'not_business');
  eq('classify: rate limit', classify({ code: 4, message: 'x' }), 'rate_limited');
  eq('classify: unknown', classify({ code: 100, message: 'x' }), 'error');

  delete process.env.PEER_IG_VIA;
  eq('via: prefers citizengo_uk', (await findVia(fakeGet([]))).username, 'citizengo_uk');
  eq('via: honours PEER_IG_VIA', (await findVia(fakeGet([]), '@CitizenGO')).id, '1');

  const writes = [];
  const upsert = async (table, rows, key) => { writes.push({ table, rows, key }); };
  const calls = [];
  const counts = await run({ get: fakeGet(calls), upsert, list: [...list, { username: 'slow' }, { username: 'never' }],
    opts: { dryRun: false, posts: 25 }, now: new Date('2026-10-07T09:00:00Z'), log: () => {} });
  eq('run: counts', [counts.ok, counts.not_business, counts.rate_limited, counts.posts], [1, 1, 1, 2]);
  eq('run: stops after a rate limit', calls.some(([, f]) => f && f.includes('username(never)')), false);
  eq('run: calls as our account with the post limit', calls[1], ['/2', calls[1][1]]);
  eq('run: media limit passed', /media\.limit\(25\)/.test(calls[1][1]), true);
  const media = writes.find((w) => w.table === 'peer_ig_media');
  eq('run: media rows carry no counts', Object.keys(media.rows[0]).includes('like_count'), false);
  const metrics = writes.find((w) => w.table === 'peer_ig_media_metrics');
  eq('run: metrics keyed by day', [metrics.key, metrics.rows[1]], ['media_id,collected_date',
    { media_id: 'm2', collected_date: '2026-10-07', like_count: null, comments_count: 5, followers_count: 1000 }]);
  const failedAcct = writes.find((w) => w.table === 'peer_ig_accounts' && w.rows[0].username === 'personal');
  eq('run: failed account recorded with status', failedAcct.rows[0].last_status, 'not_business');

  const dryWrites = [];
  await run({ get: fakeGet([]), upsert: async () => dryWrites.push(1), list, opts: { dryRun: true, posts: 50 }, log: () => {} });
  eq('dry run writes nothing', dryWrites.length, 0);

  // Opponents list: a dry run, with no posts named, until it is switched on.
  eq('args: --list opponents', args(['--list', 'opponents']).list, 'opponents');
  eq('args: unknown list refused', (() => { try { args(['--list', 'x']); return 'accepted'; } catch (e) { return 'refused'; } })(), 'refused');
  eq('gate: allies untouched', gate({ list: 'allies', dryRun: false }, {}).dryRun, false);
  eq('gate: opponents forced to dry run when not enabled', [gate({ list: 'opponents', dryRun: false }, {}).dryRun, gate({ list: 'opponents', dryRun: false }, {}).quiet], [true, true]);
  eq('gate: opponents write once enabled', gate({ list: 'opponents', dryRun: false }, { OPPONENTS_IG_ENABLED: 'true' }).dryRun, false);
  const opp = loadList(LISTS.opponents);
  eq('opponents list loads, no overlap with allies', [opp.length > 0, opp.filter((o) => loadList().some((a) => a.username === o.username)).length], [true, 0]);
  const quietLog = [];
  await run({ get: fakeGet([]), upsert: async () => {}, list: [list[0]], opts: { dryRun: true, quiet: true, posts: 50 }, log: (l) => quietLog.push(l) });
  eq('quiet run names no posts', quietLog.some((l) => l.includes('http')), false);

  // ally_watch: the connector tool over peer_ig_latest.
  const { allyWatch, render } = require('../mcp/peer-tools');
  const accts = [{ username: 'spucprolife', label: 'SPUC', last_status: 'ok', last_checked_at: '2026-10-29T06:11:00Z' },
    { username: 'gone', label: 'Gone', last_status: 'not_found', last_checked_at: '2026-10-29T06:11:00Z' }];
  const post = { username: 'spucprolife', label: 'SPUC', country: 'UK', media_type: 'VIDEO', media_product_type: 'REELS',
    caption: 'Assisted suicide | bill', permalink: 'https://www.instagram.com/reel/x/', timestamp: '2026-10-28T10:00:00Z',
    like_count: 900, comments_count: 100, settled: false, vs_median: 6.25 };
  const asked = [];
  const fakeStore = { peerAccounts: async () => accts, peerPosts: async (q) => { asked.push(q); return [post]; } };
  const out = await allyWatch(fakeStore, { country: 'uk', query: 'assisted', min_multiple: 5, sort: 'recent' });
  eq('ally_watch: filters reach the store', [asked[0].country, asked[0].q, asked[0].min, asked[0].order], ['uk', 'assisted', 5, 'timestamp']);
  eq('ally_watch: counts only accounts read', out.text.includes('1 ally accounts read, last on 2026-10-29'), true);
  eq('ally_watch: young post marked still rising', out.text.includes('6.3× ↑'), true);
  eq('ally_watch: pipe in caption escaped', out.text.includes('Assisted suicide \\| bill'), true);
  eq('ally_watch: no paging note under the limit', out.text.includes('offset'), false);
  eq('ally_watch: paging note at the limit', render({ rows: [post], accounts: accts, label: 'x', off: 0, limit: 1 }).includes('offset 1'), true);
  const none = await allyWatch({ peerAccounts: async () => [], peerPosts: async () => [] }, {});
  eq('ally_watch: says when nothing is collected', none.text.startsWith('Ally watch has not collected'), true);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
