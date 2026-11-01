#!/usr/bin/env node
'use strict';
// The Content Engine Inbox (lib/inbox.js, collector/inbox.js,
// collector/inbox-actions.js, the engine_inbox* tools) against an in-memory
// engine and a fake Meta: reading keeps people's status, actions wait out
// their undo window, a dry run sends nothing, and only people with a right on
// the account can act for it.
// Usage: node scripts/test-inbox.js

let passed = 0, failed = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${name}`); passed++; } else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failed++; }
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const xauth = require('../lib/xauth');
const I = require('../lib/inbox');
const collect = require('../collector/inbox');
const worker = require('../collector/inbox-actions');
const { ENGINE_TOOLS } = require('../mcp/engine-tools');

const keys = xauth.generateKeyPair();
const NOW = Date.parse('2026-11-03T14:00:00Z');

function engine() {
  const db = {
    teams: [{ id: 'uk', name: 'United Kingdom', accounts: [{ key: 'uk-fb', platform: 'facebook' }, { key: 'uk-ig', platform: 'instagram' }, { key: 'uk-x', platform: 'x' }] }],
    members: [{ team_id: 'uk', who: 'chris', role: 'admin' }, { team_id: 'uk', who: 'sam', role: 'editor' }],
    rights: [{ who: 'chris', account_key: 'uk-fb', source: 'meta' }, { who: 'chris', account_key: 'uk-ig', source: 'meta' }],
    tokens: [{ who: 'chris', account_key: 'uk-fb', page_id: '105', ig_id: '178', connected_at: '2026-11-01', sealed: xauth.seal(keys.publicKey, 'PAGE-TOKEN') }, { who: 'chris', account_key: 'uk-ig', page_id: '105', ig_id: '178', connected_at: '2026-11-01', sealed: xauth.seal(keys.publicKey, 'PAGE-TOKEN') }],
    inbox: [], actions: [],
  };
  let aid = 0;
  const pick = (r, cols) => r;
  return {
    db,
    async engineTeams() { return clone(db.teams); },
    async engineMembers({ who }) { return clone(db.members.filter((m) => m.who === who)); },
    async engineRights({ who }) { return clone(db.rights.filter((r) => r.who === who)); },
    async engineConnectedTokens() { return clone(db.tokens); },
    async enginePageToken({ who, account_key }) { return clone(db.tokens.find((t) => t.who === who && t.account_key === account_key) || null); },
    async enginePauses() { return []; },
    async engineInbox({ team_ids, statuses, thread_id, platform, kind }) {
      const rows = db.inbox.filter((r) => (!team_ids || team_ids.includes(r.team_id)) && (!statuses || statuses.includes(r.status)) && (!thread_id || r.thread_id === thread_id) && (!platform || r.platform === platform) && (!kind || r.kind === kind) && !r.deleted_at);
      return clone(rows.sort((a, b) => (thread_id ? a.created_at.localeCompare(b.created_at) : b.created_at.localeCompare(a.created_at))));
    },
    async engineInboxItem(id) { return clone(db.inbox.find((r) => r.id === id) || null); },
    async engineInboxUpsert(rows) {
      for (const r of rows) { const cur = db.inbox.find((x) => x.id === r.id); if (cur) Object.assign(cur, r); else db.inbox.push({ status: 'open', labels: [], assigned_to: null, ...r }); }
      return rows.length;
    },
    async engineInboxUpdate(id, fields) { const r = db.inbox.find((x) => x.id === id); Object.assign(r, fields); return clone(r); },
    async engineInboxActions({ team_ids, statuses, due_before }) {
      return clone(db.actions.filter((a) => (!team_ids || team_ids.includes(a.team_id)) && (!statuses || statuses.includes(a.status)) && (!due_before || a.run_after <= due_before)));
    },
    async engineInboxInsertAction(row) { const a = { id: ++aid, created_at: new Date().toISOString(), detail: {}, ...row }; db.actions.push(a); return clone(a); },
    async engineInboxUpdateAction(id, from, fields) { const a = db.actions.find((x) => x.id === id && x.status === from); if (!a) return null; Object.assign(a, fields); return clone(a); },
  };
}
const tool = (name) => ENGINE_TOOLS.find((t) => t.name === name).handler;
const call = async (store, name, args, who) => JSON.parse((await tool(name)(store, args, { who })).text);
const callErr = async (store, name, args, who) => { try { await tool(name)(store, args, { who }); return null; } catch (e) { return e.code; } };

// Fake Meta: a Page with one post and two comments (one ours), one ad, an
// Instagram post with a comment and a reply, and a Messenger conversation.
function fakeMeta() {
  const calls = [];
  const fetchImpl = async (u, opts = {}) => {
    const url = new URL(u);
    const params = Object.fromEntries(new URLSearchParams(opts.body || url.search));
    const path = url.pathname.replace(/^\/v[\d.]+\//, '');
    calls.push({ method: opts.method || 'GET', path, params });
    const ok = (b) => ({ ok: true, status: 200, json: async () => b });
    if (params.access_token !== 'PAGE-TOKEN') return { ok: false, status: 400, json: async () => ({ error: { message: 'Invalid token', code: 190 } }) };
    if (path === '105/posts') return ok({ data: [{ id: '105_1', message: 'Pray with us for Isabel', created_time: '2026-11-02T10:00:00+0000', permalink_url: 'https://fb/1' }] });
    if (path === '105/ads_posts') return ok({ data: [{ id: '105_9', message: 'Stand with Isabel', created_time: '2026-11-01T10:00:00+0000' }] });
    if (path === '105_1/comments') return ok({ data: [{ id: 'c1', message: 'How can I sign?', from: { id: 'u1', name: 'Margaret T.' }, created_time: '2026-11-03T12:00:00+0000' }, { id: 'c2', message: 'Here: cgo.ac/x', from: { id: '105', name: 'Citizen GO UK' }, created_time: '2026-11-03T12:05:00+0000', parent: { id: 'c1' } }] });
    if (path === '105_9/comments') return ok({ data: [{ id: 'c9', message: 'Rubbish', from: { id: 'u9', name: 'Troll' }, created_time: '2026-11-03T13:00:00+0000', is_hidden: false }] });
    if (path === '178/media') return ok({ data: [{ id: 'm1', caption: 'Reel', timestamp: '2026-11-02T18:00:00+0000', permalink: 'https://ig/1' }, { id: 'm0', caption: 'old', timestamp: '2026-10-01T18:00:00+0000' }] });
    if (path === 'm1/comments') return ok({ data: [{ id: 'i1', text: '🙏', username: 'anna', timestamp: '2026-11-03T09:00:00+0000', from: { id: 'ua' }, replies: { data: [{ id: 'i2', text: 'Thank you Anna', username: 'citizengo_uk', timestamp: '2026-11-03T09:10:00+0000', from: { id: '178' } }] } }] });
    if (path === '105/conversations') return ok({ data: params.platform === 'instagram' ? [] : [{ id: 't1', messages: { data: [{ id: 'mm2', message: 'Thanks!', from: { id: '105', name: 'Citizen GO UK' }, created_time: '2026-11-03T11:00:00+0000' }, { id: 'mm1', message: 'Is there a petition?', from: { id: 'psid7', name: 'Journalist' }, created_time: '2026-11-03T10:00:00+0000' }] } }] });
    if (path === 'c1/comments') return ok({ id: 'c1_reply' });
    if (path === 'c9' && params.is_hidden === 'true') return ok({ success: true });
    if (path === '105/messages') return ok({ recipient_id: 'psid7', message_id: 'mid.1' });
    return { ok: false, status: 404, json: async () => ({ error: { message: `unexpected ${path}` } }) };
  };
  return { calls, fetchImpl };
}

(async () => {
  // Rules.
  const comment = { kind: 'comment', platform: 'facebook', created_at: '2026-11-03T12:00:00Z', hidden: false, from_us: false };
  eq('rules: a reply needs text; Instagram comments cannot be liked; ours cannot be hidden',
    [I.allowed(comment, 'reply', { text: ' ', now: NOW }).ok, I.allowed({ ...comment, platform: 'instagram' }, 'like', { now: NOW }).ok, I.allowed({ ...comment, from_us: true }, 'hide', { now: NOW }).ok, I.allowed(comment, 'hide', { now: NOW }).ok],
    [false, false, false, true]);
  eq('rules: a DM reply only within 24 hours of their last message; private replies within 7 days',
    [I.allowed({ kind: 'message', platform: 'facebook' }, 'reply', { text: 'hi', lastIncomingAt: '2026-11-02T13:00:00Z', now: NOW }).ok, I.allowed({ kind: 'message', platform: 'facebook' }, 'reply', { text: 'hi', lastIncomingAt: '2026-11-03T13:00:00Z', now: NOW }).ok, I.allowed({ ...comment, created_at: '2026-10-20T00:00:00Z' }, 'private_reply', { text: 'x', now: NOW }).ok],
    [false, true, false]);

  // Collector.
  const s = engine();
  const meta = fakeMeta();
  const dry = await collect.run({ store: s, privateKey: keys.privateKey, live: false, now: NOW, log: () => {}, fetchImpl: meta.fetchImpl });
  eq('collector dry run: reads but saves nothing', [dry.comments, dry.messages, s.db.inbox.length], [5, 2, 0]);
  const t1 = await collect.run({ store: s, privateKey: keys.privateKey, live: true, now: NOW, log: () => {}, fetchImpl: meta.fetchImpl });
  eq('collector: Facebook posts and ads, Instagram comments and replies within 7 days, Messenger', [t1.accounts, t1.skipped, s.db.inbox.map((r) => r.id).sort()], [2, 0, ['fbc_c1', 'fbc_c2', 'fbc_c9', 'fbm_mm1', 'fbm_mm2', 'igc_i1', 'igc_i2'].sort()]);
  eq('collector: our own comments arrive done, the ad is marked, nothing is posted to Meta', [s.db.inbox.filter((r) => r.status === 'done').map((r) => r.id).sort(), s.db.inbox.find((r) => r.id === 'fbc_c9').is_ad, meta.calls.every((c) => c.method === 'GET')], [['fbc_c2', 'fbm_mm2', 'igc_i2'], true, true]);

  // People's columns survive a re-read.
  eq('tool: an open inbox with counts', (await call(s, 'engine_inbox', { team: 'uk' }, 'sam')).counts, { open: 4, facebook: 3, instagram: 1, messages: 1, mine: 0 });
  await call(s, 'engine_inbox_act', { id: 'fbc_c1', action: 'assign', assign_to: 'sam' }, 'chris');
  await call(s, 'engine_inbox_act', { id: 'igc_i1', action: 'done' }, 'sam');
  await call(s, 'engine_inbox_act', { id: 'fbc_c9', action: 'label', labels: ['critic', 'critic', 'ad'] }, 'sam');
  await collect.run({ store: s, privateKey: keys.privateKey, live: true, now: NOW, log: () => {}, fetchImpl: fakeMeta().fetchImpl });
  const row = (id) => s.db.inbox.find((r) => r.id === id);
  eq('desk actions apply at once and survive the next read', [row('fbc_c1').assigned_to, row('igc_i1').status, row('fbc_c9').labels], ['sam', 'done', ['critic', 'ad']]);
  eq('assigned to sam shows in his count', (await call(s, 'engine_inbox', { team: 'uk' }, 'sam')).counts.mine, 1);

  // Meta actions: rights, queue, undo.
  eq('sam has no Page right, so he cannot reply for UK Facebook', (await call(s, 'engine_inbox_act', { id: 'fbc_c1', action: 'reply', text: 'Thank you!' }, 'sam')).ok, false);
  eq('another team cannot see the item', await callErr(s, 'engine_inbox_act', { id: 'fbc_c1', action: 'done' }, 'tamara'), 'ENGINE_NOT_FOUND');
  const r1 = await call(s, 'engine_inbox_act', { id: 'fbc_c1', action: 'reply', text: 'Thank you, Margaret 🙏 Sign here: cgo.ac/x' }, 'chris');
  const r2 = await call(s, 'engine_inbox_act', { id: 'fbc_c9', action: 'hide' }, 'chris');
  const r3 = await call(s, 'engine_inbox_act', { id: 'fbm_mm1', action: 'reply', text: 'Here is the petition.' }, 'chris');
  const r4 = await call(s, 'engine_inbox_act', { id: 'igc_i1', action: 'like' }, 'chris');
  eq('replies, hides and DM replies are queued with a 10-second undo; liking on Instagram is refused', [r1.ok, r1.queued.status, Date.parse(r1.undo_until) - Date.parse(r1.queued.created_at) >= 9000, r2.ok, r3.queued.detail.recipient, r4.ok], [true, 'queued', true, true, 'psid7', false]);
  eq('sam cannot undo chris\'s reply', (await call(s, 'engine_inbox_undo', { action_id: r2.queued.id }, 'sam')).ok, false);
  eq('chris undoes the hide in time', (await call(s, 'engine_inbox_undo', { action_id: r2.queued.id }, 'chris')).ok, true);

  // Worker.
  const later = Date.now() + 20_000;
  const fm = fakeMeta();
  const w0 = await worker.run({ store: s, privateKey: keys.privateKey, live: false, now: later, log: () => {}, fetchImpl: fm.fetchImpl });
  eq('worker dry run: sends nothing, leaves them queued', [w0.would, fm.calls.length, s.db.actions.filter((a) => a.status === 'queued').length], [2, 0, 2]);
  const early = await worker.run({ store: s, privateKey: keys.privateKey, live: true, now: Date.parse(r1.queued.created_at) + 2000, log: () => {}, fetchImpl: fm.fetchImpl });
  eq('worker: nothing goes inside the undo window', [early.sent, fm.calls.length], [0, 0]);
  const w1 = await worker.run({ store: s, privateKey: keys.privateKey, live: true, now: later, log: () => {}, fetchImpl: fm.fetchImpl });
  eq('worker: the comment reply and the DM reply go to Meta with chris\'s token; the undone hide never does', [w1.sent, fm.calls.map((c) => `${c.method} ${c.path}`), fm.calls.some((c) => c.path === 'c9')], [2, ['POST c1/comments', 'POST 105/messages'], false]);
  eq('worker: the DM goes to the person, as a response', [JSON.parse(fm.calls[1].params.recipient).id, fm.calls[1].params.messaging_type], ['psid7', 'RESPONSE']);
  eq('worker: replied items are done, and the history has every action', [row('fbc_c1').status, !!row('fbc_c1').replied_at, (await call(s, 'engine_inbox_history', { team: 'uk' }, 'sam')).actions.map((a) => `${a.action}:${a.status}`).sort()],
    ['done', true, ['assign:done', 'done:done', 'hide:cancelled', 'label:done', 'reply:done', 'reply:done'].sort()]);
  const w2 = await worker.run({ store: s, privateKey: keys.privateKey, live: true, now: later + 60_000, log: () => {}, fetchImpl: fm.fetchImpl });
  eq('worker: never twice', [w2.sent, fm.calls.length], [0, 2]);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
