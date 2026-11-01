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
const E = require('../lib/engine');
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
    inbox: [], actions: [], rules: [], alerts: [], autos: [],
  };
  let aid = 0;
  const pick = (r, cols) => r;
  return {
    db,
    async engineTeams() { return clone(db.teams); },
    async engineMembers({ who, team_id }) { return clone(db.members.filter((m) => (!who || m.who === who) && (!team_id || m.team_id === team_id))); },
    async engineAllRights() { return clone(db.rights); },
    async engineRights({ who, kind }) { const off = new Set((db.limits || []).filter((l) => l.who === who && kind && l[`can_${kind}`] === false).map((l) => l.account_key)); return clone(db.rights.filter((r) => r.who === who && !off.has(r.account_key))); },
    async engineAllRightsFor({ whos }) { return clone(db.rights.filter((r) => whos.includes(r.who))); },
    async engineAccessLimits({ team_id, who } = {}) { return clone((db.limits || []).filter((l) => (!team_id || l.team_id === team_id) && (!who || l.who === who))); },
    async engineSetAccessLimit(row) { db.limits = (db.limits || []).filter((l) => !(l.team_id === row.team_id && l.who === row.who && l.account_key === row.account_key)); if (['can_post', 'can_reply', 'can_moderate', 'can_analytics'].some((k) => row[k] === false)) db.limits.push(row); },
    async enginePeople() { return clone(db.people || []); },
    async engineCopilotAuth() { return null; },
    async engineEvent(e) { (db.events = db.events || []).push(e); },
    async engineSetInitials(who, initials) { db.people = (db.people || []).filter((p) => p.who !== who).concat([{ who, initials }]); },
    async engineConnectedTokens() { return clone(db.tokens); },
    async enginePageToken({ who, account_key }) { return clone(db.tokens.find((t) => t.who === who && t.account_key === account_key) || null); },
    async enginePauses() { return clone(db.pauses || []); },
    async enginePosts({ team_ids } = {}) { return clone((db.posts || []).filter((p) => !team_ids || team_ids.includes(p.team_id))); },
    async engineInbox({ team_ids, statuses, thread_id, platform, kind, author_id, since }) {
      const rows = db.inbox.filter((r) => (!team_ids || team_ids.includes(r.team_id)) && (!statuses || statuses.includes(r.status)) && (!thread_id || r.thread_id === thread_id) && (!platform || r.platform === platform) && (!kind || r.kind === kind) && (!author_id || r.author_id === author_id) && (!since || r.created_at >= since) && !r.deleted_at);
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
    async engineInboxAlerts({ team_ids, statuses, since }) { return clone(db.alerts.filter((a) => team_ids.includes(a.team_id) && (!statuses || statuses.includes(a.status)) && (!since || a.at >= since))); },
    async engineInsertInboxAlert(row) { const a = { id: db.alerts.length + 1, status: 'open', ...row }; db.alerts.push(a); return clone(a); },
    async engineUpdateInboxAlert(id, team, fields) { const a = db.alerts.find((x) => x.id === id && x.team_id === team); if (!a) return null; Object.assign(a, fields); return clone(a); },
    async engineAutomations({ team_ids }) { return clone(db.autos.filter((a) => team_ids.includes(a.team_id))); },
    async engineInsertAutomation(row) { const a = { id: db.autos.length + 1, active: true, ...row }; db.autos.push(a); return clone(a); },
    async engineUpdateAutomation(id, team, fields) { const i = db.autos.findIndex((a) => a.id === id && a.team_id === team); if (i < 0) return null; if (fields === null) return db.autos.splice(i, 1)[0]; Object.assign(db.autos[i], fields); return clone(db.autos[i]); },
    async engineInboxAutomationUnchecked({ team_ids, since }) { return clone(db.inbox.filter((r) => team_ids.includes(r.team_id) && r.kind === 'comment' && r.platform === 'facebook' && !r.from_us && !r.automation_checked_at && r.created_at >= since)); },
    async engineInboxRules({ team_ids }) { return clone(db.rules.filter((r) => team_ids.includes(r.team_id))); },
    async engineInboxUnchecked({ team_ids, since }) { return clone(db.inbox.filter((r) => team_ids.includes(r.team_id) && r.kind === 'comment' && !r.from_us && !r.auto_checked_at && r.created_at >= since)); },
    async engineInsertInboxRule(row) { const r = { id: db.rules.length + 1, ...row }; db.rules.push(r); return clone(r); },
    async engineDeleteInboxRule(id, team) { const i = db.rules.findIndex((r) => r.id === id && r.team_id === team); if (i < 0) return null; return db.rules.splice(i, 1)[0]; },
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
    if (path === '105/tagged') return ok({ data: [{ id: '999_1', message: 'Proud to stand with @Citizen GO UK today', from: { id: 'p9', name: 'St Mary\'s Parish' }, created_time: '2026-11-03T08:00:00+0000', permalink_url: 'https://fb/999_1' }, { id: '999_0', message: 'old', from: { id: 'p8' }, created_time: '2026-09-01T08:00:00+0000' }] });
    if (path === '178/tags') return ok({ data: [{ id: 'igt1', caption: 'With @citizengo_uk at the vigil', username: 'anna_prays', timestamp: '2026-11-02T20:00:00+0000', permalink: 'https://ig/t1' }] });
    if (path === 'c1/comments') return ok({ id: 'c1_reply' });
    if (path === 'c9' && params.is_hidden === 'true') return ok({ success: true });
    if (path === '105/messages') return ok({ recipient_id: 'psid7', message_id: 'mid.1' });
    if (path === '105/blocked') return ok({ [params.user]: true });
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
  eq('collector: Facebook posts and ads, Instagram comments and replies, Messenger, and mentions, within 7 days', [t1.accounts, t1.skipped, t1.mentions, s.db.inbox.map((r) => r.id).sort()], [2, 0, 2, ['fbc_c1', 'fbc_c2', 'fbc_c9', 'fbm_mm1', 'fbm_mm2', 'fbt_999_1', 'igc_i1', 'igc_i2', 'igt_igt1'].sort()]);
  eq('mentions: who tagged us, where, and a link to their post', ['fbt_999_1', 'igt_igt1'].map((id) => { const r = s.db.inbox.find((x) => x.id === id); return [r.kind, r.author_name, r.post_url]; }), [['mention', "St Mary's Parish", 'https://fb/999_1'], ['mention', 'anna_prays', 'https://ig/t1']]);
  eq('mentions: no replying on someone else\'s post; done and labels work', [I.allowed({ kind: 'mention', platform: 'facebook' }, 'reply', { text: 'hi' }).ok, I.allowed({ kind: 'mention', platform: 'facebook' }, 'done').ok], [false, true]);
  eq('collector: our own comments arrive done, the ad is marked, nothing is posted to Meta', [s.db.inbox.filter((r) => r.status === 'done').map((r) => r.id).sort(), s.db.inbox.find((r) => r.id === 'fbc_c9').is_ad, meta.calls.every((c) => c.method === 'GET')], [['fbc_c2', 'fbm_mm2', 'igc_i2'], true, true]);

  // People's columns survive a re-read.
  eq('tool: an open inbox with counts', (await call(s, 'engine_inbox', { team: 'uk' }, 'sam')).counts, { open: 6, facebook: 4, instagram: 2, messages: 1, mentions: 2, mine: 0, fb_comments: 2, messenger: 1, ig_comments: 1, ig_dms: 0, flagged: 0 });
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

  // Supporter history and By post (the fake Meta's dates are relative to 3 Nov; shift them to now).
  const shift = Date.now() - NOW;
  for (const r of s.db.inbox) r.created_at = new Date(Date.parse(r.created_at) + shift).toISOString();
  const person = await call(s, 'engine_inbox_person', { team: 'uk', author_id: 'u1' }, 'sam');
  eq('supporter history: Margaret\'s comments, counts and labels', [person.author_name, person.counts, person.recent.map((r) => r.id)], ['Margaret T.', { comments: 1, messages: 0, hidden: 0, on_ads: 0 }, ['fbc_c1']]);
  const bp = await call(s, 'engine_inbox_posts', { team: 'uk' }, 'sam');
  eq('by post: comments grouped by post or ad, ours counted apart, ads can be picked out', [bp.posts.map((p) => [p.thread_id, p.comments, p.open, p.ours, p.is_ad]), (await call(s, 'engine_inbox_posts', { team: 'uk', ads: true }, 'sam')).posts.map((p) => p.thread_id)],
    [[['105_9', 1, 1, 0, true], ['105_1', 1, 0, 1, false], ['m1', 1, 0, 1, false]], ['105_9']]);
  eq('by post: another team cannot look', await callErr(s, 'engine_inbox_posts', { team: 'uk' }, 'tamara'), 'ENGINE_NOT_MEMBER');

  // Auto-hide list.
  {
    const R = [{ kind: 'scams' }, { kind: 'links' }, { kind: 'word', value: 'idiot' }];
    eq('auto-hide matching: scams, outside links and whole words; our links and look-alike words pass',
      ['WhatsApp me for profits', 'see cheap-pills.xyz', 'you idiot', 'idiotic take', 'Sign: cgo.ac/x and citizengo.org/a'].map((t) => !!I.matchRules(t, R)), [true, true, true, false, false]);
    const a = engine();
    a.db.members = [{ team_id: 'uk', who: 'chris', role: 'admin' }, { team_id: 'uk', who: 'sam', role: 'editor' }];
    eq('rules: an editor cannot change the list; an admin can; duplicates refused', [(await call(a, 'engine_inbox_rule', { action: 'add', team: 'uk', kind: 'scams' }, 'sam')).ok, (await call(a, 'engine_inbox_rule', { action: 'add', team: 'uk', kind: 'scams' }, 'chris')).ok, (await call(a, 'engine_inbox_rule', { action: 'add', team: 'uk', kind: 'scams' }, 'chris')).ok], [false, true, false]);
    await call(a, 'engine_inbox_rule', { action: 'add', team: 'uk', kind: 'word', value: 'Rubbish' }, 'chris');
    eq('rules: everyone in the team sees the list', (await call(a, 'engine_inbox_rules', { team: 'uk' }, 'sam')).rules.map((r) => r.kind), ['scams', 'word']);
    const meta2 = fakeMeta();
    const t = await collect.run({ store: a, privateKey: keys.privateKey, live: true, now: NOW, log: () => {}, fetchImpl: meta2.fetchImpl });
    const hides = a.db.actions.filter((x) => x.action === 'hide');
    eq('auto-hide: "Rubbish" is queued to hide as chris (the rule\'s maker), labelled, at once; nothing else', [t.auto_hidden, hides.map((h) => [h.item_id, h.by, h.detail.auto, h.status]), a.db.inbox.find((r) => r.id === 'fbc_c9').labels], [1, [['fbc_c9', 'chris', true, 'queued']], ['auto-hidden']]);
    const again = await collect.run({ store: a, privateKey: keys.privateKey, live: true, now: NOW + 60_000, log: () => {}, fetchImpl: meta2.fetchImpl });
    eq('auto-hide: each comment is checked once', [again.auto_hidden, a.db.actions.filter((x) => x.action === 'hide').length], [0, 1]);
    const w = await worker.run({ store: a, privateKey: keys.privateKey, live: true, now: NOW + 1000, log: () => {}, fetchImpl: meta2.fetchImpl });
    eq('auto-hide: the worker hides it on Facebook', [w.sent, a.db.inbox.find((r) => r.id === 'fbc_c9').hidden], [1, true]);
  }

  // Pile-on alert.
  {
    const now = Date.now(), at = (min) => new Date(now - min * 60_000).toISOString();
    const c = (thread, min, text, i) => ({ id: `x${thread}${i}`, team_id: 'uk', account_key: 'uk-fb', platform: 'facebook', kind: 'comment', thread_id: thread, post_text: 'Isabel', created_at: at(min), text, from_us: false });
    const usual = Array.from({ length: 20 }, (_, i) => c('old', 600 + i * 60, 'Praying 🙏', i)); // one comment an hour on an old post
    const calm = Array.from({ length: 12 }, (_, i) => c('calm', 10 + i, 'Amen, praying for her', i));
    const storm = Array.from({ length: 12 }, (_, i) => c('storm', 5 + i, i % 2 ? 'You bigots are disgusting' : 'Shame on you', i));
    eq('pile-on: a burst of mostly hostile comments is flagged; a burst of kind ones is not', I.pileOns(usual.concat(calm, storm), [], now).map((p) => [p.thread_id, p.comments_hour, p.hostile_hour, p.baseline]), [['storm', 12, 12, 1]]);
    eq('pile-on: under 10 in the hour is not a pile-on', I.pileOns(usual.concat(storm.slice(0, 9)), [], now).length, 0);
    const pa = engine();
    pa.db.inbox = usual.concat(storm).map((r) => ({ ...r, status: 'open', labels: [] }));
    const r1 = await collect.run({ store: pa, privateKey: keys.privateKey, live: true, now, log: () => {}, fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }) });
    const r2 = await collect.run({ store: pa, privateKey: keys.privateKey, live: true, now: now + 600_000, log: () => {}, fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }) });
    eq('pile-on: one alert, not repeated within 6 hours', [r1.pile_ons, r2.pile_ons, pa.db.alerts.length], [1, 0, 1]);
    const inboxNow = await call(pa, 'engine_inbox', { team: 'uk' }, 'sam');
    eq('pile-on: shown with the inbox; marking it seen clears it for the team', [inboxNow.alerts.length, (await call(pa, 'engine_inbox_alert', { team: 'uk', id: 1 }, 'sam')).ok, (await call(pa, 'engine_inbox', { team: 'uk' }, 'chris')).alerts.length], [1, true, 0]);
  }

  // Bulk by topic.
  {
    const b = engine();
    await collect.run({ store: b, privateKey: keys.privateKey, live: true, now: NOW, log: () => {}, fetchImpl: fakeMeta().fetchImpl });
    eq('bulk: nothing picked, or no reply text, is refused', [(await call(b, 'engine_inbox_bulk', { ids: [], action: 'done' }, 'chris')).ok, (await call(b, 'engine_inbox_bulk', { ids: ['fbc_c1'], action: 'reply' }, 'chris')).ok], [false, false]);
    const lab = await call(b, 'engine_inbox_bulk', { ids: ['fbc_c1', 'fbc_c9', 'igc_i1'], action: 'label', labels: ['petition'] }, 'sam');
    eq('bulk: desk actions on many at once, no rights needed', [lab.done, lab.refused, ['fbc_c1', 'fbc_c9', 'igc_i1'].map((id) => b.db.inbox.find((r) => r.id === id).labels)], [3, [], [['petition'], ['petition'], ['petition']]]);
    const rep = await call(b, 'engine_inbox_bulk', { ids: ['fbc_c1', 'fbc_c9', 'igc_i1', 'fbm_mm1'], action: 'reply', texts: ['Thank you 🙏', 'Thanks for standing with us'] }, 'chris');
    const q = b.db.actions.filter((a) => a.action === 'reply');
    eq('bulk replies: wording rotates, a DM is left to answer by hand, 30 seconds to undo', [rep.done, rep.refused.map((r) => r.id), q.map((a) => a.text), Date.parse(q[0].run_after) - Date.parse(q[0].created_at) >= 29000], [3, ['fbm_mm1'], ['Thank you 🙏', 'Thanks for standing with us', 'Thank you 🙏'], true]);
    eq('bulk likes: Instagram refused by the rule, Facebook queued', (await call(b, 'engine_inbox_bulk', { ids: ['fbc_c1', 'igc_i1'], action: 'like' }, 'chris')).refused.map((r) => r.id), ['igc_i1']);
    eq('bulk: sam has no rights, so every Meta action is refused, none queued', [(await call(b, 'engine_inbox_bulk', { ids: ['fbc_c1', 'fbc_c9'], action: 'hide' }, 'sam')).refused.length, b.db.actions.filter((a) => a.action === 'hide').length], [2, 0]);
    const u = await call(b, 'engine_inbox_undo', { action_ids: rep.action_ids }, 'chris');
    eq('bulk undo: the whole batch is cancelled at once', [u.undone, b.db.actions.filter((a) => a.action === 'reply').every((a) => a.status === 'cancelled')], [3, true]);
  }

  // Comment-to-DM automations.
  {
    eq('automation keywords: whole words, any case or accent; not inside other words, not replies, not Instagram', [
      I.automationFor({ kind: 'comment', platform: 'facebook', text: 'Where do I SIGN?' }, [{ active: true, keywords: ['sign'] }]) !== null,
      I.automationFor({ kind: 'comment', platform: 'facebook', text: 'bad signal' }, [{ active: true, keywords: ['sign'] }]),
      I.automationFor({ kind: 'comment', platform: 'facebook', text: 'sign', parent_id: 'x' }, [{ active: true, keywords: ['sign'] }]),
      I.automationFor({ kind: 'comment', platform: 'instagram', text: 'sign' }, [{ active: true, keywords: ['sign'] }]),
      I.automationFor({ kind: 'comment', platform: 'facebook', text: 'Pétition!' }, [{ active: true, keywords: ['petition'] }]) !== null,
    ], [true, null, null, null, true]);
    const m = engine();
    eq('automations: editors cannot add; [ACTION LINK] refused; an admin with a Page right can', [
      (await call(m, 'engine_automation', { action: 'add', team: 'uk', name: 'Sign', keywords: ['sign'], dm_text: 'Here: cgo.ac/x' }, 'sam')).ok,
      (await call(m, 'engine_automation', { action: 'add', team: 'uk', name: 'Sign', keywords: ['sign'], dm_text: 'Here: [ACTION LINK]' }, 'chris')).ok,
      (await call(m, 'engine_automation', { action: 'add', team: 'uk', name: 'Sign', keywords: ['SIGN', 'petition'], dm_text: 'Thank you! Sign here: cgo.ac/x', reply_text: 'Sent you the link 💌' }, 'chris')).automations.length,
    ], [false, false, 1]);
    const t = new Date(NOW - 3600e3).toISOString();
    m.db.inbox.push({ id: 'fbc_s1', team_id: 'uk', account_key: 'uk-fb', platform: 'facebook', kind: 'comment', thread_id: '105_1', object_id: 's1', text: 'How do I sign?', created_at: t, from_us: false, status: 'open', labels: [] },
      { id: 'fbc_s2', team_id: 'uk', account_key: 'uk-fb', platform: 'facebook', kind: 'comment', thread_id: '105_1', object_id: 's2', text: 'Great signal', created_at: t, from_us: false, status: 'open', labels: [] });
    const quiet = async () => ({ ok: true, json: async () => ({ data: [] }) });
    const r1 = await collect.run({ store: m, privateKey: keys.privateKey, live: true, now: NOW, log: () => {}, fetchImpl: quiet });
    const r2 = await collect.run({ store: m, privateKey: keys.privateKey, live: true, now: NOW + 60e3, log: () => {}, fetchImpl: quiet });
    eq('automations: "sign" gets the private message and the public reply as chris, once; "signal" gets nothing', [r1.automations, r2.automations, m.db.actions.map((a) => [a.item_id, a.action, a.by, a.status])], [1, 0, [['fbc_s1', 'private_reply', 'chris', 'queued'], ['fbc_s1', 'reply', 'chris', 'queued']]]);
    // A petition post the engine published: "SIGN" works on it with no rule; the same person again just gets a like; Pause everything holds it.
    m.db.posts = [{ id: 'uk-p9', team_id: 'uk', title: 'Isabel', status: 'posted', doc: { action: { url: 'https://citizengo.org/isabel' }, links: { facebook: { short: 'https://cgo.ac/isa' } }, published: { 'uk-fb': { id: '105_9', by: 'chris' } } } }];
    const cm = (id, aid) => ({ id, team_id: 'uk', account_key: 'uk-fb', platform: 'facebook', kind: 'comment', thread_id: '105_9', object_id: id, author_id: aid, text: 'SIGN', created_at: t, from_us: false, status: 'open', labels: [] });
    m.db.pauses = [{ id: 1, scope: 'all', paused_by: 'chris', reason: 'test', paused_at: t }];
    m.db.inbox.push(cm('fbc_p1', 'u1'));
    const held = await collect.run({ store: m, privateKey: keys.privateKey, live: true, now: NOW + 90e3, log: () => {}, fetchImpl: quiet });
    m.db.pauses = [];
    const n0 = m.db.actions.length;
    const r3 = await collect.run({ store: m, privateKey: keys.privateKey, live: true, now: NOW + 120e3, log: () => {}, fetchImpl: quiet });
    m.db.inbox.push(cm('fbc_p2', 'u1'));
    await collect.run({ store: m, privateKey: keys.privateKey, live: true, now: NOW + 180e3, log: () => {}, fetchImpl: quiet });
    eq('flow: SIGN on a petition draft DMs its link; held while paused; a second SIGN from them is a like', [held.automations, r3.automations, m.db.actions.slice(n0).map((a) => [a.item_id, a.action, a.by, (a.text || '').includes('cgo.ac/isa')])],
      [0, 1, [['fbc_p1', 'private_reply', 'chris', true], ['fbc_p2', 'like', 'chris', false]]]);
    const fm = fakeMeta();
    const w = await worker.run({ store: m, privateKey: keys.privateKey, live: true, now: NOW + 1000, log: () => {}, fetchImpl: fm.fetchImpl });
    eq('automations: the worker sends the private reply to the comment (Meta\'s one per comment)', [fm.calls.filter((c) => c.path === '105/messages').map((c) => JSON.parse(c.params.recipient).comment_id), w.sent >= 1], [['s1'], true]);

    // Team and access [gaps §7].
    const acc0 = await call(m, 'engine_access', { action: 'list', team: 'uk' }, 'chris');
    const sam1 = await call(m, 'engine_access', { action: 'limit', team: 'uk', who: 'chris', account_key: 'uk-fb', reply: false }, 'sam');
    const lim = await call(m, 'engine_access', { action: 'limit', team: 'uk', who: 'chris', account_key: 'uk-fb', reply: false }, 'chris');
    const me = lim.people.find((p) => p.who === 'chris').accounts.find((a) => a.key === 'uk-fb');
    const ini = [await call(m, 'engine_access', { action: 'initials', team: 'uk', initials: 'c' }, 'sam'), await call(m, 'engine_access', { action: 'initials', team: 'uk', initials: 'sjb' }, 'sam'), await call(m, 'engine_access', { action: 'initials', team: 'uk', who: 'chris', initials: 'CJO' }, 'sam')];
    eq('access: editors cannot narrow; an admin narrows reply on one Page; initials are 2-3 letters, your own or (admins) anyone\'s', [
      acc0.can_edit, sam1.ok, [me.post, me.reply, me.moderate, me.narrowed], ini.map((r) => r.ok), (m.db.people || []).find((p) => p.who === 'sam').initials,
    ], [true, false, [true, false, true, ['reply']], [false, true, false], 'SJB']);
    const firstFb = m.db.inbox.find((i) => i.account_key === 'uk-fb' && i.kind === 'comment' && !i.from_us);
    const blocked = await call(m, 'engine_inbox_act', { id: firstFb.id, action: 'reply', text: 'Thanks' }, 'chris');
    await call(m, 'engine_access', { action: 'limit', team: 'uk', who: 'chris', account_key: 'uk-fb', reply: true }, 'chris');
    eq('access: a narrowed reply is refused; turning it back on restores what Facebook allows', [blocked.ok, (m.db.limits || []).length], [false, 0]);
    eq('copilot link: refuses incomplete args; signed out is a clear error', [
      (await call(m, 'engine_copilot_link', { args: { assetType: 'petition' } }, 'chris')).ok,
      (await call(m, 'engine_copilot_link', { args: { assetType: 'petition', petitionId: 1, ctaFamilyCode: 'AA', platformCode: 'fb', seriesFlow: 'FB1', listCode: 'EN_GB', topicCode: 'FM', scopeCode: 'LO', campaignTitle: 'T' } }, 'chris')).error.includes('copilot:adopt'),
    ], [false, true]);
    // The flow builder [gaps §5].
    const A = (x) => ({ active: true, keywords: ['sign'], ...x });
    const c = { kind: 'comment', platform: 'facebook', text: 'sign me up', thread_id: 't1' };
    eq('flow: the most specific rule wins (post, then post type, then all); Instagram only when ticked', [
      I.automationFor(c, [A({ id: 1 }), A({ id: 2, scope: 'type', post_type: 'petition' }), A({ id: 3, thread_id: 't1' })], { postType: 'petition' }).id,
      I.automationFor(c, [A({ id: 1 }), A({ id: 2, scope: 'type', post_type: 'petition' })], { postType: 'petition' }).id,
      I.automationFor(c, [A({ id: 1 }), A({ id: 2, scope: 'type', post_type: 'prayer' })], { postType: 'petition' }).id,
      I.automationFor({ ...c, platform: 'instagram' }, [A({ id: 1 })]),
      I.automationFor({ ...c, platform: 'instagram' }, [A({ id: 1, platforms: ['facebook', 'instagram'] })]).id,
    ], [3, 2, 1, null, 1]);
    eq('flow: public replies take turns; the check refuses a type rule with no type', [
      [0, 1, 2].map((n) => I.automationReply({ reply_texts: ['a', 'b'] }, n)), I.automationReply({ reply_text: 'x' }, 3),
      I.checkAutomation({ name: 'x', keywords: ['sign'], dm_text: 'cgo.ac/x', scope: 'type' }).ok,
      I.checkAutomation({ name: 'x', keywords: ['sign'], dm_text: 'cgo.ac/x', scope: 'type', post_type: 'reel', platforms: ['instagram'] }).value.platforms,
    ], [['a', 'b', 'a'], 'x', false, ['instagram']]);
    eq('flow: post types and the SIGN set on a petition draft (on by default, untickable)', [
      E.postType({ action: { url: 'https://citizengo.org/x' } }), E.postType({ card: { template: 'agenda' } }), E.postType({ card: { template: 'newsbox' } }), E.postType({ card: { template: 'reel' } }),
      E.draftCommentDm({ action: { url: 'https://citizengo.org/x' }, links: { facebook: { short: 'https://cgo.ac/abc' } } }).dm.includes('https://cgo.ac/abc'),
      E.draftCommentDm({ action: { url: 'https://citizengo.org/x' }, commentDm: { on: false } }),
      E.draftCommentDm({ action: { url: 'https://citizengo.org/x' }, posting: { comment_dm: false } }),
    ], ['petition', 'prayer', 'news', 'reel', true, null, null]);
    const paused = await call(m, 'engine_automation', { action: 'pause', team: 'uk', id: 1 }, 'chris');
    eq('automations: pause, and the list shows the last 7 days', [paused.automations[0].active, typeof paused.automations[0].last_7_days.queued], [false, 'number']);
  }

  // Gaps §4: channel counts, people to assign to, ban, threats.
  {
    const g = engine();
    await collect.run({ store: g, privateKey: keys.privateKey, live: true, now: NOW, log: () => {}, fetchImpl: fakeMeta().fetchImpl });
    const r = await call(g, 'engine_inbox', { team: 'uk' }, 'chris');
    eq('channel counts and the people who can reply', [r.counts.fb_comments, r.counts.messenger, r.counts.ig_comments, r.counts.ig_dms, r.people.map((p) => [p.who, p.accounts])], [2, 1, 1, 0, [['chris', ['uk-fb', 'uk-ig']], ['sam', []]]]);
    eq('ban: Facebook only; never ourselves', [I.allowed({ kind: 'comment', platform: 'facebook', author_id: 'u9' }, 'ban').ok, I.allowed({ kind: 'comment', platform: 'instagram', author_id: 'u9' }, 'ban').ok, I.allowed({ kind: 'comment', platform: 'facebook', from_us: true, author_id: '105' }, 'ban').ok], [true, false, false]);
    eq('threats are hidden, never deleted', [I.allowed({ kind: 'comment', platform: 'facebook', labels: ['threat'] }, 'delete', {}).ok, I.allowed({ kind: 'comment', platform: 'facebook', labels: ['threat'] }, 'hide', {}).ok], [false, true]);
    const b = await call(g, 'engine_inbox_act', { id: 'fbc_c9', action: 'ban' }, 'chris');
    const fm = fakeMeta();
    await worker.run({ store: g, privateKey: keys.privateKey, live: true, now: Date.now() + 20_000, log: () => {}, fetchImpl: fm.fetchImpl });
    eq('ban goes to the Page\'s blocked list for that author', [b.ok, fm.calls.filter((c) => c.path === '105/blocked').map((c) => c.params.user)], [true, ['u9']]);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
