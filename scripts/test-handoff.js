#!/usr/bin/env node
'use strict';
// Hand-off mode (config/handoff.json, ENGINE_HANDOFF_MODE): the publisher has
// nothing due, approving needs no publishing right and records the hand-off,
// and overdue means 30 minutes past the post's time without being posted.
// Usage: node scripts/test-handoff.js
process.env.ENGINE_HANDOFF_MODE = '1';

const H = require('../lib/handoff');
const E = require('../lib/engine');
const P = require('../lib/publish');

let passed = 0, failed = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${name}`); passed++; } else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failed++; }
}

const NOW = Date.parse('2026-11-09T10:00:00Z');
const team = { id: 'uk', accounts: [{ key: 'uk-fb', platform: 'facebook' }, { key: 'sc-fb', platform: 'facebook' }, { key: 'uk-x', platform: 'x' }] };
const doc = { posting: { destinations: ['uk-fb', 'sc-fb'], at: '2026-11-09T09:00:00Z' }, review: { action: 'approve', by: 'chris' } };
const due = { id: 'p1', team_id: 'uk', status: 'scheduled', post_at: '2026-11-09T09:00:00Z', doc };

eq('switch: env 1 forces it on', H.on({ ENGINE_HANDOFF_MODE: '1' }), true);
eq('switch: env 0 forces it off', H.on({ ENGINE_HANDOFF_MODE: '0' }), false);
eq('switch: the config file has it on', H.on({}), true);
eq('info: says why and the overdue minutes', [H.info({}).on, H.info({}).overdue_minutes, !!H.info({}).why], [true, 30, true]);

eq('publisher: nothing is due in hand-off mode', P.plan([due], [team], NOW, [], { handoff: true }), []);
eq('publisher: the same post is due with hand-off off', P.plan([due], [team], NOW, [], { handoff: false }).map((x) => x.action), ['publish', 'publish']);

eq('approve: no publishing right needed in hand-off mode', E.transition({ from: 'hold', action: 'approve', doc, team, rights: [], handoff: true }), { ok: true, status: 'scheduled' });
eq('approve: still needs the right with hand-off off', E.transition({ from: 'hold', action: 'approve', doc, team, rights: [], handoff: false }).ok, false);
eq('approve: still needs a time', E.transition({ from: 'hold', action: 'approve', doc: { posting: { destinations: ['uk-fb'] } }, team, rights: [], handoff: true }).ok, false);
eq('save: a handed-off post can add an account', E.saveAllowed({ status: 'scheduled', before: { posting: { destinations: ['uk-fb'] } }, after: doc, team, rights: [], handoff: true }), { ok: true });

eq('overdue: 60 minutes past its time', H.overdue(due, NOW), true);
eq('overdue: 20 minutes past is not yet', H.overdue({ ...due, post_at: '2026-11-09T09:40:00Z' }, NOW), false);
eq('overdue: a posted post never is', H.overdue({ ...due, status: 'posted' }, NOW), false);

(async () => {
  // engine_status records the hand-off on approval.
  const { ENGINE_TOOLS } = require('../mcp/engine-tools');
  const tool = (n) => ENGINE_TOOLS.find((t) => t.name === n).handler;
  const post = { id: 'p2', team_id: 'uk', status: 'hold', version: 1, doc: { posting: { destinations: ['uk-fb'], at: '2026-11-10T09:00:00Z' } } };
  const saved = [];
  const store = {
    async engineTeams() { return [team]; },
    async engineMembers() { return [{ team_id: 'uk', who: 'tobias', role: 'editor' }]; },
    async engineMaintainers() { return []; },
    async enginePost() { return JSON.parse(JSON.stringify(post)); },
    async engineRights() { return []; },
    async engineUpdatePost(id, v, f) { saved.push(f); return { ...post, ...f, version: v + 1 }; },
    async engineEvent() {},
  };
  try {
    const r = JSON.parse((await tool('engine_status')(store, { id: 'p2', version: 1, action: 'approve' }, { who: 'tobias' })).text);
    eq('engine_status: approved with no Meta right', [r.ok, saved[0] && saved[0].status], [true, 'scheduled']);
    eq('engine_status: records who handed it off', saved[0] && saved[0].doc.posting.handoff.by, 'tobias');
  } catch (e) { eq(`engine_status: ran (${e.message})`, false, true); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
