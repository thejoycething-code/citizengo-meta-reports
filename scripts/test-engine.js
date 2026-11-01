#!/usr/bin/env node
'use strict';
// Pins the Content Engine rules (lib/engine.js) and tools (mcp/engine-tools.js)
// against an in-memory store: who sees which team's posts and calendar, that
// approving needs publishing rights, that stale saves are refused, and that
// copying another team's post lands in your own team. No credentials needed.
// Usage: node scripts/test-engine.js

const E = require('../lib/engine');
const { ENGINE_TOOLS } = require('../mcp/engine-tools');

let passed = 0, failed = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failed++; }
}

function memoryStore() {
  const db = {
    teams: [
      { id: 'de', name: 'Germany', flag: '🇩🇪', accounts: [{ key: 'de-fb', platform: 'facebook' }, { key: 'de-x', platform: 'x' }] },
      { id: 'at', name: 'Austria', flag: '🇦🇹', accounts: [{ key: 'at-fb', platform: 'facebook' }] },
      { id: 'uk', name: 'United Kingdom', flag: '🇬🇧', accounts: [{ key: 'uk-fb', platform: 'facebook' }, { key: 'sc-fb', platform: 'facebook' }, { key: 'uk-x', platform: 'x' }] },
    ],
    members: [{ team_id: 'de', who: 'greg', role: 'editor' }, { team_id: 'at', who: 'tamara@citizengo.net', role: 'editor' }, { team_id: 'uk', who: 'chris', role: 'admin' }],
    rights: [{ who: 'greg', account_key: 'de-fb' }, { who: 'tamara@citizengo.net', account_key: 'at-fb' }, { who: 'chris', account_key: 'uk-fb' }],
    posts: [], events: [],
  };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  return {
    db,
    async engineTeams() { return clone(db.teams); },
    async engineMembers({ who }) { return clone(db.members.filter((m) => m.who.toLowerCase() === String(who).toLowerCase())); },
    async engineRights({ who }) { return clone(db.rights.filter((r) => r.who.toLowerCase() === String(who).toLowerCase())); },
    async enginePosts({ team_ids, statuses, from, to } = {}) {
      return clone(db.posts.filter((p) => (!team_ids || team_ids.includes(p.team_id)) && (!statuses || statuses.includes(p.status))
        && (!from || (p.post_at && p.post_at >= from)) && (!to || (p.post_at && p.post_at < to))));
    },
    async enginePost(id) { const p = db.posts.find((x) => x.id === id); return p ? clone(p) : null; },
    async engineInsertPost(row) { const p = { version: 1, updated_at: 'now', ...row }; db.posts.push(p); return clone(p); },
    async engineUpdatePost(id, version, fields) {
      const p = db.posts.find((x) => x.id === id && x.version === version);
      if (!p) return null;
      Object.assign(p, fields, { version: version + 1 });
      return clone(p);
    },
    async engineEvent(row) { db.events.push(row); },
  };
}
const tool = (name) => ENGINE_TOOLS.find((t) => t.name === name).handler;
const call = async (store, name, args, who) => JSON.parse((await tool(name)(store, args, { who })).text);
const callErr = async (store, name, args, who) => { try { await tool(name)(store, args, { who }); return null; } catch (e) { return e.code; } };

