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
  // E4: big dates for the Calendar.
  const M = [
    { key: 'bill:4157:2026-11-25', date: '2026-11-25', kind: 'bill', title: 'Health Bill: Lords report stage', url: 'https://parliamentary-monitor.vercel.app/bills/health-bill.html' },
    { key: 's1', date: '2026-11-26', kind: 'sitting', title: 'Health Bill: Lords committee stage (day 8)', url: null },
    { key: 's2', date: '2026-11-27', kind: 'sitting', title: 'Prostitution (Scotland) Bill: Third reading', url: 'http://insecure' },
    { key: 'c1', date: '2026-12-01', kind: 'consultation', title: 'Children not in school guidance', url: 'https://www.gov.uk/c' },
    { key: 'h1', date: '2026-12-02', kind: 'hearing', title: 'A hearing', url: null },
  ];
  const big = P.shapeBigDates(M);
  eq('big dates: committee sittings and unknown kinds left out', big.map((k) => k.starts), ['2026-11-25', '2026-11-27', '2026-12-01']);
  eq('big dates: a Parliament marker with its kind as the angle', [big[0].kind, big[0].angle, big[0].title.startsWith('🏛 Health Bill'), big[1].url], ['parliament', 'Bill', true, null]);
  eq('big dates: UK for all, Scotland for the ones naming it', [P.bigDatesFor(big, ['uk']).length, P.bigDatesFor(big, ['scotland']).map((k) => [k.team_id, k.starts])], [3, [['scotland', '2026-11-27']]]);
  eq('big dates: sql reads _moments in the range', /from _moments where date::text >= '2026-11-01' and date::text <= '2026-12-31'/.test(P.bigDatesSql({ from: '2026-11-01', to: '2026-12-31' })), true);
  // E5: petitions near 100,000.
  eq('petitions near 100k: 75k up to 100k, not yet debated', P.nearHundredK([{ signatures: 80000 }, { signatures: 120000 }, { signatures: 60000 }, { signatures: 90000, debate: true }]).length, 1);
  // E2: "How your MPs voted" drafts.
  const V = require('./parl-vote-drafts');
  const b = { id: 1234, house: 'Commons', title: 'Health Bill: Report Stage: New Clause 1', bill: 'Health Bill', date: '2026-11-25', ayes: 300, noes: 200,
    url: 'https://votes.parliament.uk/Votes/Commons/Division/1234', parties: [['Labour', 290, 3]], scotland: false };
  const d = V.draftsFor(b);
  eq('vote drafts: one UK draft, id by division', d.map((x) => [x.id, x.team]), [['parl-vote-c1234-uk', 'uk']]);
  eq('vote drafts: the count and the link, no em dash', [d[0].doc.platforms.facebook.includes('300 Ayes to 200 Noes, so it passed by 100 votes'), d[0].doc.platforms.facebook.includes(b.url), /—/.test(JSON.stringify(d[0].doc))], [true, true, false]);
  eq('vote drafts: Scotland too when the bill reaches it', V.draftsFor({ ...b, scotland: true }).map((x) => x.team), ['uk', 'scotland']);
  eq('vote drafts: Lords wording', V.draftsFor({ ...b, house: 'Lords', ayes: 100, noes: 150 })[0].doc.platforms.facebook.slice(0, 84), 'Peers voted on the Health Bill: 100 Contents to 150 Not contents, so it was rejected');
  eq('vote drafts: no link, no draft', V.draftsFor({ ...b, url: 'http://x' }), []);
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvd-'));
  fs.writeFileSync(path.join(dir, 'division-c1234.json'), JSON.stringify(b));
  fs.writeFileSync(path.join(dir, 'division-c1.md'), 'not json');
  const posts = {}; const events = [];
  const store = { enginePost: async (id) => posts[id] || null, engineInsertPost: async (r) => { posts[r.id] = r; return r; }, engineEvent: async (e) => events.push(e) };
  const first = await V.run({ dir, store, log: () => {} });
  const again = await V.run({ dir, store, log: () => {} });
  eq('vote drafts: added once to Review, by the monitor', [first, again, posts['parl-vote-c1234-uk'].status, posts['parl-vote-c1234-uk'].created_by, events.length], [1, 0, 'review', 'parliamentary-monitor', 1]);
  eq('vote drafts: old briefs ignored', await V.run({ dir, store: { ...store, enginePost: async () => null }, log: () => {}, now: Date.now() + 5 * 864e5 }), 0);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
