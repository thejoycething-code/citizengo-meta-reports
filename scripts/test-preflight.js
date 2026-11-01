#!/usr/bin/env node
'use strict';
// The go-live preflight (lib/preflight.js): today's state reads as not ready
// for the right reasons; a ready engine reads as ready.
// Usage: node scripts/test-preflight.js

let passed = 0, failed = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${name}`); passed++; } else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failed++; }
}
const F = require('../lib/preflight');
const NOW = Date.parse('2026-11-02T09:00:00Z');
const teams = [{ id: 'uk', accounts: [{ key: 'uk-fb', platform: 'facebook' }, { key: 'uk-ig', platform: 'instagram' }, { key: 'uk-x', platform: 'x' }] }];
const post = (id, at, final) => ({ id, post_at: at, doc: { posting: { destinations: ['uk-fb'] }, final } });

const today = F.check({ connectStatus: 503, teams, rights: [{ who: 'chris', account_key: 'uk-fb', source: 'maintainer' }], tokens: [], scheduled: [post('p1', '2026-11-03T12:00:00Z', null)], pauses: [], automations: [{ active: true }], queued: [{ id: 1 }],
  env: { ENGINE_PUBLISH_LIVE: undefined, ENGINE_INBOX_LIVE: undefined, ENGINE_TOKEN_PRIVATE_KEY: true }, plists: { publisher: '<string>node collector/publish.js --dry-run</string>', inbox: '--dry-run' }, now: NOW });
const st = (items, t) => items.find((i) => i.title.startsWith(t)).state;
eq('today: Connect Facebook off, nobody connected, a post without its snapshot', [st(today, 'Connect Facebook'), st(today, 'Every Facebook'), st(today, 'Scheduled posts')], ['todo', 'todo', 'todo']);
eq('today: hand-seeded rights and queued actions are flagged, both jobs in dry run', [st(today, 'Publishing rights'), /1 Inbox action/.test(today.find((i) => i.title.startsWith('Automations')).detail), /Dry run/.test(today.find((i) => i.title === 'Publisher on this Mini').detail), /Dry run/.test(today.find((i) => i.title === 'Inbox sender on this Mini').detail)], ['info', true, true, true]);
eq('the report counts what is left to do', /3 things to do before going live/.test(F.render(today)), true);

const ready = F.check({ connectStatus: 302, teams, rights: [{ who: 'chris', account_key: 'uk-fb', source: 'meta' }], tokens: [{ account_key: 'uk-fb' }, { account_key: 'uk-ig' }], scheduled: [post('p1', '2026-11-03T12:00:00Z', { facebook: { text: 'x' } })], pauses: [], automations: [], queued: [], env: null, plists: {}, now: NOW });
eq('ready: nothing blocking', [ready.filter((i) => i.state === 'todo').length, /Nothing blocking/.test(F.render(ready))], [0, true]);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