(async () => {
  // Pure rules.
  eq('board status: pending → review', E.fromBoardStatus('pending'), 'review');
  eq('board status: approved with a future time → scheduled', E.fromBoardStatus('approved', '2030-01-01T08:00:00Z'), 'scheduled');
  eq('board status: approved with no time → hold', E.fromBoardStatus('approved', null), 'hold');
  eq('board status: archived (purged reject) → rejected', E.fromBoardStatus('archived'), 'rejected');
  {
    const { toRow, upsertSql } = require('./engine-import-board');
    const now = Date.parse('2026-11-01T00:00:00Z');
    const r = toRow('sc-20261012-x', { status: 'approved', title: "Scotland's vote", posting: { destinations: ['sc-fb'], at: '2026-11-04T18:00:00Z' } }, now).row;
    eq('import: Scotland draft goes to the UK team, approved with a future time → scheduled, status not kept in doc', [r.team_id, r.status, r.post_at, 'status' in r.doc], ['uk', 'scheduled', '2026-11-04T18:00:00.000Z', false]);
    eq('import: ids with no team are skipped', !!toRow('de-1', {}).skip, true);
    const sql = upsertSql([r]);
    eq('import SQL: quotes escaped, only untouched posts refreshed', [sql.includes("'Scotland''s vote'"), /where engine_posts\.updated_by = 'import'/.test(sql)], [true, true]);
  }
  eq('merge: objects merge, arrays replace, null removes', E.mergeDoc({ a: { x: 1, y: 2 }, l: [1, 2], k: 1 }, { a: { y: 3 }, l: [9], k: null }), { a: { x: 1, y: 3 }, l: [9] });
  eq('post times: per-account time wins, earliest first', E.postAt({ posting: { destinations: ['uk-fb', 'uk-x'], at: '2026-11-03T14:00:00Z', times: { 'uk-x': '2026-11-03T10:00:00Z' } } }), '2026-11-03T10:00:00.000Z');

  {
    const { toRow, applyRows } = require('./engine-import-board');
    const s2 = memoryStore();
    const rows = [toRow('uk-a', { status: 'pending', title: 'A' }).row, toRow('uk-b', { status: 'pending', title: 'B' }).row];
    eq('import apply: first run inserts', await applyRows(s2, rows), { inserted: 2, refreshed: 0, kept: 0 });
    await s2.engineUpdatePost('uk-b', 1, { title: 'B edited', updated_by: 'chris' });
    eq('import apply: re-run refreshes untouched posts, keeps ones edited in the engine', [await applyRows(s2, rows), s2.db.posts.find((p) => p.id === 'uk-b').title], [{ inserted: 0, refreshed: 1, kept: 1 }, 'B edited']);
  }

  const store = memoryStore();
  const docDe = { title: 'Wahlrecht', posting: { destinations: ['de-fb', 'de-x'], at: '2026-11-05T14:00:00Z' } };
  const de = await call(store, 'engine_create', { team: 'de', doc: docDe, id: 'de-1' }, 'greg');
  eq('greg creates a German post', [de.ok, de.post.status, de.post.post_at], [true, 'review', '2026-11-05T14:00:00.000Z']);
  eq('greg cannot add to Austria', await callErr(store, 'engine_create', { team: 'at', doc: {} }, 'greg'), 'ENGINE_NOT_MEMBER');
  await call(store, 'engine_create', { team: 'at', doc: { title: 'Lebensschutz', posting: { destinations: ['at-fb'], at: '2026-11-06T09:00:00Z' } }, id: 'at-1' }, 'tamara@citizengo.net');

  eq('tamara cannot open the German desk', await callErr(store, 'engine_posts', { team: 'de' }, 'tamara@citizengo.net'), 'ENGINE_NOT_MEMBER');
  eq('tamara cannot read a German post by id', await callErr(store, 'engine_post', { id: 'de-1' }, 'tamara@citizengo.net'), 'ENGINE_NOT_FOUND');
  eq('anonymous is turned away', await callErr(store, 'engine_me', {}, 'anonymous'), 'ENGINE_SIGN_IN');

  let cal = await call(store, 'engine_calendar', { from: '2026-11-01', to: '2026-11-30' }, 'tamara@citizengo.net');
  eq('calendar: German draft hidden from tamara, her own shows', cal.items.map((i) => i.id), ['at-1']);

  // Approving: rights and versions.
  let st = await call(store, 'engine_status', { id: 'de-1', version: 1, action: 'approve' }, 'greg');
  eq('greg approves (de-x is posted by hand, needs no right)', [st.ok, st.post && st.post.status], [true, 'scheduled']);
  cal = await call(store, 'engine_calendar', { from: '2026-11-01', to: '2026-11-30' }, 'tamara@citizengo.net');
  const g = cal.items.find((i) => i.id === 'de-1');
  eq('calendar: scheduled German post visible to tamara, read-only, no working text', [!!g, g && g.editable, g && g.text], [true, false, undefined]);

  const stale = await call(store, 'engine_save', { id: 'de-1', version: 1, patch: { title: 'old' } }, 'greg');
  eq('save pinned to an old version is a conflict', [stale.ok, stale.conflict], [false, true]);
  const add = await call(store, 'engine_save', { id: 'de-1', version: 2, patch: { posting: { destinations: ['de-fb', 'at-fb'] } } }, 'greg');
  eq('scheduled post: cannot add an account greg cannot publish to', [add.ok, /at-fb/.test(add.error)], [false, true]);
  const edit = await call(store, 'engine_save', { id: 'de-1', version: 2, patch: { firstComment: 'Jetzt unterschreiben' } }, 'greg');
  eq('scheduled post stays editable', [edit.ok, edit.post.status, edit.post.version], [true, 'scheduled', 3]);

  await call(store, 'engine_create', { team: 'uk', doc: { title: 'Lords', posting: { destinations: ['uk-fb', 'sc-fb'], at: '2026-11-02T14:00:00Z' } }, id: 'uk-1' }, 'chris');
  st = await call(store, 'engine_status', { id: 'uk-1', version: 1, action: 'approve' }, 'chris');
  eq('approve refused without a right for every Meta account', [st.ok, /sc-fb/.test(st.error)], [false, true]);
  st = await call(store, 'engine_status', { id: 'uk-1', version: 1, action: 'changes' }, 'chris');
  eq('changes needs a note', st.ok, false);
  st = await call(store, 'engine_status', { id: 'uk-1', version: 1, action: 'hold' }, 'chris');
  eq('hold works from review', [st.ok, st.post.status], [true, 'hold']);

  // Copy an idea across teams.
  const cp = await call(store, 'engine_copy', { id: 'de-1', to_team: 'at' }, 'tamara@citizengo.net');
  eq('tamara copies the scheduled German post into Austria, without its posting plan', [cp.ok, cp.post.team_id, cp.post.status, cp.post.source_team, !!cp.post.doc.posting], [true, 'at', 'review', 'de', false]);
  eq('tamara cannot copy a German draft she cannot see', await callErr(store, 'engine_copy', { id: 'uk-1', to_team: 'at' }, 'tamara@citizengo.net'), 'ENGINE_NOT_FOUND');

  eq('every change is in the activity log', store.db.events.map((e) => e.action), ['create', 'create', 'approve', 'save', 'create', 'hold', 'create', 'copy']);

  const me = await call(store, 'engine_me', {}, 'chris');
  eq('engine_me: chris sees the UK team and his rights', [me.teams.map((t) => t.id), me.publish_rights], [['uk'], ['uk-fb']]);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
