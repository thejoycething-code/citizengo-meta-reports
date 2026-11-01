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
    keyDates: [{ team_id: null, starts: '2026-11-20', title: "Universal Children's Day" }, { team_id: 'de', starts: '2026-11-22', title: 'Totensonntag' }, { team_id: 'at', starts: '2026-11-15', title: 'Leopolditag' }],
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
    async engineRequests({ team_ids, statuses }) {
      return clone((db.requests || []).filter((r) => team_ids.includes(r.team_id) && (!statuses || statuses.includes(r.status))));
    },
    async engineInsertRequest(row) { db.requests = db.requests || []; const r = { id: db.requests.length + 1, status: 'open', ...row }; db.requests.push(r); return clone(r); },
    async engineUpdateRequest(id, fields) { const r = (db.requests || []).find((x) => x.id === id && x.status === 'open'); if (!r) return null; Object.assign(r, fields); return clone(r); },
    async engineEvergreen({ team_ids }) { return clone((db.evergreen || []).filter((r) => team_ids.includes(r.team_id))); },
    async engineInsertEvergreen(row) { db.evergreen = db.evergreen || []; const r = { id: db.evergreen.length + 1, status: 'active', snoozed_until: null, ...row }; db.evergreen.push(r); return clone(r); },
    async engineUpdateEvergreen(id, fields) { const r = (db.evergreen || []).find((x) => x.id === id); if (!r) return null; Object.assign(r, fields); return clone(r); },
    async engineKeyDates({ team_ids, from, to }) {
      return clone(db.keyDates.filter((k) => (k.team_id === null || team_ids.includes(k.team_id)) && k.starts < to && (k.ends || k.starts) >= from));
    },
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
  {
    const K = require('./engine-key-dates');
    eq('key dates: single day, week, and a span across years', [K.parseWhen('**Sun 8 Nov 2026**'), K.parseWhen('15–22 Nov 2026'), K.parseWhen('18 Dec 2026 – 4 Jan 2027')],
      [{ starts: '2026-11-08', ends: null }, { starts: '2026-11-15', ends: '2026-11-22' }, { starts: '2026-12-18', ends: '2027-01-04' }]);
    eq('key dates: no firm date, no row', [K.parseWhen('Mid-Jan 2027'), K.parseWhen('Oct 2026 (month)')], [null, null]);
    const md = '| Date | Occasion | a | b | c |\n| Fri 27 Nov 2026 | Hospice Funding Bill, Second Reading | x | y | verified |\n| Sat 11 Sep 2027 | 1 year since the Commons defeated the bill | x | y | verified |\n| **Sun 7 Mar 2027** | **Mothering Sunday** | Motherhood | Thank you | verified |';
    eq('key dates: sittings left out, anniversaries kept, Mothering Sunday is the team\'s Mother\'s Day', K.teamDates(md, 'uk').map((r) => [r.starts, r.kind]), [['2027-09-11', 'key'], ['2027-03-07', 'mothers_day']]);
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
  eq('calendar key dates: CitizenGO-wide plus her own team, not Germany\'s', cal.key_dates.map((k) => k.title).sort(), ['Leopolditag', "Universal Children's Day"]);

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

  eq('posted: only once scheduled or on hold, and needs no publishing right', [E.transition({ from: 'review', action: 'posted' }).ok, E.transition({ from: 'scheduled', action: 'posted', doc: { posting: { destinations: ['sc-fb'] } }, rights: [] }).status], [false, 'posted']);
  eq('reopen: a scheduled post can go back to review', E.transition({ from: 'scheduled', action: 'reopen' }).status, 'review');

  // Plan: requests to draft a post for a date.
  eq('request: past dates and blank titles refused', [E.checkRequest({ for_date: '2026-10-01', title: 'x' }, new Date('2026-11-01')).ok, E.checkRequest({ for_date: '2026-11-08', title: ' ' }, new Date('2026-11-01')).ok], [false, false]);
  const rq = await call(store, 'engine_request', { action: 'create', team: 'uk', for_date: '2099-11-08', title: 'Remembrance Sunday', angle: 'Respectful poppy post', source: 'key_date' }, 'chris');
  eq('chris asks for a Remembrance Sunday draft', [rq.ok, rq.request.status, rq.request.requested_by, rq.request.source], [true, 'open', 'chris', 'key_date']);
  eq('greg cannot plan for the UK', await callErr(store, 'engine_request', { action: 'create', team: 'uk', for_date: '2099-11-08', title: 'x' }, 'greg'), 'ENGINE_NOT_MEMBER');
  eq('greg cannot see or cancel UK requests', [await callErr(store, 'engine_requests', { team: 'uk' }, 'greg'), (await call(store, 'engine_request', { action: 'cancel', id: rq.request.id }, 'greg')).ok], ['ENGINE_NOT_MEMBER', false]);
  const dr = await call(store, 'engine_request', { action: 'drafted', id: rq.request.id, post_id: 'uk-1' }, 'chris');
  eq('the daily engine marks it drafted with the new post', [dr.ok, dr.request.status, dr.request.post_id], [true, 'drafted', 'uk-1']);
  eq('a drafted request cannot be cancelled', (await call(store, 'engine_request', { action: 'cancel', id: rq.request.id }, 'chris')).ok, false);
  eq('the plan lists open and drafted requests', (await call(store, 'engine_requests', { team: 'uk' }, 'chris')).requests.map((r) => r.status), ['drafted']);

  // Evergreen bank: due 10 weeks after it last went out.
  const nov1 = new Date('2026-11-01T09:00:00Z');
  eq('evergreen: 18 weeks since → due; 7 weeks → coming; 2 weeks → resting; retired stays retired',
    [E.evergreenState({ last_out: '2026-06-26' }, nov1).state, E.evergreenState({ last_out: '2026-09-13' }, nov1).state, E.evergreenState({ last_out: '2026-10-18' }, nov1).state, E.evergreenState({ last_out: '2026-06-26', status: 'retired' }, nov1).state],
    ['due', 'coming', 'resting', 'retired']);
  eq('evergreen: a snooze pushes the due date', E.evergreenState({ last_out: '2026-06-26', snoozed_until: '2026-11-29' }, nov1), { state: 'coming', due_on: '2026-11-29', weeks_since: 18 });
  eq('evergreen: due date is 10 weeks on', E.evergreenState({ last_out: '2026-08-13' }, nov1).due_on, '2026-10-22');
  eq('evergreen add: needs a title and a past date', [E.checkEvergreen({ title: '', last_out: '2026-06-26' }).ok, E.checkEvergreen({ title: 'x', last_out: '2099-01-01' }).ok, E.checkEvergreen({ title: 'x', last_out: '2026-06-26', url: 'javascript:alert(1)' }).ok], [false, false, false]);
  const eg = await call(store, 'engine_evergreen_update', { action: 'add', team: 'uk', title: 'Pray for the persecuted Church in Nigeria', last_out: '2026-06-26', url: 'https://www.facebook.com/reel/1', format: 'Reel', account_key: 'uk-fb', result: '10.4x, 821 shares', why: 'Red Wednesday' }, 'chris');
  eq('chris adds a past winner to the UK bank', [eg.ok, eg.post.status, eg.post.added_by], [true, 'active', 'chris']);
  eq('greg cannot add to or see the UK bank', [await callErr(store, 'engine_evergreen_update', { action: 'add', team: 'uk', title: 'x', last_out: '2026-06-26' }, 'greg'), await callErr(store, 'engine_evergreen', { team: 'uk' }, 'greg'), (await call(store, 'engine_evergreen_update', { action: 'retire', id: eg.post.id }, 'greg')).ok], ['ENGINE_NOT_MEMBER', 'ENGINE_NOT_MEMBER', false]);
  const fd = await call(store, 'engine_request', { action: 'create', team: 'uk', for_date: '2099-11-18', title: 'Fresh: Pray for Nigeria', source: 'evergreen', evergreen_id: eg.post.id }, 'chris');
  eq('a fresh draft is a Plan request tied to the bank post', [fd.ok, fd.request.source, fd.request.evergreen_id], [true, 'evergreen', eg.post.id]);
  eq('a fresh draft needs a post from the same team\'s bank', (await call(store, 'engine_request', { action: 'create', team: 'uk', for_date: '2099-11-18', title: 'x', source: 'evergreen', evergreen_id: 99 }, 'chris')).ok, false);
  let bank = await call(store, 'engine_evergreen', { team: 'uk' }, 'chris');
  eq('the bank shows it due, with the open request', [bank.posts[0].state, bank.posts[0].requested && bank.posts[0].requested.for_date], ['due', '2099-11-18']);
  await call(store, 'engine_evergreen_update', { action: 'snooze', id: eg.post.id }, 'chris');
  bank = await call(store, 'engine_evergreen', { team: 'uk' }, 'chris');
  eq('snooze: 4 weeks, so it is coming up again, not due', bank.posts[0].state, 'coming');
  const wo = await call(store, 'engine_evergreen_update', { action: 'went_out', id: eg.post.id, last_out: '2026-10-30' }, 'chris');
  eq('a fresh version went out: it rests, and the snooze is cleared', [wo.post.state, wo.post.snoozed_until], ['resting', null]);

  // Slice 2: Connect Facebook.
  const teamsFb = [{ id: 'uk', accounts: [{ key: 'uk-fb', platform: 'facebook', page_id: '105' }, { key: 'uk-ig', platform: 'instagram', ig_id: '178' }, { key: 'sc-fb', platform: 'facebook', page_id: '120' }, { key: 'sc-ig', platform: 'instagram', handle: 'citizengo_scotland' }, { key: 'uk-x', platform: 'x' }] }];
  const pagesFb = [
    { id: '105', name: 'Citizen GO UK', tasks: ['CREATE_CONTENT', 'MODERATE'], access_token: 'T1', instagram_business_account: { id: '178', username: 'citizengo_uk' } },
    { id: '120', name: 'Citizen GO Scotland', tasks: ['ANALYZE'], access_token: 'T2', instagram_business_account: { id: '999', username: 'citizengo_scotland' } },
    { id: '777', name: 'Somebody else', tasks: ['CREATE_CONTENT'], access_token: 'T3' },
  ];
  eq('connect: a Page you can post to gives its Facebook and linked Instagram; analyst-only Pages and other Pages give nothing',
    E.rightsFromPages(teamsFb, pagesFb).map((r) => [r.account_key, r.token]), [['uk-fb', 'T1'], ['uk-ig', 'T1']]);
  pagesFb[1].tasks.push('CREATE_CONTENT');
  eq('connect: Instagram matched by handle when the team has no id', E.rightsFromPages(teamsFb, pagesFb).map((r) => r.account_key), ['uk-fb', 'uk-ig', 'sc-fb', 'sc-ig']);
  {
    const F = require('../lib/fbflow');
    const t = F.signLink('s3cret', 'greg', 1000);
    eq('connect link: names the person, ten minutes, tamper-proof', [F.verifyLink('s3cret', t, 2000).who, F.verifyLink('s3cret', t, 1000 + 11 * 60_000), F.verifyLink('other', t, 2000), F.verifyLink('s3cret', t.replace(/^./, 'x'), 2000)], ['greg', null, null, null]);
    const before = { ...process.env };
    Object.assign(process.env, { FB_APP_ID: '1', FB_APP_SECRET: '2', FB_REDIRECT_URI: 'https://x/api/fb/callback', OAUTH_SIGNING_SECRET: 's3cret', ENGINE_TOKEN_PUBLIC_KEY: 'k', PUBLIC_ORIGIN: 'https://meta.example' });
    const link = await call(store, 'engine_connect', {}, 'greg');
    eq('engine_connect: a link for the signed-in person', [link.ok, link.url.startsWith('https://meta.example/api/fb/authorize?t='), F.verifyLink('s3cret', decodeURIComponent(link.url.split('t=')[1])).who], [true, true, 'greg']);
    for (const k of ['FB_APP_ID', 'FB_APP_SECRET', 'FB_REDIRECT_URI', 'OAUTH_SIGNING_SECRET', 'ENGINE_TOKEN_PUBLIC_KEY', 'PUBLIC_ORIGIN']) { if (k in before) process.env[k] = before[k]; else delete process.env[k]; }
    eq('engine_connect: says plainly when it is not switched on', (await call(store, 'engine_connect', {}, 'greg')).configured, false);
    eq('engine_connect: anonymous is turned away', await callErr(store, 'engine_connect', {}, 'anonymous'), 'ENGINE_SIGN_IN');
  }

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
