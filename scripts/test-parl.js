#!/usr/bin/env node
'use strict';
// Listening › Parliament (lib/parl.js): the queries the monitor runs, the
// shape the desk gets, past vs coming up, the token sent only as a bearer
// header, and a clear answer when the link isn't set up.
// Usage: node scripts/test-parl.js
let passed = 0, failed = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${name}`); passed++; } else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failed++; }
}
const P = require('../lib/parl');
const now = Date.parse('2026-11-02T12:00:00Z');
eq('sql: triaged only, dates as text, quotes escaped', [/triage_score >= 2/.test(P.feedSql('westminster', { since: "2026-10-12'" })), /'2026-10-12'''/.test(P.feedSql('westminster', { since: "2026-10-12'" }))], [true, true]);
eq('areas: names from the monitor, unknown ones dropped', P.areasOf('[3, 5, 99]').map((a) => a.name), ['Gender medicine (children)', 'Sex-based rights']);
const W = [
  { id: 'w1', title: 'Health Bill committee day 7', url: 'https://whatson.parliament.uk/event/cal56812', kind: 'event', dated: '2026-11-25', areas: '[3, 5]', score: 2, why: 'Peers can still amend.' },
  { id: 'w2', title: 'WMS: Stillbirth burials', url: null, kind: 'statement', dated: '2026-10-14', areas: '[1]', score: 3, why: 'Dignity.' },
  { id: 'w3', title: 'Consultation', url: 'http://insecure', kind: 'consultation', dated: '2026-10-20', areas: '[7]', score: 2, deadline: '2026-11-14' },
];
const S = [{ id: 'sp-motion:1', title: 'Red Wednesday', kind: 'motion', dated: '2026-10-27', areas: '[8]', score: 2, why: 'FoRB.' }];
let seen = [];
const fetchImpl = async (url, o) => {
  seen.push({ url, auth: o.headers.Authorization, body: JSON.parse(o.body) });
  const sql = JSON.parse(o.body).params.arguments.sql;
  const rows = /from sp_items/.test(sql) ? S : W;
  return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ rows }) }] } }) };
};
(async () => {
  const f = await P.feed('uk', { now, url: 'https://parl.example/api/mcp', token: 'tok', fetchImpl });
  eq('feed: both UK parliaments, one query each, bearer token', [f.covered, seen.length, seen[0].auth, seen[0].body.params.name], [['Westminster', 'Scottish Parliament'], 2, 'Bearer tok', 'query_sql']);
  eq('feed: past newest first; the diary and deadlines are coming up', [f.items.map((i) => i.id), f.upcoming.map((i) => [i.id, i.when])], [['sp-motion:1', 'w3', 'w2'], [['w3', '2026-11-14'], ['w1', '2026-11-25']]]);
  eq('feed: only https links kept, kinds named', [f.items.find((i) => i.id === 'w3').url, f.items.find((i) => i.id === 'w2').kind], [null, 'Ministerial statement']);
  let code = null; try { await P.feed('uk', { now, url: '', token: '' }); } catch (e) { code = e.code; }
  eq('feed: not set up says so', code, 'PARL_NOT_CONFIGURED');
  const bad = await P.feed('uk', { now, url: 'https://x', token: 't', fetchImpl: async () => ({ ok: false, status: 401 }) });
  eq('feed: a refused parliament is reported, not thrown', [bad.items.length, bad.errors.length], [0, 2]);
  eq('feed: other teams not covered', (await P.feed('es', { now, url: 'https://x', token: 't', fetchImpl })).covered, []);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
