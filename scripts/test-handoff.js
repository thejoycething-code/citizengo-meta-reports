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
  await asanaTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

// The Mini's Asana pass against an in-memory engine and a fake Asana.
async function asanaTests() {
  const A = require('../lib/asana');
  const { run } = require('../collector/publish');
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const db = {
    posts: [{ id: 'uk-1', team_id: 'uk', status: 'scheduled', version: 1, post_at: '2026-11-09T12:00:00Z', doc: {
      title: 'Red Week begins', altText: 'Candle on black',
      platforms: { x: ['X one', 'X two'] },
      final: { facebook: { text: 'FB copy https://cgo.ac/abc', comment: 'Find an event', media: ['uk/uk-1/facebook-0.jpg'] }, instagram: { text: 'IG copy', comment: '', media: ['uk/uk-1/instagram-0.jpg'] } },
      posting: { destinations: ['uk-fb', 'sc-fb', 'uk-ig', 'uk-x'], at: '2026-11-09T12:00:00Z', handoff: { at: '2026-11-08T23:00:00Z', by: 'chris' } } } }],
    events: [],
  };
  const store = {
    async engineTeams() { return [team]; },
    async enginePosts({ statuses } = {}) { return clone(db.posts.filter((p) => !statuses || statuses.includes(p.status))); },
    async enginePost(id) { const p = db.posts.find((x) => x.id === id); return p ? clone(p) : null; },
    async engineUpdatePost(id, version, fields) { const p = db.posts.find((x) => x.id === id && x.version === version); if (!p) return null; Object.assign(p, fields, { version: version + 1 }); return clone(p); },
    async engineEvent(r) { db.events.push(r); },
    async enginePauses() { return []; },
    async engineMediaDownload(path) { return Buffer.from('jpeg:' + path); },
    async engineCacheSet() {},
  };
  const calls = [];
  let completed = false;
  const fields = (proj) => [{ custom_field: { gid: `ps-${proj}`, name: 'Post Status', resource_subtype: 'enum', enum_options: [{ gid: `ready-${proj}`, name: 'Ready to Post' }, { gid: `progress-${proj}`, name: 'In Progress' }, { gid: `done-${proj}`, name: 'Scheduled // Posted' }, { gid: `cx-${proj}`, name: 'Cancelled' }] } },
    { custom_field: { gid: `ct-${proj}`, name: 'Content Type', resource_subtype: 'enum', enum_options: [{ gid: `img-${proj}`, name: 'Image' }] } },
    { custom_field: { gid: `pl-${proj}`, name: 'Post link', resource_subtype: 'text' } }];
  const asanaFetch = async (url, opts = {}) => {
    const u = new URL(url); const m = opts.method || 'GET';
    const body = opts.body && typeof opts.body === 'string' ? JSON.parse(opts.body).data : (opts.body ? '[form]' : null);
    calls.push({ m, path: u.pathname, body });
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
    let mm;
    if ((mm = u.pathname.match(/projects\/(\d+)\/custom_field_settings/))) return ok(fields(mm[1]));
    if (u.pathname.match(/projects\/\d+\/sections/)) return ok([{ gid: 'sec-ts', name: 'To Schedule' }]);
    if (m === 'POST' && u.pathname.endsWith('/tasks')) return ok({ gid: 'T1', permalink_url: 'https://app.asana.com/0/0/T1' });
    if (m === 'GET' && u.pathname.endsWith('/tasks/T1')) return ok(u.searchParams.get('opt_fields').includes('memberships') ? { memberships: [{ project: { gid: A.CALENDARS['uk-fb'].project } }, { project: { gid: A.CALENDARS['sc-fb'].project } }, { project: { gid: A.CALENDARS['uk-ig'].project } }, { project: { gid: A.CALENDARS['uk-x'].project } }] } : { completed, completed_at: completed ? '2026-11-09T12:05:00Z' : null, custom_fields: completed ? [{ name: 'Post link', text_value: 'https://www.facebook.com/105/posts/9' }, { name: 'Post link', text_value: 'https://x.com/CitizenGO_GB/status/1' }, { name: 'Post link', text_value: null }] : [] });
    return ok({});
  };
  const opts = { store, privateKey: 'x', live: true, now: Date.parse('2026-11-09T10:00:00Z'), log: () => {}, asanaToken: 'tok', asanaFetch };

  const t = A.taskFor(db.posts[0]);
  eq('task: image emoji and title', t.name, '🖼️ Red Week begins');
  eq('task: due at the post time', t.due_at, '2026-11-09T12:00:00.000Z');
  eq('task: four calendars', t.calendars.map((c) => c.key), ['uk-fb', 'sc-fb', 'uk-ig', 'uk-x']);
  eq('task: says UK + Scotland is one post with a collaborator', /Citizen GO Scotland as collaborator/.test(t.html_notes), true);
  eq('task: copy, first comment, X thread, alt text and desk link', ['FB copy https://cgo.ac/abc', 'Find an event', 'Post 2: X two', 'Candle on black', 'desk/#uk-1'].map((x) => t.html_notes.includes(x)), [true, true, true, true, true]);

  await run(opts);
  let p = db.posts[0];
  eq('create: one task, recorded on the post', [p.doc.posting.asanaTaskGid, p.doc.posting.asanaUrl], ['T1', 'https://app.asana.com/0/0/T1']);
  eq('create: added to the other three calendars', calls.filter((c) => /addProject/.test(c.path)).length, 4);
  eq('create: Ready to Post on every calendar', ['uk-fb', 'sc-fb', 'uk-ig', 'uk-x'].every((k) => (calls.find((c) => c.m === 'PUT' && c.body && c.body.custom_fields) || { body: { custom_fields: {} } }).body.custom_fields[`ps-${A.CALENDARS[k].project}`] === `ready-${A.CALENDARS[k].project}`), true);
  eq('create: both images attached', calls.filter((c) => c.path.endsWith('/attachments')).length, 2);
  eq('create: still Handed off', p.status, 'scheduled');

  calls.length = 0;
  await run(opts);
  eq('next run: nothing new while the task is open', calls.filter((c) => c.m !== 'GET').length, 0);

  db.posts[0].doc.final.facebook.text = 'FB copy, edited';
  calls.length = 0;
  await run(opts);
  eq('edit on the desk: the task is updated, not remade', [calls.filter((c) => c.m === 'POST' && c.path.endsWith('/tasks')).length, calls.filter((c) => c.m === 'PUT' && c.path.endsWith('/tasks/T1') && c.body.html_notes && c.body.html_notes.includes('FB copy, edited')).length], [0, 1]);

  completed = true;
  await run(opts);
  p = db.posts[0];
  eq('task completed: post marked Posted', p.status, 'posted');
  eq('task completed: links filed by account', [p.doc.published['uk-fb'].url, p.doc.published['sc-fb'].url, p.doc.published['uk-x'].url, !!p.doc.published['uk-ig'].url], ['https://www.facebook.com/105/posts/9', 'https://www.facebook.com/105/posts/9', 'https://x.com/CitizenGO_GB/status/1', false]);
  eq('task completed: the run looks for the missing link', p.doc.posted.linksPending, true);

  // Sent back to To review: the open task is cancelled.
  completed = false;
  db.posts.push({ id: 'uk-2', team_id: 'uk', status: 'review', version: 1, post_at: null, doc: { title: 'B', posting: { destinations: ['uk-fb'], handoff: { at: 'x', by: 'chris' }, asanaTaskGid: 'T1', asanaUrl: 'u', asanaSig: 's' } } });
  calls.length = 0;
  await run(opts);
  const p2 = db.posts[1];
  eq('taken back: task set to Cancelled with a comment', [calls.some((c) => c.m === 'PUT' && c.body && c.body.custom_fields && Object.values(c.body.custom_fields).some((v) => /^cx-/.test(v))), calls.some((c) => /stories$/.test(c.path))], [true, true]);
  eq('taken back: the post forgets the task', [p2.doc.posting.asanaTaskGid, p2.doc.posting.asanaOldTask], [null, 'T1']);

  // In Editing: an In Progress task early, switched to Ready to Post on hand-off.
  const ed = { id: 'uk-3', team_id: 'uk', status: 'hold', version: 1, post_at: null, doc: { title: 'Red Wednesday',
    final: { facebook: { text: 'FB', media: [] } }, posting: { destinations: ['uk-fb'], suggestedAt: '2026-11-18T08:00:00Z' } } };
  db.posts.push(ed);
  eq('editing: stage In Progress', A.stageOf(ed), 'progress');
  eq('editing: task says not to post yet, due at the suggested time', [/don't post yet/.test(A.taskFor(ed).html_notes), A.taskFor(ed).due_at], [true, '2026-11-18T08:00:00.000Z']);
  calls.length = 0;
  await run(opts);
  const e1 = db.posts.find((x) => x.id === 'uk-3');
  eq('editing: task made, In Progress', [e1.doc.posting.asanaTaskGid, e1.doc.posting.asanaStage, calls.some((c) => c.m === 'PUT' && c.body && c.body.custom_fields && Object.values(c.body.custom_fields).includes('progress-' + A.CALENDARS['uk-fb'].project))], ['T1', 'progress', true]);
  calls.length = 0;
  await run(opts);
  eq('editing: nothing to do while it stays in Editing', calls.filter((c) => c.m !== 'GET').length, 0);
  Object.assign(e1, { status: 'scheduled', post_at: '2026-11-18T08:00:00Z' });
  e1.doc.posting.handoff = { at: 'x', by: 'chris' }; e1.doc.posting.at = '2026-11-18T08:00:00Z';
  db.posts[db.posts.findIndex((x) => x.id === 'uk-3')] = e1;
  calls.length = 0;
  await run(opts);
  const e2 = db.posts.find((x) => x.id === 'uk-3');
  eq('hand-off: same task, now Ready to Post', [calls.filter((c) => c.m === 'POST' && c.path.endsWith('/tasks')).length, e2.doc.posting.asanaStage, calls.some((c) => c.m === 'PUT' && c.body && c.body.custom_fields && Object.values(c.body.custom_fields).includes('ready-' + A.CALENDARS['uk-fb'].project))], [0, 'ready', true]);

  // No token (the cloud backup): no Asana at all.
  calls.length = 0;
  await run({ ...opts, asanaToken: null });
  eq('no token: no Asana calls', calls.length, 0);
}
