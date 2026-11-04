'use strict';
// Content Engine tools (Phase 2, Nov 2026): the posts desk and calendar.
//
// The desk is a claude.ai artifact that calls these through the viewer's own
// "CitizenGO Organic Meta" connector, so `who` is always the real person and
// every rule in lib/engine.js is applied here, on the server, never trusted
// to the page. The daily engine creates posts with engine_create the same way.
//
// All replies are JSON (raw: true): the desk machine-reads them, and the
// staleness banner would corrupt them.

const E = require('../lib/engine');
const T = require('../lib/tracked');
const copilot = require('../lib/copilot');

const json = (obj) => ({ raw: true, text: JSON.stringify(obj) });
const err = (message, code = 'ENGINE_REFUSED') => { const e = new Error(message); e.code = code; return e; };

async function context(store, who) {
  if (!E.signedIn(who)) throw err('Sign in to use the Content Engine.', 'ENGINE_SIGN_IN');
  const [teams, members] = await Promise.all([store.engineTeams(), store.engineMembers({ who })]);
  const myTeams = E.teamsOf(members, who);
  return { who, teams, myTeams, maintainer: E.isMaintainer(who) };
}
const teamById = (ctx, id) => ctx.teams.find((t) => t.id === id) || null;

async function editablePost(store, ctx, id) {
  const post = await store.enginePost(String(id || ''));
  // Not found and not yours look the same: other teams' drafts stay invisible.
  if (!post || !E.canEditTeam(ctx, post.team_id)) throw err('No such post in your teams.', 'ENGINE_NOT_FOUND');
  return post;
}

const lite = (p) => ({
  id: p.id, team_id: p.team_id, status: p.status, title: p.title, post_at: p.post_at,
  version: p.version, updated_at: p.updated_at, updated_by: p.updated_by,
  destinations: E.destinations(p.doc), type: (p.doc && p.doc.type) || null,
  thumb: E.calendarItem(p, { editable: true }).thumb, source_team: p.source_team || null,
  track: track(p.doc || {}),
});

// What the daily engine checks on every run, so it can list the desk without
// reading each whole post (cards and options make those large).
function track(d) {
  const posting = d.posting || {}, posted = d.posted || {}, source = d.source || {};
  return {
    asanaTaskGid: posting.asanaTaskGid || null, syncedAt: posting.syncedAt || null, changedAt: posting.changedAt || null,
    resultsCheckedAt: (d.results && d.results.checkedAt) || null, postedAt: posted.at || null, linksPending: !!posted.linksPending,
    stale: !!d.stale, pack: source.pack || null, requestAt: (source.request && source.request.at) || null,
    requestId: (source.request && source.request.id) || null, evergreenId: source.evergreen_id || null,
    // Post now on the desk: {at, by}. The engine run adds its UK Asana task.
    postNow: (posting.postNow && posting.postNow.at) ? { at: posting.postNow.at, by: posting.postNow.by || null } : null,
  };
}

async function engineMe(store, args, { who }) {
  const ctx = await context(store, who);
  const rights = await store.engineRights({ who });
  return json({
    who, maintainer: ctx.maintainer,
    teams: ctx.teams.filter((t) => E.canEditTeam(ctx, t.id)).map((t) => ({ ...t, role: ctx.myTeams[t.id] || 'maintainer' })),
    all_teams: ctx.teams.map((t) => ({ id: t.id, name: t.name, flag: t.flag })),
    publish_rights: rights.map((r) => r.account_key),
    connected_rights: rights.filter((r) => r.source === 'meta').map((r) => r.account_key),
    pauses: await pausesFor(store, ctx, rights),
  });
}

// Active pauses this person sees, each with whether they may resume it.
async function pausesFor(store, ctx, rights) {
  const open = E.pausesVisible(await store.enginePauses(), { ctx, teams: ctx.teams });
  if (!open.length) return [];
  rights = rights || await store.engineRights({ who: ctx.who });
  return open.map((p) => ({ ...p, can_resume: E.canResume(p, { ctx, teams: ctx.teams, rights }) }));
}

async function enginePause(store, args, { who }) {
  const ctx = await context(store, who);
  const rights = await store.engineRights({ who });
  if (args.action === 'resume') {
    const p = (await store.enginePauses()).find((x) => Number(x.id) === Number(args.id));
    if (!p || !E.pauseActive(p) || !E.pausesVisible([p], { ctx, teams: ctx.teams }).length) return json({ ok: false, error: 'That pause is not on any more.' });
    if (!E.canResume(p, { ctx, teams: ctx.teams, rights })) return json({ ok: false, error: `Only ${p.paused_by}, or someone who can post to all of its accounts, can resume this pause.` });
    const done = await store.engineResumePause(p.id, who);
    if (!done) return json({ ok: false, error: 'That pause is not on any more.' });
    return json({ ok: true, resumed: done, pauses: await pausesFor(store, ctx, rights) });
  }
  if (args.action !== 'pause') return json({ ok: false, error: 'action is pause or resume.' });
  const reason = String(args.reason || '').trim().slice(0, 300);
  if (!reason) return json({ ok: false, error: 'Give a reason: the team sees it.' });
  const hours = args.hours == null ? null : Number(args.hours);
  if (hours != null && !(hours > 0 && hours <= E.PAUSE_MAX_HOURS)) return json({ ok: false, error: `A timed pause is between 1 hour and ${E.PAUSE_MAX_HOURS / 24} days.` });
  const scope = String(args.scope || 'mine');
  const acc = E.pauseAccounts({ scope, team: args.team, ctx, teams: ctx.teams, rights });
  if (!acc.ok) return json({ ok: false, error: acc.error });
  const row = await store.engineInsertPause({
    scope, team_id: scope === 'team' ? String(args.team) : null, account_keys: acc.account_keys, reason, paused_by: who,
    until: hours ? new Date(Date.now() + hours * 3600_000).toISOString() : null,
  });
  return json({ ok: true, pause: row, pauses: await pausesFor(store, ctx, rights) });
}

// When each publisher last checked for due posts (the Mac Mini every 5
// minutes, the cloud backup every 15), for the desk's "Publishing live" chip.
async function publisherCheckins(store) {
  if (typeof store.engineCacheGet !== 'function') return null;
  const out = {};
  for (const r of ['mini', 'cloud']) {
    try { const row = await store.engineCacheGet(`publisher:${r}`); out[r] = row ? { at: row.value && row.value.at || row.computed_at, live: !!(row.value && row.value.live), error: (row.value && row.value.error) || null } : null; } catch (e) { out[r] = null; }
  }
  return out;
}

async function enginePosts(store, args, { who }) {
  const ctx = await context(store, who);
  const team = String(args.team || '');
  if (!E.canEditTeam(ctx, team)) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
  const statuses = args.status ? String(args.status).split(',').map((s) => s.trim()).filter((s) => E.STATUSES.includes(s)) : null;
  const rows = await store.enginePosts({ team_ids: [team], statuses, limit: args.limit });
  return json({ team, posts: args.full ? rows : rows.map(lite), pauses: await pausesFor(store, ctx), publishers: await publisherCheckins(store) });
}

async function enginePost(store, args, { who }) {
  const ctx = await context(store, who);
  return json({ post: await editablePost(store, ctx, args.id) });
}

async function engineSave(store, args, { who }) {
  const ctx = await context(store, who);
  const post = await editablePost(store, ctx, args.id);
  if (Number(args.version) !== Number(post.version)) {
    return json({ ok: false, conflict: true, error: 'Someone saved this post meanwhile. Reload it and redo your change.', post });
  }
  const doc = E.mergeDoc(post.doc, args.patch || {});
  const rights = await store.engineRights({ who, kind: 'post' });
  const allowed = E.saveAllowed({ status: post.status, before: post.doc, after: doc, team: teamById(ctx, post.team_id), rights });
  if (!allowed.ok) return json({ ok: false, error: allowed.error });
  const saved = await store.engineUpdatePost(post.id, post.version, {
    doc, title: String(doc.title || post.title || ''), post_at: E.postAt(doc), updated_by: who,
  });
  if (!saved) return json({ ok: false, conflict: true, error: 'Someone saved this post meanwhile. Reload it and redo your change.' });
  await store.engineEvent({ post_id: post.id, team_id: post.team_id, who, action: 'save', detail: { keys: Object.keys(args.patch || {}), status: post.status } });
  return json({ ok: true, post: saved });
}

// Bookkeeping only (lib/engine.js recordAllowed): the post's content and
// posting plan are untouched, so it works on posted and rejected posts too.
async function engineRecord(store, args, { who }) {
  const ctx = await context(store, who);
  const post = await editablePost(store, ctx, args.id);
  if (Number(args.version) !== Number(post.version)) {
    return json({ ok: false, conflict: true, error: 'Someone saved this post meanwhile. Reload it and redo your change.', post });
  }
  const allowed = E.recordAllowed(args.patch);
  if (!allowed.ok) return json({ ok: false, error: allowed.error });
  const doc = E.mergeDoc(post.doc, args.patch);
  const saved = await store.engineUpdatePost(post.id, post.version, { doc, title: post.title, post_at: post.post_at, updated_by: who });
  if (!saved) return json({ ok: false, conflict: true, error: 'Someone saved this post meanwhile. Reload it and redo your change.' });
  await store.engineEvent({ post_id: post.id, team_id: post.team_id, who, action: 'record', detail: { keys: Object.keys(args.patch) } });
  return json({ ok: true, post: saved });
}

async function engineStatus(store, args, { who }) {
  const ctx = await context(store, who);
  const post = await editablePost(store, ctx, args.id);
  if (Number(args.version) !== Number(post.version)) {
    return json({ ok: false, conflict: true, error: 'Someone changed this post meanwhile. Reload it first.', post });
  }
  const rights = await store.engineRights({ who, kind: 'post' });
  const t = E.transition({ from: post.status, action: args.action, doc: post.doc, team: teamById(ctx, post.team_id), rights, note: args.note });
  if (!t.ok) return json({ ok: false, error: t.error });
  const review = { by: who, at: new Date().toISOString(), action: args.action };
  if (args.note) review.note = String(args.note).slice(0, 2000);
  if (Array.isArray(args.reasons)) review.reasons = args.reasons.map(String).slice(0, 10);
  const doc = E.mergeDoc(post.doc, { review });
  const saved = await store.engineUpdatePost(post.id, post.version, { status: t.status, doc, post_at: E.postAt(doc), updated_by: who });
  if (!saved) return json({ ok: false, conflict: true, error: 'Someone changed this post meanwhile. Reload it first.' });
  await store.engineEvent({ post_id: post.id, team_id: post.team_id, who, action: args.action, detail: { from: post.status, to: t.status, note: review.note || null } });
  return json({ ok: true, post: saved });
}

// Empty the bin: rejected posts go to 'archived' once the morning run has read
// them, i.e. it imported a draft for the team after the rejection (it reads the
// feedback before drafting). Newer rejections wait for the next run. Archived
// posts leave the desk but stay in the store for the run's repeat checks and
// rule learning. action count (default) says how many are ready; empty clears them.
async function engineTrash(store, args, { who }) {
  const ctx = await context(store, who);
  const team = String(args.team || '');
  if (!E.canEditTeam(ctx, team)) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
  const rows = await store.enginePosts({ team_ids: [team], limit: 1000 });
  const learnt = rows.filter((p) => p.created_by === 'import').reduce((m, p) => Math.max(m, Date.parse(p.created_at) || 0), 0);
  const ready = [], waiting = [];
  for (const p of rows.filter((x) => x.status === 'rejected')) {
    const at = Date.parse((p.doc && p.doc.review && p.doc.review.at) || p.updated_at) || 0;
    (at && at < learnt ? ready : waiting).push(p);
  }
  const learnt_at = learnt ? new Date(learnt).toISOString() : null;
  if (args.action !== 'empty') return json({ team, ready: ready.length, waiting: waiting.length, learnt_at });
  const at = new Date().toISOString();
  let archived = 0;
  for (const p of ready) {
    const doc = E.mergeDoc(p.doc, { archived: { from: 'rejected', at, by: who } });
    const saved = await store.engineUpdatePost(p.id, p.version, { status: 'archived', doc, updated_by: who });
    if (!saved) continue;
    archived++;
    await store.engineEvent({ post_id: p.id, team_id: team, who, action: 'archive', detail: { from: 'rejected', to: 'archived' } });
  }
  return json({ ok: true, team, archived, waiting: waiting.length + ready.length - archived, learnt_at });
}

const newId = (team) => `${team}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 8)}`;

async function engineCreate(store, args, { who }) {
  const ctx = await context(store, who);
  const team = String(args.team || '');
  if (!teamById(ctx, team)) throw err('No such team.', 'ENGINE_NOT_FOUND');
  if (!E.canEditTeam(ctx, team)) throw err('You can only add posts to your own teams.', 'ENGINE_NOT_MEMBER');
  const doc = args.doc && typeof args.doc === 'object' ? args.doc : {};
  const id = String(args.id || newId(team)).replace(/[^a-z0-9-]/gi, '-').slice(0, 120);
  const row = await store.engineInsertPost({
    id, team_id: team, status: 'review', title: String(doc.title || ''), post_at: E.postAt(doc), doc,
    source_team: args.source_team || null, source_post: args.source_post || null, created_by: who, updated_by: who,
  });
  await store.engineEvent({ post_id: id, team_id: team, who, action: 'create', detail: { source_team: args.source_team || null, source_post: args.source_post || null } });
  return json({ ok: true, post: row });
}

// "Copy as an idea to Germany": any post the person can see (their own team's,
// or another team's scheduled or posted one) goes to Review in one of THEIR
// teams, without its posting plan or review history.
async function engineCopy(store, args, { who }) {
  const ctx = await context(store, who);
  const src = await store.enginePost(String(args.id || ''));
  const visible = src && (E.canEditTeam(ctx, src.team_id) || ['scheduled', 'posted'].includes(src.status));
  if (!visible) throw err('No such post.', 'ENGINE_NOT_FOUND');
  const { posting, review, posted, results, ...rest } = src.doc || {};
  const doc = { ...rest, copiedFrom: { team: src.team_id, id: src.id, at: new Date().toISOString(), by: who } };
  const out = await engineCreate(store, { team: args.to_team, doc, source_team: src.team_id, source_post: src.id }, { who });
  await store.engineEvent({ post_id: src.id, team_id: src.team_id, who, action: 'copy', detail: { to_team: args.to_team } });
  return out;
}

async function engineCalendar(store, args, { who }) {
  const ctx = await context(store, who);
  const from = args.from && /^\d{4}-\d{2}-\d{2}/.test(args.from) ? args.from : new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const to = args.to && /^\d{4}-\d{2}-\d{2}/.test(args.to) ? args.to : new Date(Date.now() + 35 * 864e5).toISOString().slice(0, 10);
  const mine = ctx.teams.filter((t) => E.canEditTeam(ctx, t.id)).map((t) => t.id);
  const [posts, keyDates] = await Promise.all([
    store.enginePosts({ from, to, limit: 1000 }),
    store.engineKeyDates ? store.engineKeyDates({ team_ids: mine, from, to }) : [],
  ]);
  return json({
    from, to,
    teams: ctx.teams.map((t) => ({ id: t.id, name: t.name, flag: t.flag, mine: E.canEditTeam(ctx, t.id) })),
    items: E.calendarFor(posts, ctx),
    key_dates: keyDates,
  });
}

// Plan: "draft this for that date". Anyone in the team can ask; the daily
// engine drafts open requests into Review and marks them drafted.
async function engineRequests(store, args, { who }) {
  const ctx = await context(store, who);
  const team = String(args.team || '');
  if (!E.canEditTeam(ctx, team)) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
  const statuses = args.status ? [String(args.status)] : ['open', 'drafted'];
  return json({ team, requests: await store.engineRequests({ team_ids: [team], statuses, from: args.from, to: args.to }) });
}

async function engineRequest(store, args, { who }) {
  const ctx = await context(store, who);
  if (args.action === 'cancel' || args.action === 'drafted') {
    const [cur] = (await store.engineRequests({ team_ids: Object.keys(ctx.myTeams).concat(ctx.maintainer ? ctx.teams.map((t) => t.id) : []), statuses: ['open'] }))
      .filter((r) => Number(r.id) === Number(args.id));
    if (!cur) return json({ ok: false, error: 'No open request with that id in your teams.' });
    const fields = { status: args.action === 'cancel' ? 'cancelled' : 'drafted', done_at: new Date().toISOString(), done_by: who };
    if (args.action === 'drafted') fields.post_id = String(args.post_id || '') || null;
    const row = await store.engineUpdateRequest(cur.id, fields);
    return row ? json({ ok: true, request: row }) : json({ ok: false, error: 'That request was already handled.' });
  }
  const team = String(args.team || '');
  if (!E.canEditTeam(ctx, team)) throw err('You can only plan for your own teams.', 'ENGINE_NOT_MEMBER');
  const v = E.checkRequest(args);
  if (!v.ok) return json({ ok: false, error: v.error });
  if (v.request.source === 'evergreen') {
    const eg = (await store.engineEvergreen({ team_ids: [team] })).find((r) => Number(r.id) === Number(args.evergreen_id));
    if (!eg) return json({ ok: false, error: 'No such post in your evergreen bank.' });
    v.request.evergreen_id = eg.id;
  }
  const row = await store.engineInsertRequest({ team_id: team, ...v.request, requested_by: who });
  return json({ ok: true, request: row });
}

// Evergreen bank (A): past winners, due a fresh version 10 weeks after they
// last went out. Suggest only: a fresh draft is a Plan request.
async function engineEvergreen(store, args, { who }) {
  const ctx = await context(store, who);
  const team = String(args.team || '');
  if (!E.canEditTeam(ctx, team)) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
  const [rows, reqs] = await Promise.all([store.engineEvergreen({ team_ids: [team] }), store.engineRequests({ team_ids: [team], statuses: ['open'] })]);
  const now = new Date();
  return json({
    team, due_weeks: E.EVERGREEN_DUE_WEEKS,
    posts: rows.map((r) => {
      const open = reqs.find((q) => Number(q.evergreen_id) === Number(r.id));
      return { ...r, ...E.evergreenState(r, now), requested: open ? { id: open.id, for_date: open.for_date } : null };
    }),
  });
}

async function engineEvergreenUpdate(store, args, { who }) {
  const ctx = await context(store, who);
  if (args.action === 'add') {
    const team = String(args.team || '');
    if (!E.canEditTeam(ctx, team)) throw err('You can only add to your own teams\' bank.', 'ENGINE_NOT_MEMBER');
    const v = E.checkEvergreen(args);
    if (!v.ok) return json({ ok: false, error: v.error });
    const row = await store.engineInsertEvergreen({ team_id: team, ...v.row, source_post: args.source_post ? String(args.source_post) : null, added_by: who, updated_by: who });
    return json({ ok: true, post: row });
  }
  const mine = Object.keys(ctx.myTeams).concat(ctx.maintainer ? ctx.teams.map((t) => t.id) : []);
  const cur = (await store.engineEvergreen({ team_ids: mine })).find((r) => Number(r.id) === Number(args.id));
  if (!cur) return json({ ok: false, error: 'No such post in your teams\' banks.' });
  const today = new Date();
  const fields = args.action === 'snooze' ? { snoozed_until: new Date(today.getTime() + 28 * 864e5).toISOString().slice(0, 10) }
    : args.action === 'retire' ? { status: 'retired' }
    : args.action === 'restore' ? { status: 'active', snoozed_until: null }
    : args.action === 'went_out' ? { last_out: String(args.last_out || today.toISOString().slice(0, 10)).slice(0, 10), snoozed_until: null }
    : null;
  if (!fields) return json({ ok: false, error: `Unknown action: ${args.action}.` });
  const row = await store.engineUpdateEvergreen(cur.id, { ...fields, updated_by: who });
  return json({ ok: true, post: row ? { ...row, ...E.evergreenState(row, today) } : null });
}

// Slice 2: a finished image for a post (the desk draws cards in the browser).
// Stored in the private engine-media bucket; the desk then saves the returned
// path in the post's `final` snapshot, and the publisher signs a short-lived
// link for Facebook or Instagram to fetch.
const MEDIA_MAX_BYTES = 3 * 1024 * 1024;
// Inbox [slice 3]: comments and DMs read on the Mini. Desk-only actions
// (done, reopen, assign, label) apply at once; anything that changes Facebook
// or Instagram is queued for the Mini, which sends it with the person's own
// Page token after a 10-second undo window. Every action is the history.
const I = require('../lib/inbox');
const SENT = require('../lib/sentiment');
// Each item's tone from its words (lib/sentiment.js, no paid AI); our own
// replies have none. Worked out as it is read, so nothing is stored.
// A tone fixed by hand (tone_set) wins; tone_rule keeps what the words said.
const ruleTone = (i) => (SENT.toneOf(i.text, { lang: langOf(i.text) }) || {}).tone || null;
const toned = (items) => items.map((i) => {
  if (i.from_us) return i;
  const rule = ruleTone(i);
  return i.tone_set ? { ...i, tone: i.tone_set === 'neutral' ? null : i.tone_set, tone_rule: rule, tone_fixed: true } : { ...i, tone: rule };
});
const TONES = ['positive', 'neutral', 'negative', 'mixed'];
// Inbox checks [Priority One, 3 Nov]: a teammate marked needs_check has their
// Facebook and Instagram actions wait (status 'check') until a team admin, or
// the maintainer, approves; then they're queued like any other.
const isChecker = (ctx, team) => ctx.maintainer || ctx.myTeams[team] === 'admin';
async function needsCheck(store, team, who) {
  const m = (await store.engineMembers({ team_id: team })).find((x) => String(x.who).toLowerCase() === String(who).toLowerCase());
  return !!(m && m.needs_check);
}
async function inboxItem(store, ctx, id) {
  const item = await store.engineInboxItem(String(id || ''));
  if (!item || !E.canEditTeam(ctx, item.team_id)) throw err('No such item in your teams.', 'ENGINE_NOT_FOUND');
  return item;
}

async function engineInbox(store, args, { who }) {
  const ctx = await context(store, who);
  const team = String(args.team || '');
  if (!E.canEditTeam(ctx, team)) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
  if (args.thread) {
    const items = await store.engineInbox({ team_ids: [team], thread_id: String(args.thread), limit: 500 });
    return json({ team, thread: String(args.thread), items: toned(items) });
  }
  const status = args.status === 'all' ? null : [args.status === 'done' ? 'done' : 'open'];
  const accounts = [].concat(args.accounts || []).map(String).filter(Boolean).slice(0, 30);
  const q = String(args.q || '').trim();
  const items = await store.engineInbox({ team_ids: [team], statuses: status, platform: args.platform || null, kind: args.kind || null, before: args.before || null, since: args.since || null, account_keys: accounts.length ? accounts : null, q: q || null, limit: args.limit || 200 });
  const allOpen = await store.engineInbox({ team_ids: [team], statuses: ['open'], limit: 1000 });
  // Per-account open counts always cover every account, so the picker can show them.
  const byAccount = {};
  for (const i of allOpen) if (!i.from_us) byAccount[i.account_key] = (byAccount[i.account_key] || 0) + 1;
  const open = accounts.length ? allOpen.filter((i) => accounts.includes(i.account_key)) : allOpen;
  const counts = { open: open.length, facebook: 0, instagram: 0, messages: 0, mentions: 0, mine: 0, fb_comments: 0, messenger: 0, ig_comments: 0, ig_dms: 0, flagged: 0, accounts: byAccount, all_open: allOpen.length };
  for (const i of open) {
    counts[i.platform]++; if (i.kind === 'message') counts.messages++; if (i.kind === 'mention') counts.mentions++;
    if (i.kind === 'comment') counts[i.platform === 'facebook' ? 'fb_comments' : 'ig_comments']++;
    if (i.kind === 'message') counts[i.platform === 'facebook' ? 'messenger' : 'ig_dms']++;
    if (i.hidden || (i.labels || []).some((l) => /^(auto-hidden|threat|abuse)/i.test(l))) counts.flagged++; if (String(i.assigned_to || '').toLowerCase() === String(who).toLowerCase()) counts.mine++; }
  const pending = await store.engineInboxActions({ team_ids: [team], statuses: ['queued', 'running'], limit: 100 });
  const waiting = await store.engineInboxActions({ team_ids: [team], statuses: ['check'], limit: 200 });
  counts.check = waiting.length;
  const alerts = await store.engineInboxAlerts({ team_ids: [team], statuses: ['open'], since: new Date(Date.now() - 24 * 3600_000).toISOString() });
  // Who can reply for each of the team's accounts: the people to assign to.
  const t = teamById(ctx, team);
  const keys = new Set(((t && t.accounts) || []).map((a) => a.key));
  const [members, rights] = await Promise.all([store.engineMembers({ team_id: team }), store.engineAllRights ? store.engineAllRights() : []]);
  const people = members.map((m) => ({ who: m.who, role: m.role, accounts: rights.filter((r) => String(r.who).toLowerCase() === String(m.who).toLowerCase() && keys.has(r.account_key)).map((r) => r.account_key) }));
  const tones = { positive: 0, negative: 0, mixed: 0 };
  for (const i of toned(open)) { if (i.from_us) continue; if (i.tone && tones[i.tone] != null) tones[i.tone]++; }
  // Waiting checks with the comment each one is about, for the To check tab.
  const checkItems = waiting.length ? await Promise.all([...new Set(waiting.map((a) => a.item_id))].map((id) => store.engineInboxItem(id))) : [];
  const checks = waiting.map((a) => ({ ...a, item: toned(checkItems.filter(Boolean)).find((i) => i.id === a.item_id) || null }));
  const mine = members.find((m) => String(m.who).toLowerCase() === String(who).toLowerCase());
  return json({ team, items: toned(items), counts, tone: tones, pending, alerts, people, checks, me: { needs_check: !!(mine && mine.needs_check), checker: isChecker(ctx, team) } });
}

async function engineInboxAct(store, args, { who }) {
  const ctx = await context(store, who);
  const item = await inboxItem(store, ctx, args.id);
  return json(await actOn(store, ctx, item, args, who, I.UNDO_MS));
}

// One item, one action: desk-only ones apply at once, Meta ones are queued
// for undoMs. Shared by the single and bulk tools so the rules can't drift.
async function actOn(store, ctx, item, args, who, undoMs, rightsCache) {
  const action = String(args.action || '');
  const now = new Date();
  const base = { item_id: item.id, team_id: item.team_id, account_key: item.account_key, action, by: who };
  if (action === 'tone') {
    const tone = String(args.tone || '');
    if (!TONES.includes(tone)) return { ok: false, error: 'Tone is positive, neutral, negative or mixed.' };
    if (item.from_us) return { ok: false, error: 'Our own replies have no tone.' };
    const rule = ruleTone(item) || 'neutral';
    // Back to what the words say clears the fix; either way it's in the history.
    const fields = tone === rule ? { tone_set: null, tone_set_by: null } : { tone_set: tone, tone_set_by: who };
    const saved = await store.engineInboxUpdate(item.id, { ...fields, updated_at: now.toISOString(), updated_by: who });
    await store.engineInboxInsertAction({ ...base, detail: { tone, rule }, status: 'done', run_after: now.toISOString(), done_at: now.toISOString() });
    return { ok: true, item: saved ? toned([saved])[0] : null };
  }
  if (I.DESK_ACTIONS.includes(action)) {
    let fields;
    if (action === 'done' || action === 'reopen') fields = { status: action === 'done' ? 'done' : 'open' };
    else if (action === 'assign') fields = { assigned_to: args.assign_to ? String(args.assign_to).slice(0, 120) : null };
    else {
      const labels = [...new Set([].concat(args.labels || []).map((l) => String(l).trim().slice(0, 30)).filter(Boolean))];
      if (labels.length > 10) return { ok: false, error: 'At most 10 labels.' };
      fields = { labels };
    }
    const saved = await store.engineInboxUpdate(item.id, { ...fields, updated_at: now.toISOString(), updated_by: who });
    await store.engineInboxInsertAction({ ...base, detail: fields, status: 'done', run_after: now.toISOString(), done_at: now.toISOString() });
    return { ok: true, item: saved };
  }
  const kind = ['reply', 'private_reply'].includes(action) ? 'reply' : 'moderate';
  const rights = (rightsCache && rightsCache[kind]) || (await store.engineRights({ who, kind })).map((r) => r.account_key);
  if (!rights.includes(item.account_key)) return { ok: false, error: `You can't act for ${item.account_key}: connect Facebook with a Page role on it, or leave it for someone who has one.` };
  let lastIncomingAt, recipient;
  if (item.kind === 'message') {
    const thread = await store.engineInbox({ team_ids: [item.team_id], thread_id: item.thread_id, limit: 500 });
    const theirs = thread.filter((m) => !m.from_us);
    const last = theirs[theirs.length - 1] || item;
    lastIncomingAt = last.created_at; recipient = last.author_id;
    if (!recipient) return { ok: false, error: "Can't tell who to reply to in this conversation." };
  }
  const ok = I.allowed(item, action, { text: args.text, lastIncomingAt, now: now.getTime(), attachment: args.attachment || undefined });
  if (!ok.ok) return ok;
  const attachment = args.attachment ? I.attachmentOk(args.attachment).attachment : null;
  // Petition links become tracked Copilot links (or the same code as a long
  // link if Copilot can't be reached) before anything is queued.
  const tr = args.text ? await T.trackForItem(store, item, String(args.text).trim(), { action, who }) : { text: null, links: [] };
  const detail = { ...(recipient ? { recipient } : {}), ...(attachment ? { attachment } : {}), ...(tr.links.length ? { links: tr.links.map(({ to, code, via }) => ({ to, code, via })) } : {}) };
  if (await needsCheck(store, item.team_id, who)) {
    const row = await store.engineInboxInsertAction({ ...base, text: tr.text, detail, run_after: now.toISOString(), status: 'check' });
    return { ok: true, check: row, links: detail.links || [] };
  }
  const row = await store.engineInboxInsertAction({
    ...base, text: tr.text, detail,
    run_after: new Date(now.getTime() + undoMs).toISOString(), status: 'queued',
  });
  return { ok: true, queued: row, undo_until: row.run_after, links: detail.links || [] };
}

// Bulk by topic: one action on up to 100 items. Replies rotate through the
// texts given, so the account doesn't post the same words a hundred times.
// Meta actions wait 30 seconds; anything a rule refuses is listed, not fatal.
async function engineInboxBulk(store, args, { who }) {
  const ctx = await context(store, who);
  const ids = [...new Set([].concat(args.ids || []).map(String))];
  if (!ids.length) return json({ ok: false, error: 'Pick some comments first.' });
  if (ids.length > 100) return json({ ok: false, error: 'At most 100 at a time.' });
  const texts = [].concat(args.texts || (args.text ? [args.text] : [])).map((t) => String(t).trim()).filter(Boolean).slice(0, 5);
  if (['reply', 'private_reply'].includes(args.action) && !texts.length) return json({ ok: false, error: 'Write the reply first.' });
  const rights = { reply: (await store.engineRights({ who, kind: 'reply' })).map((r) => r.account_key), moderate: (await store.engineRights({ who, kind: 'moderate' })).map((r) => r.account_key) };
  const done = [], refused = [];
  let n = 0;
  for (const id of ids) {
    const item = await store.engineInboxItem(id);
    if (!item || !E.canEditTeam(ctx, item.team_id)) { refused.push({ id, error: 'Not in your teams.' }); continue; }
    if (item.kind !== 'comment' && !['done', 'reopen', 'assign', 'label'].includes(args.action)) { refused.push({ id, error: 'Messages are answered one by one.' }); continue; }
    const r = await actOn(store, ctx, item, { ...args, text: texts.length ? texts[n % texts.length] : args.text }, who, I.BULK_UNDO_MS, rights);
    if (r.ok) { done.push(r.queued ? { id, action_id: r.queued.id } : r.check ? { id, check: r.check.id } : { id }); if (r.queued || r.check) n++; } else refused.push({ id, error: r.error });
  }
  const queued = done.filter((d) => d.action_id);
  return json({ ok: true, done: done.length, refused, action_ids: queued.map((d) => d.action_id), undo_until: queued.length ? new Date(Date.now() + I.BULK_UNDO_MS).toISOString() : null, for_check: done.filter((d) => d.check).length });
}

// Inbox checks: approve or send back a waiting action (team admins, not on
// their own), or switch checks on or off for a teammate (team admins).
async function engineInboxCheck(store, args, { who }) {
  const ctx = await context(store, who);
  const team = String(args.team || '');
  if (!E.canEditTeam(ctx, team)) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
  if (!isChecker(ctx, team)) return json({ ok: false, error: 'Only team admins check teammates\' actions.' });
  if (args.person != null) {
    const m = (await store.engineMembers({ team_id: team })).find((x) => String(x.who).toLowerCase() === String(args.person).toLowerCase());
    if (!m) return json({ ok: false, error: 'They are not in that team.' });
    const row = await store.engineSetNeedsCheck(team, m.who, !!args.needs_check);
    return json({ ok: true, person: m.who, needs_check: !!(row ? row.needs_check : args.needs_check) });
  }
  const a = (await store.engineInboxActions({ team_ids: [team], statuses: ['check'], limit: 500 })).find((r) => Number(r.id) === Number(args.action_id));
  if (!a) return json({ ok: false, error: 'Already checked, or withdrawn.' });
  if (String(a.by).toLowerCase() === String(who).toLowerCase()) return json({ ok: false, error: 'Someone else checks your own actions.' });
  const now = new Date();
  const note = String(args.note || '').trim().slice(0, 300);
  if (args.decision === 'approve') {
    const row = await store.engineInboxUpdateAction(a.id, 'check', { status: 'queued', run_after: new Date(now.getTime() + I.UNDO_MS).toISOString(), detail: { ...(a.detail || {}), checked_by: who, checked_at: now.toISOString() } });
    return json(row ? { ok: true, queued: row, undo_until: row.run_after } : { ok: false, error: 'Already checked, or withdrawn.' });
  }
  if (args.decision === 'reject') {
    const row = await store.engineInboxUpdateAction(a.id, 'check', { status: 'cancelled', done_at: now.toISOString(), detail: { ...(a.detail || {}), checked_by: who, checked_at: now.toISOString(), sent_back: true, note } });
    return json(row ? { ok: true, sent_back: row } : { ok: false, error: 'Already checked, or withdrawn.' });
  }
  return json({ ok: false, error: 'decision is approve or reject.' });
}

// A person's own desk settings and saved views. Only the listed keys, each
// kept small; nothing here is shared with the team.
const PREF_KEYS = { inbox_views: 20000, settings: 4000, bell_seen: 40 };
async function enginePrefsTool(store, args, { who }) {
  await context(store, who);
  const cur = await store.enginePrefs(who);
  if (!args.set) return json({ prefs: cur });
  const next = { ...cur };
  for (const [k, v] of Object.entries(args.set || {})) {
    if (!PREF_KEYS[k]) return json({ ok: false, error: `Unknown setting: ${k}.` });
    if (JSON.stringify(v).length > PREF_KEYS[k]) return json({ ok: false, error: 'That is too much to save.' });
    if (v == null) delete next[k]; else next[k] = v;
  }
  await store.engineSavePrefs(who, next, who);
  return json({ ok: true, prefs: next });
}

async function engineInboxUndo(store, args, { who }) {
  const ctx = await context(store, who);
  const rows = await store.engineInboxActions({ team_ids: Object.keys(ctx.myTeams).concat(ctx.maintainer ? ctx.teams.map((t) => t.id) : []), statuses: ['queued', 'check'], limit: 500 });
  if (Array.isArray(args.action_ids)) {
    const want = new Set(args.action_ids.map(Number));
    let undone = 0;
    for (const a of rows.filter((r) => want.has(Number(r.id)))) {
      if (String(a.by).toLowerCase() !== String(who).toLowerCase() && !ctx.maintainer) continue;
      if (await store.engineInboxUpdateAction(a.id, a.status, { status: 'cancelled', done_at: new Date().toISOString() })) undone++;
    }
    return json({ ok: undone > 0, undone, of: want.size, ...(undone ? {} : { error: 'Too late to undo: they have already gone to Meta.' }) });
  }
  const a = rows.find((r) => Number(r.id) === Number(args.action_id));
  if (!a) return json({ ok: false, error: 'Too late to undo: it has already gone to Meta, or was undone.' });
  if (String(a.by).toLowerCase() !== String(who).toLowerCase() && !ctx.maintainer) return json({ ok: false, error: 'Only the person who did it can undo it.' });
  const done = await store.engineInboxUpdateAction(a.id, a.status, { status: 'cancelled', done_at: new Date().toISOString() });
  return json(done ? { ok: true, cancelled: done } : { ok: false, error: 'Too late to undo: it has already gone to Meta.' });
}

// Supporter history: one person's comments and messages on the team's
// accounts in the last 90 days (they're one author_id per platform).
async function engineInboxPerson(store, args, { who }) {
  const ctx = await context(store, who);
  const team = String(args.team || '');
  if (!E.canEditTeam(ctx, team)) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
  if (!args.author_id) return json({ ok: false, error: 'author_id is needed.' });
  const since = new Date(Date.now() - 90 * 24 * 3600_000).toISOString();
  const all = await store.engineInbox({ team_ids: [team], author_id: String(args.author_id), since, limit: 500 });
  const rows = all.filter((r) => !r.from_us);
  const labels = [...new Set(rows.flatMap((r) => r.labels || []))];
  const author = String(args.author_id);
  // 19B (Priority Three, 4 Nov): a few fixed tags on a person, never free text,
  // seen only by this team and gone 120 days after they were last set.
  let tags = await personTagsGet(store, team, author);
  if (args.tags !== undefined) {
    const want = [...new Set([].concat(args.tags || []).map(String))];
    const bad = want.filter((t) => !PERSON_TAGS.includes(t));
    if (bad.length) return json({ ok: false, error: `Tags are one of: ${PERSON_TAGS.join(', ')}.` });
    tags = want.length ? { tags: want, by: who, at: new Date().toISOString(), expires_at: new Date(Date.now() + PERSON_TAG_DAYS * 864e5).toISOString() } : null;
    await personTagsPut(store, team, author, tags, who);
  }
  // 19E: what the team already did about this person, from the moderation log. Nothing new is stored.
  const ids = all.map((r) => r.id).slice(0, 200);
  const acts = ids.length ? await store.engineInboxActions({ team_ids: [team], item_ids: ids, limit: 200 }) : [];
  const handled = acts.filter((a) => HANDLED.includes(a.action) && ['done', 'queued', 'running', 'check'].includes(a.status))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 12)
    .map((a) => ({ action: a.action, by: a.by, at: a.created_at, item_id: a.item_id, status: a.status }));
  return json({
    team, author_id: author, author_name: (rows[0] && rows[0].author_name) || null,
    counts: { comments: rows.filter((r) => r.kind === 'comment').length, messages: rows.filter((r) => r.kind === 'message').length, hidden: rows.filter((r) => r.hidden).length, on_ads: rows.filter((r) => r.is_ad).length },
    labels, recent: rows.slice(0, 8),
    tags: tags ? tags.tags : [], tags_by: tags ? tags.by : null, tags_at: tags ? tags.at : null, tags_expire: tags ? tags.expires_at : null,
    tag_choices: PERSON_TAGS, handled,
  });
}
const PERSON_TAGS = ['Regular supporter', 'Asks questions', 'Journalist', 'Politician', 'Organisation', 'Repeat abuse'];
const PERSON_TAG_DAYS = 120;
const HANDLED = ['reply', 'private_reply', 'like', 'hide', 'unhide', 'delete', 'ban', 'unban', 'assign', 'label', 'tone', 'done'];
const tagDocId = (team, author) => `pt_${team}_${String(author).replace(/[^A-Za-z0-9_-]/g, '')}`.slice(0, 200);
async function personTagsGet(store, team, author) {
  let doc = null;
  if (store.personTagsGet) doc = await store.personTagsGet(team, author);
  else {
    const D = require('../lib/desk');
    try {
      // Sweep anything past its 120 days first, so expired tags are really gone.
      await D.pg('DELETE', `engine_desk_docs?collection=eq.personTags&data->>expires_at=lt.${encodeURIComponent(new Date().toISOString())}`, undefined, 'return=minimal');
      const rows = await D.pg('GET', `engine_desk_docs?select=data&collection=eq.personTags&id=eq.${encodeURIComponent(tagDocId(team, author))}`);
      doc = (rows[0] && rows[0].data) || null;
    } catch (e) { doc = null; }
  }
  if (!doc || !Array.isArray(doc.tags) || !doc.tags.length || Date.parse(doc.expires_at) < Date.now()) return null;
  return doc;
}
async function personTagsPut(store, team, author, doc, who) {
  if (store.personTagsPut) return store.personTagsPut(team, author, doc);
  const D = require('../lib/desk');
  if (!doc) return D.pg('DELETE', `engine_desk_docs?collection=eq.personTags&id=eq.${encodeURIComponent(tagDocId(team, author))}`, undefined, 'return=minimal');
  return D.docsPut('personTags', tagDocId(team, author), { team, author_id: String(author), ...doc }, who, { engine: true });
}

// 33 (Priority Two, 3 Nov): a team's house rules (voice, tone, audience,
// always, never, style, and the rules people added), the saved copy over the
// built-in default, with prompt-ready text for compose, inbox or the morning run.
async function engineHouseRules(store, args, { who }) {
  const ctx = await context(store, who);
  const team = String(args.team || '');
  if (!E.canEditTeam(ctx, team)) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
  const HR = require('../lib/house-rules');
  const D = () => require('../lib/desk');
  // Save (anyone in the team): sections and rules, or reset: true for the built-in default.
  if (args.set || args.reset) {
    const s = args.set || {};
    const doc = args.reset ? { team, updated_by: who, updated_at: new Date().toISOString() }
      : { team, sections: s.sections && typeof s.sections === 'object' ? s.sections : undefined, rules: Array.isArray(s.rules) ? s.rules : undefined, updated_by: who, updated_at: new Date().toISOString() };
    const clean = HR.merge(team, doc);
    const out = { team, updated_by: who, updated_at: doc.updated_at, ...(args.reset ? {} : { sections: clean.sections, rules: clean.rules }) };
    if (store.houseRulesPut) await store.houseRulesPut(team, out);
    else await D().docsPut('houseRules', `hr_${team}`, out, who, { engine: true });
  }
  let saved = null;
  if (store.houseRulesDoc) saved = await store.houseRulesDoc(team);
  else { try { const rows = await D().docsList('houseRules', { team, engine: true }); saved = (rows.find((r) => r.id === `hr_${team}`) || {}).data || null; } catch (e) { saved = null; } }
  const h = HR.merge(team, saved);
  const where = ['compose', 'inbox', 'morning'].includes(args.for) ? args.for : 'compose';
  return json({ ...h, sections_order: HR.SECTIONS, default_sections: HR.defaults(team).sections, default_rules: HR.defaults(team).rules, text: HR.text(h, where), for: where });
}

// 28A/B (Priority Two, 3 Nov): our Instagram beside allied organisations'
// Instagram over the last days (30 by default): followers, posts, likes +
// comments, and per post. Allies only: opponents are left out on purpose.
const TEAM_COUNTRY = { uk: 'UK', scotland: 'UK', ie: 'IE', us: 'US' };
async function engineBenchmark(store, args, { who }) {
  const ctx = await context(store, who);
  const team = String(args.team || '');
  const t = teamById(ctx, team);
  if (!t || !E.canEditTeam(ctx, team)) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
  const days = [7, 30, 90].includes(Number(args.days)) ? Number(args.days) : 30;
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const country = args.country === 'all' ? null : String(args.country || TEAM_COUNTRY[team] || '') || null;
  const igs = (t.accounts || []).filter((a) => a.platform === 'instagram' && (a.ig_id || a.handle));
  const B = await store.allyBenchmark({ country, since, ig_ids: igs.map((a) => ({ ig_id: a.ig_id || null, handle: a.handle || null, key: a.key })) });
  const row = (o) => ({ ...o, engagement: o.likes + o.comments, per_post: o.posts ? Math.round((o.likes + o.comments) / o.posts) : 0, per_1k_followers: o.followers ? Math.round((o.likes + o.comments) / o.posts / o.followers * 1000 * 10) / 10 || 0 : null });
  const rows = (B.accounts || []).map((a) => {
    const ps = (B.posts || []).filter((p) => p.username === a.username);
    const top = ps.slice().sort((x, y) => ((y.like_count || 0) + (y.comments_count || 0)) - ((x.like_count || 0) + (x.comments_count || 0)))[0];
    return row({ name: a.label || a.username, handle: a.username, country: a.country, topic: a.topic, ours: false, followers: a.followers_count || null, posts: ps.length,
      likes: ps.reduce((n, p) => n + (p.like_count || 0), 0), comments: ps.reduce((n, p) => n + (p.comments_count || 0), 0),
      top: top ? { url: top.permalink, text: String(top.caption || '').slice(0, 140), engagement: (top.like_count || 0) + (top.comments_count || 0), at: top.timestamp } : null });
  }).filter((r) => r.posts);
  for (const o of B.ours || []) {
    const by = Object.fromEntries((o.metrics || []).map((m) => [m.media_id, m]));
    const likes = o.media.reduce((n, m) => n + ((by[m.media_id] || {}).likes || 0), 0), comments = o.media.reduce((n, m) => n + ((by[m.media_id] || {}).comments || 0), 0);
    const acc = igs.find((a) => a.key === o.key) || {};
    rows.push(row({ name: acc.name || ('@' + (o.username || 'us')), handle: o.username, country: TEAM_COUNTRY[team] || null, ours: true, followers: o.followers, posts: o.media.length, likes, comments, top: null }));
  }
  rows.sort((a, b) => b.per_post - a.per_post);
  return json({ team, days, country: country || 'all', measure: 'likes + comments on Instagram', rows, note: 'Allies only. Their figures come from Instagram business discovery: likes and comments, no reach.' });
}

// 10A (Priority Two, 3 Nov): the post a conversation is on, with its newest
// nightly figures (reactions by type, shares, comments, views) and the post's
// own tone. Facebook pictures can't be shown (Meta's stored picture links
// expire); Instagram thumbnails can.
async function engineInboxPost(store, args, { who }) {
  const ctx = await context(store, who);
  const team = String(args.team || '');
  if (!E.canEditTeam(ctx, team)) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
  const thread = String(args.thread_id || '');
  if (!thread) return json({ ok: false, error: 'thread_id is needed.' });
  const rows = await store.engineInbox({ team_ids: [team], thread_id: thread, limit: 1000 });
  if (!rows.length) return json({ ok: false, error: 'No conversation with that id in this team.' });
  const r0 = rows[0];
  const fig = store.postFigures ? await store.postFigures({ platform: r0.platform, id: thread }).catch(() => null) : null;
  const text = (fig && fig.text) || r0.post_text || '';
  const t = text ? SENT.toneOf(text, { lang: langOf(text) }) : null;
  const theirs = rows.filter((r) => !r.from_us);
  return json({
    team, thread_id: thread, platform: r0.platform, account_key: r0.account_key, is_ad: !!r0.is_ad,
    text: String(text).slice(0, 600), url: (fig && fig.url) || r0.post_url || null, img: (fig && fig.img) || null, type: (fig && fig.type) || null, at: (fig && fig.at) || null,
    figures: fig && fig.collected_date ? { as_of: fig.collected_date, views: fig.views ?? null, reactions: fig.reactions, shares: fig.shares ?? null, comments: fig.comments ?? null, saved: fig.saved ?? null } : null,
    tone: (t && t.tone) || 'neutral',
    here: { comments: theirs.length, open: theirs.filter((r) => r.status === 'open').length, ours: rows.length - theirs.length },
  });
}

// 35A (Priority Two, 3 Nov): the team's own past replies to comments like
// this one, matched by shared words (no AI). Up to three, best first.
const SIM_STOP = new Set('the and for you your our are was this that with have has had not but they them their what when where who why how can could would will just about from into its is be been being a an to of in on at by or as if so do does did i me my we us he she his her him all any more most some such than too very also there here then now only own same other out up down off over under again once yes no ok please thanks thank'.split(' '));
const simWords = (t) => new Set(String(t || '').toLowerCase().normalize('NFKD').replace(/https?:\S+/g, ' ').split(/[^\p{L}\p{N}']+/u).filter((w) => w.length > 2 && !SIM_STOP.has(w)));
function simScore(a, b) { if (!a.size || !b.size) return 0; let n = 0; for (const w of a) if (b.has(w)) n++; return n / Math.min(a.size, b.size) * (n >= 2 ? 1 : 0.5); }
async function engineInboxSimilar(store, args, { who }) {
  const ctx = await context(store, who);
  const team = String(args.team || '');
  if (!E.canEditTeam(ctx, team)) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
  const item = args.id && store.engineInboxItem ? await store.engineInboxItem(String(args.id)) : null;
  const text = String(args.text || (item && item.team_id === team ? item.text : '') || '');
  const mine = simWords(text);
  if (!mine.size) return json({ team, replies: [] });
  const acts = (await store.engineInboxActions({ team_ids: [team], limit: 1000 })).filter((a) => a.action === 'reply' && a.status === 'done' && a.text && a.item_id !== args.id);
  const parents = store.engineInboxByIds ? await store.engineInboxByIds(acts.map((a) => a.item_id)) : [];
  const byId = Object.fromEntries(parents.map((p) => [p.id, p]));
  const seen = new Set();
  const out = acts.map((a) => { const p = byId[a.item_id]; return p ? { a, p, score: simScore(mine, simWords(p.text)) } : null; })
    .filter((x) => x && x.score >= 0.34).sort((x, y) => y.score - x.score || String(y.a.created_at).localeCompare(String(x.a.created_at)))
    .filter((x) => { const k = String(x.a.text).toLowerCase().replace(/\s+/g, ' ').trim(); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 3)
    .map((x) => ({ text: x.a.text, by: x.a.by, at: x.a.created_at, to: String(x.p.text || '').slice(0, 160), to_name: x.p.author_name || null, platform: x.p.platform, score: Math.round(x.score * 100) / 100 }));
  return json({ team, replies: out });
}

// By post: the last 7 days' comments grouped by the post or ad they're on,
// busiest unanswered first.
async function engineInboxPosts(store, args, { who }) {
  const ctx = await context(store, who);
  const team = String(args.team || '');
  if (!E.canEditTeam(ctx, team)) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
  const days = Math.min(30, Math.max(1, Number(args.days) || 7));
  const rows = await store.engineInbox({ team_ids: [team], kind: 'comment', since: new Date(Date.now() - days * 24 * 3600_000).toISOString(), limit: 1000 });
  const by = {};
  for (const r of rows) {
    const p = by[r.thread_id] || (by[r.thread_id] = { thread_id: r.thread_id, account_key: r.account_key, platform: r.platform, post_text: r.post_text, post_url: r.post_url, is_ad: r.is_ad, comments: 0, open: 0, hidden: 0, ours: 0, last_at: r.created_at, tone: { positive: 0, negative: 0, mixed: 0, neutral: 0 } });
    if (r.from_us) { p.ours++; continue; }
    p.comments++; if (r.status === 'open') p.open++; if (r.hidden) p.hidden++;
    { const t = SENT.toneOf(r.text, { lang: langOf(r.text) }); if (t) p.tone[t.tone]++; }
    if (r.created_at > p.last_at) p.last_at = r.created_at;
  }
  const posts = Object.values(by).filter((p) => p.comments).sort((a, b) => b.open - a.open || String(b.last_at).localeCompare(String(a.last_at)));
  return json({ team, days, posts: args.ads ? posts.filter((p) => p.is_ad) : posts });
}

// Auto-hide list: everyone in the team sees it; team admins change it.
async function engineInboxRules(store, args, { who }) {
  const ctx = await context(store, who);
  const team = String(args.team || '');
  if (!E.canEditTeam(ctx, team)) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
  return json({ team, rules: await store.engineInboxRules({ team_ids: [team] }), scam_phrases: I.SCAM_PHRASES, can_edit: ctx.maintainer || ctx.myTeams[team] === 'admin' });
}
async function engineInboxRule(store, args, { who }) {
  const ctx = await context(store, who);
  const team = String(args.team || '');
  if (!E.canEditTeam(ctx, team)) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
  if (!(ctx.maintainer || ctx.myTeams[team] === 'admin')) return json({ ok: false, error: "Only the team's admins can change the auto-hide list." });
  if (args.action === 'remove') {
    const gone = await store.engineDeleteInboxRule(args.id, team);
    return json(gone ? { ok: true, rules: await store.engineInboxRules({ team_ids: [team] }) } : { ok: false, error: 'No such rule.' });
  }
  if (args.action !== 'add') return json({ ok: false, error: 'action is add or remove.' });
  const c = I.checkRule({ kind: args.kind, value: args.value });
  if (!c.ok) return json(c);
  const have = await store.engineInboxRules({ team_ids: [team] });
  if (have.some((r) => r.kind === args.kind && String(r.value).toLowerCase() === c.value.toLowerCase())) return json({ ok: false, error: 'Already on the list.' });
  if (have.length >= 200) return json({ ok: false, error: 'At most 200 rules.' });
  await store.engineInsertInboxRule({ team_id: team, kind: args.kind, value: c.value, created_by: who });
  return json({ ok: true, rules: await store.engineInboxRules({ team_ids: [team] }) });
}

async function engineInboxAlert(store, args, { who }) {
  const ctx = await context(store, who);
  const team = String(args.team || '');
  if (!E.canEditTeam(ctx, team)) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
  const done = await store.engineUpdateInboxAlert(args.id, team, { status: 'seen', seen_by: who, seen_at: new Date().toISOString() });
  return json(done ? { ok: true, alert: done } : { ok: false, error: 'No such alert.' });
}

// Settings › Team and access [gaps §7]: per person and account, what they can
// do (post, reply and DM, moderate; analytics per team), where it comes from
// (Facebook, set up by hand, none) and what an admin narrowed. Admins narrow,
// never widen: a limit only ever turns something off. Initials (2-3 letters,
// ideally the person's Copilot ones) go into their tracked links.
const ACCESS_KINDS = ['post', 'reply', 'moderate'];
async function engineAccessList(store, team, ctx) {
  const t = teamById(ctx, team);
  const members = (await store.engineMembers({ team_id: team })) || [];
  const whos = [...new Set(members.map((m) => m.who))];
  const [rights, limits, people] = await Promise.all([store.engineAllRightsFor({ whos }), store.engineAccessLimits({ team_id: team }), store.enginePeople()]);
  const accounts = (t.accounts || []).filter((a) => a.platform !== 'x');
  return {
    team, can_edit: ctx.maintainer || ctx.myTeams[team] === 'admin', kinds: ACCESS_KINDS,
    accounts: accounts.map((a) => ({ key: a.key, name: a.name || a.key, platform: a.platform })),
    people: members.map((m) => {
      const lim = (k) => limits.find((l) => l.who.toLowerCase() === m.who.toLowerCase() && l.account_key === k) || {};
      const initials = ((people || []).find((p) => p.who.toLowerCase() === m.who.toLowerCase()) || {}).initials || null;
      return {
        who: m.who, role: m.role, initials, analytics: lim('*').can_analytics !== false,
        accounts: accounts.map((a) => {
          const r = rights.find((x) => x.who.toLowerCase() === m.who.toLowerCase() && x.account_key === a.key);
          const l = lim(a.key);
          return { key: a.key, source: r ? (r.source === 'meta' ? 'meta' : 'hand') : null, checked_at: r ? r.checked_at : null,
            ...Object.fromEntries(ACCESS_KINDS.map((k) => [k, !!r && l[`can_${k}`] !== false])), narrowed: ACCESS_KINDS.filter((k) => l[`can_${k}`] === false) };
        }),
      };
    }),
  };
}
async function engineAccess(store, args, { who }) {
  const ctx = await context(store, who);
  const team = String(args.team || '');
  if (!E.canEditTeam(ctx, team)) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
  const admin = ctx.maintainer || ctx.myTeams[team] === 'admin';
  const now = new Date().toISOString();
  if (args.action === 'initials') {
    const target = String(args.who || who);
    if (target.toLowerCase() !== String(who).toLowerCase() && !admin) return json({ ok: false, error: "Only the team's admins can set someone else's initials." });
    const ini = String(args.initials || '').trim().toUpperCase();
    if (!/^[A-Z]{2,3}$/.test(ini)) return json({ ok: false, error: 'Initials are 2 or 3 letters, ideally the ones Copilot shows for them (e.g. CJO).' });
    await store.engineSetInitials(target, ini, who);
  } else if (args.action === 'limit') {
    if (!admin) return json({ ok: false, error: "Only the team's admins can change access." });
    const target = String(args.who || '');
    if (!((await store.engineMembers({ team_id: team })) || []).some((m) => m.who.toLowerCase() === target.toLowerCase())) return json({ ok: false, error: 'They are not in this team.' });
    const key = String(args.account_key || '');
    const t = teamById(ctx, team);
    if (key !== '*' && !(t.accounts || []).some((a) => a.key === key)) return json({ ok: false, error: 'That account is not in this team.' });
    const cur = (await store.engineAccessLimits({ team_id: team, who: target })).find((l) => l.account_key === key) || {};
    const pick = (k) => (args[k] === undefined ? cur[`can_${k}`] !== false : !!args[k]);
    await store.engineSetAccessLimit({ team_id: team, who: target, account_key: key, can_post: key === '*' ? true : pick('post'), can_reply: key === '*' ? true : pick('reply'), can_moderate: key === '*' ? true : pick('moderate'), can_analytics: key === '*' ? pick('analytics') : true, set_by: who, set_at: now });
    await store.engineEvent({ post_id: `access:${team}`, team_id: team, who, action: 'access', detail: { who: target, account_key: key, post: args.post, reply: args.reply, moderate: args.moderate, analytics: args.analytics } }).catch(() => {});
  } else if (args.action && args.action !== 'list') return json({ ok: false, error: 'action is list, limit or initials.' });
  return json({ ok: true, ...(await engineAccessList(store, team, ctx)) });
}

// One Campaign Copilot link with the engine's sign-in (the laptop's morning
// link run uses this since its own sign-in moved into the engine: Copilot
// rotates refresh tokens, so there is one copy). args are make_links.py's
// copilotArgs; the result is the link object it writes into a post's links.
async function engineCopilotLink(store, args, { who }) {
  const ctx = await context(store, who);
  if (!ctx.maintainer && !Object.keys(ctx.myTeams).length) throw err('Join a Content Engine team to make links.', 'ENGINE_NOT_MEMBER');
  const a = args.args && typeof args.args === 'object' ? args.args : null;
  const need = ['assetType', 'petitionId', 'ctaFamilyCode', 'platformCode', 'seriesFlow', 'listCode', 'topicCode', 'scopeCode', 'campaignTitle'];
  if (!a || need.some((k) => a[k] === undefined || a[k] === '') || a.assetType !== 'petition') return json({ ok: false, error: `args needs ${need.join(', ')} (make_links.py --dry-run gives them as copilotArgs).` });
  if (!/^(FB|IG|TW)[1-5]$/.test(String(a.seriesFlow)) || String(a.campaignTitle).length > 60) return json({ ok: false, error: 'seriesFlow is FB1-5, IG1-5 or TW1-5; campaignTitle at most 60 characters.' });
  try {
    const r = await copilot.call(store, 'generate_social_url', { channel: 'social', trafficType: 'organic', ...a });
    if (!r || !r.shortUrl) return json({ ok: false, error: 'Copilot gave no short link.' });
    return json({ ok: true, reused: !!r.reused, link: { short: r.shortUrl, long: r.fullUrl, campaign: r.campaignName, linkId: r.linkId || null, via: 'copilot', at: new Date().toISOString().replace(/\.\d+Z$/, 'Z') } });
  } catch (e) {
    return json({ ok: false, error: e.code === 'COPILOT_SIGNED_OUT' ? 'The engine is not signed in to Campaign Copilot: Chris runs npm run copilot:adopt (or copilot:login).' : `Copilot: ${e.message}` });
  }
}

// The desk's own documents (were the board artifact's collections): the morning
// run reads feedback and video requests and appends results here.
async function engineDeskDocs(store, args, { who }) {
  const ctx = await context(store, who);
  if (!ctx.maintainer && !Object.keys(ctx.myTeams).length) throw err('Join a Content Engine team first.', 'ENGINE_NOT_MEMBER');
  const D = require('../lib/desk');
  const collection = String(args.collection || '');
  if (!['feedback', 'videoRequests', 'results'].includes(collection)) return json({ ok: false, error: 'collection is feedback, videoRequests or results.' });
  if (!args.action || args.action === 'list') {
    const rows = await D.docsList(collection, { since: args.since, limit: args.limit });
    const docs = rows.map((r) => ({ id: r.id, created_at: r.created_at, updated_at: r.updated_at, ...r.data })).filter((d) => !args.status || d.status === args.status);
    return json({ collection, docs });
  }
  if (args.action === 'put') {
    if (!args.data || typeof args.data !== 'object') return json({ ok: false, error: 'data (an object) is required.' });
    const out = await D.docsPut(collection, args.id, args.data, who, { merge: !!args.merge });
    return json({ ok: true, id: out.id });
  }
  return json({ ok: false, error: 'action is list or put.' });
}

// Analytics and Listening read 90 days of posts, so their answers are kept:
// the Mini works out the desk's views every night from the collected data
// (scripts/engine-warm-cache.js) and they last until the next night's run.
// Access is checked on every call before anything is served; fresh: true
// (the desk's Refresh) recalculates now.
const CACHE_MS = 26 * 3600e3;
const wellFormed = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'string' ? x.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '') : x)));
async function cached(store, key, args, compute) {
  if (!args.fresh && store.engineCacheGet) {
    const hit = await store.engineCacheGet(key).catch(() => null);
    if (hit && Date.now() - Date.parse(hit.computed_at) < CACHE_MS) return json({ ...hit.value, cached_at: hit.computed_at });
  }
  const out = await compute();
  let value; try { value = JSON.parse(out.text); } catch (e) { return out; }
  // Text cut to a length can end in half an emoji, which Postgres refuses as
  // JSON: keep every string well formed before caching it.
  if (value && value.ok !== false && store.engineCacheSet) await store.engineCacheSet(key, wellFormed(value)).catch(() => {});
  return json({ ...value, cached_at: new Date().toISOString() });
}
async function engineAnalytics(store, args, ctx0) {
  const ctx = await context(store, ctx0.who);
  if (!ctx.maintainer && !Object.keys(ctx.myTeams).length) throw err('Join a Content Engine team to see Analytics.', 'ENGINE_NOT_MEMBER');
  if (!ctx.maintainer) {
    const off = (store.engineAccessLimits ? await store.engineAccessLimits({ who: ctx0.who }) : []).filter((l) => l.account_key === '*' && l.can_analytics === false).map((l) => l.team_id);
    if (Object.keys(ctx.myTeams).every((t) => off.includes(t))) throw err('A team admin has turned Analytics off for you.', 'ENGINE_NOT_ALLOWED');
  }
  const scope = ['citizengo', 'hazteoir', 'team', 'countries', 'leaderboard'].includes(args.scope) ? args.scope : 'citizengo';
  const days = [7, 30, 90].includes(Number(args.days)) ? Number(args.days) : 30;
  const team = scope === 'team' ? String(args.team || '') : '';
  if (team && !E.canEditTeam(ctx, team)) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
  if (scope === 'leaderboard') return cached(store, `analytics:v2:leaderboard:${days}`, args, () => leaderboardCompute(store, ctx, days));
  if (scope === 'countries') return cached(store, `analytics:v2:countries:${days}`, args, () => countriesCompute(store, ctx, days));
  // A date range of the person's own choosing (and, optionally, the window to
  // compare it with): only the round-two report, posts and conversations.
  if (args.from || args.to) {
    const r = rangeArgs(args);
    if (!r.ok) return json({ ok: false, error: r.error });
    return cached(store, `analytics:v3:range:${scope}:${team}:${r.from}:${r.to}:${r.cfrom || ''}`, args, () => rangeCompute(store, { ...args, ...r }, ctx0));
  }
  return cached(store, `analytics:v3:${scope}:${days}:${team}`, args, () => analyticsCompute(store, args, ctx0));
}
// from / to (YYYY-MM-DD, inclusive, up to 92 days, not in the future) and
// compare_from (the comparison window's first day; same length). Without
// compare_from the comparison is the same number of days just before.
function rangeArgs(args, now = Date.now()) {
  const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !isNaN(Date.parse(`${d}T00:00:00Z`));
  const today = new Date(now).toISOString().slice(0, 10);
  const to = ok(args.to) ? String(args.to) : today;
  if (!ok(args.from)) return { ok: false, error: 'Pick a start date.' };
  const from = String(args.from);
  if (from > to) return { ok: false, error: 'The start date is after the end date.' };
  if (to > today) return { ok: false, error: 'The end date is in the future.' };
  const n = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5) + 1;
  if (n > 92) return { ok: false, error: 'Pick at most 92 days.' };
  const ymd = (t) => new Date(t).toISOString().slice(0, 10);
  let cfrom = null, cto = null;
  if (args.compare === 'none') return { ok: true, from, to, days: n, cfrom, cto };
  if (ok(args.compare_from)) { cfrom = String(args.compare_from); cto = ymd(Date.parse(`${cfrom}T00:00:00Z`) + (n - 1) * 864e5); if (cto >= from && cfrom <= to) return { ok: false, error: 'The comparison overlaps the dates you picked.' }; }
  else { cto = ymd(Date.parse(`${from}T00:00:00Z`) - 864e5); cfrom = ymd(Date.parse(`${from}T00:00:00Z`) - n * 864e5); }
  return { ok: true, from, to, days: n, cfrom, cto };
}
async function engineListening(store, args, ctx0) {
  const ctx = await context(store, ctx0.who);
  if (!ctx.maintainer && !Object.keys(ctx.myTeams).length) throw err('Join a Content Engine team to see Listening.', 'ENGINE_NOT_MEMBER');
  const team = args.team ? String(args.team) : '';
  if (team && !E.canEditTeam(ctx, team)) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
  // Topics read the team's own language (México: Spanish); the UK keeps its cache key.
  const lang = E.teamLang(team), edition = E.newsEdition(team);
  if (args.tab === 'overview') return cached(store, `listening:overview:v2${lang === 'en' ? '' : `:${lang}`}`, args, () => topicsOverview(store, Date.now(), lang));
  if (args.tab === 'beyond') {
    return cached(store, `listening:beyond:v2${edition === 'uk' ? '' : `:${edition}`}`, args, async () => {
      const now = Date.now(), since = new Date(now - 14 * 864e5).toISOString();
      const [media, news, posts, accounts] = await Promise.all([store.listenHashtagMedia ? store.listenHashtagMedia({ since }).catch(() => []) : [], store.listenNews ? store.listenNews({ since: new Date(now - 3 * 864e5).toISOString(), edition }).catch(() => []) : [], listeningCorpus(store, now), store.peerAccounts ? store.peerAccounts().catch(() => []) : []]);
      const tags = require('../config/listen-hashtags.json').map((t) => ({ tag: String(t.tag).toLowerCase(), topic: t.topic }));
      // A hashtag post counts only when it's in the team's language and its own words fit
      // the hashtag's topic: hashtags travel (cars on #rse, pets on #euthanasia).
      const T = require('../lib/listen-topics');
      const tagTopic = Object.fromEntries(tags.map((t) => [t.tag, t.topic]));
      const fit = (media || []).filter((m) => tagTopic[m.hashtag] && langOf(m.caption) === lang && T.topicsOf(m.caption).includes(tagTopic[m.hashtag]));
      return json({ tab: 'beyond', edition, ...require('../lib/listen-topics').beyond({ tags, media: fit, news, posts, known: (accounts || []).map((a) => a.username) }, { now }), hashtag_rows: fit.length, news_rows: news.length });
    });
  }
  if (args.tab === 'opponents_mix') {
    const days = [7, 14].includes(Number(args.days)) ? Number(args.days) : 7;
    return cached(store, `listening:opponents_mix:${days}`, args, async () => {
      const now = Date.now(), since = new Date(now - days * 864e5).toISOString();
      const [posts, ads, accounts] = await Promise.all([listeningCorpus(store, now), store.opponentAds ? store.opponentAds({ since }).catch(() => []) : [], store.peerAccounts ? store.peerAccounts().catch(() => []) : []]);
      return json({ tab: 'opponents_mix', ...require('../lib/listen-topics').opponentMix(posts, ads || [], (accounts || []).filter((a) => a.stance === 'opponent'), { now, days, storyKeys }) });
    });
  }
  if (args.tab === 'watches') {
    const ws = (Array.isArray(args.watches) ? args.watches : []).slice(0, 30).map((w) => ({ id: String(w.id || '').slice(0, 60), words: (w.words || []).map(String).slice(0, 20), not: (w.not || []).map(String).slice(0, 20), sources: (w.sources || []).map(String).slice(0, 3) }));
    const sig = require('crypto').createHash('sha1').update(JSON.stringify(ws)).digest('hex').slice(0, 16);
    return cached(store, `listening:watches:${sig}`, args, () => watchesCompute(store, ws));
  }
  const tab = ['citizengo', 'allies', 'opponents'].includes(args.tab) ? args.tab : 'citizengo';
  // Only the citizengo tab depends on the team (it leaves the team's own Pages out).
  const key = `listening:p2:${tab}:${tab === 'citizengo' ? team : ''}:${args.country || ''}:${Number(args.days) || ''}:${Number(args.min_multiple) || ''}`;
  return cached(store, key, args, () => listeningCompute(store, args, ctx0));
}

// The Desk AI helper (a claude.ai page) answers the web desk's AI requests with
// its viewer's own Claude: get the prompt, then complete with the answer (or
// fail). Only the person who filed the request can read or answer it.
async function engineAiJob(store, args, { who }) {
  if (!E.signedIn(who)) throw err('Sign in to use the Content Engine.', 'ENGINE_SIGN_IN');
  const D = require('../lib/desk');
  const action = args.action || 'get';
  let id = String(args.id || '');
  // next: the newest unanswered request (the page may be opened without an id).
  if (action === 'next') {
    const next = await D.aiJobNext(who);
    if (!next) return json({ ok: false, error: 'No request is waiting for you. Press the AI button on the desk again.' });
    id = next.id;
  }
  if (!/^[0-9a-f]{24}$/.test(id)) return json({ ok: false, error: 'That request id is not valid.' });
  const job = await D.aiJobGet(id, who);
  if (!job) return json({ ok: false, error: 'No such request for you (it may belong to someone else).' });
  if (action === 'get' || action === 'next') {
    const again = ['queued', 'failed'].includes(job.status);
    if (again) await D.aiJobUpdate(id, who, { status: 'running', error: null });
    return json({ ok: true, id, status: again ? 'running' : job.status, prompt: job.prompt, created_at: job.created_at });
  }
  if (!['running', 'queued', 'failed'].includes(job.status)) return json({ ok: false, error: `This request is already ${job.status}.` });
  if (action === 'complete') {
    const text = String(args.text || '');
    if (!text.trim()) return json({ ok: false, error: 'text is required.' });
    await D.aiJobUpdate(id, who, { status: 'done', text: text.slice(0, 60000), done_at: new Date().toISOString() });
    return json({ ok: true });
  }
  if (action === 'fail') {
    await D.aiJobUpdate(id, who, { status: 'failed', error: String(args.error || 'Claude could not answer').slice(0, 500), done_at: new Date().toISOString() });
    return json({ ok: true });
  }
  return json({ ok: false, error: 'action is get, next, complete or fail.' });
}

// Comment-to-DM automations: the team sees them; team admins change them.
async function engineAutomationsList(store, args, { who }) {
  const ctx = await context(store, who);
  const team = String(args.team || '');
  if (!E.canEditTeam(ctx, team)) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
  const autos = await store.engineAutomations({ team_ids: [team] });
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const sent = {};
  const blank = () => ({ queued: 0, sent: 0, failed: 0, steps: { dm: 0, reply: 0, react: 0, failed: 0 } });
  for (const a of await store.engineInboxActions({ team_ids: [team], limit: 1000 })) {
    const id = a.detail && a.detail.automation_id;
    if (!id || a.created_at < since || a.status === 'cancelled') continue;
    const s = sent[id] = sent[id] || blank();
    if (a.action === 'private_reply') s[a.status === 'done' ? 'sent' : a.status === 'failed' ? 'failed' : 'queued']++;
    const step = a.action === 'private_reply' ? 'dm' : a.action === 'reply' ? 'reply' : a.action === 'like' ? 'react' : null;
    if (step && a.status === 'done') s.steps[step]++;
    if (step && a.status === 'failed') s.steps.failed++;
  }
  const pauses = await store.enginePauses();
  const held = E.pausedKeys(pauses);
  const accounts = (teamById(ctx, team).accounts || []).map((a) => a.key);
  const paused = !!held['*'] || (accounts.length > 0 && accounts.every((k) => held[k]));
  return json({ team, automations: autos.map((a) => ({ ...a, applies_to: I.automationScope(a), last_7_days: sent[a.id] || blank() })), can_edit: ctx.maintainer || ctx.myTeams[team] === 'admin', daily_max: I.AUTOMATION_DAILY_MAX, post_types: I.POST_TYPES, paused });
}
async function engineAutomation(store, args, { who }) {
  const ctx = await context(store, who);
  const team = String(args.team || '');
  if (!E.canEditTeam(ctx, team)) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
  if (!(ctx.maintainer || ctx.myTeams[team] === 'admin')) return json({ ok: false, error: "Only the team's admins can change automations." });
  const now = new Date().toISOString();
  if (args.action === 'add') {
    const c = I.checkAutomation(args);
    if (!c.ok) return json(c);
    const rights = (await store.engineRights({ who })).map((r) => r.account_key);
    const fbs = (teamById(ctx, team).accounts || []).filter((a) => a.platform === 'facebook').map((a) => a.key);
    if (!fbs.some((k) => rights.includes(k))) return json({ ok: false, error: "Automations send as you, so you need a publishing right on at least one of the team's Facebook Pages." });
    if ((await store.engineAutomations({ team_ids: [team] })).length >= 20) return json({ ok: false, error: 'At most 20 automations per team.' });
    await store.engineInsertAutomation({ team_id: team, ...c.value, thread_id: args.thread_id ? String(args.thread_id) : null, created_by: who });
  } else if (args.action === 'update') {
    const cur = (await store.engineAutomations({ team_ids: [team] })).find((a) => a.id === Number(args.id));
    if (!cur) return json({ ok: false, error: 'No such automation.' });
    const keys = ['name', 'keywords', 'dm_text', 'reply_text', 'reply_texts', 'scope', 'post_type', 'thread_id', 'platforms', 'skip_repeat', 'tag', 'hand_to'];
    const merged = Object.fromEntries(keys.map((k) => [k, args[k] !== undefined ? args[k] : cur[k]]));
    const c = I.checkAutomation(merged);
    if (!c.ok) return json(c);
    if (!await store.engineUpdateAutomation(cur.id, team, { ...c.value, thread_id: merged.thread_id ? String(merged.thread_id) : null, updated_at: now, updated_by: who })) return json({ ok: false, error: 'No such automation.' });
  } else if (['pause', 'resume'].includes(args.action)) {
    if (!await store.engineUpdateAutomation(args.id, team, { active: args.action === 'resume', updated_at: now, updated_by: who })) return json({ ok: false, error: 'No such automation.' });
  } else if (args.action === 'remove') {
    if (!await store.engineUpdateAutomation(args.id, team, null)) return json({ ok: false, error: 'No such automation.' });
  } else return json({ ok: false, error: 'action is add, update, pause, resume or remove.' });
  return engineAutomationsList(store, { team }, { who });
}

async function engineInboxHistory(store, args, { who }) {
  const ctx = await context(store, who);
  const team = String(args.team || '');
  if (!E.canEditTeam(ctx, team)) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
  return json({ team, actions: await store.engineInboxActions({ team_ids: [team], limit: Math.min(500, Number(args.limit) || 200) }) });
}

// Listening › Parliament [Phase 3, chosen 2 Nov]: UK parliaments' triaged
// items on our issues, read-only from the Parliamentary Monitor (lib/parl.js).
// Ten-minute memory per team and window.
const PARL_MEMO = new Map();
async function engineParliament(store, args, { who }) {
  const ctx = await context(store, who);
  const team = String(args.team || '');
  if (!E.canEditTeam(ctx, team)) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
  const P = require('../lib/parl');
  if (!P.TEAM_PARLIAMENTS[team]) return json({ team, covered: [], items: [], upcoming: [], note: 'The Parliamentary Monitor feed covers the UK team for now.' });
  const days = Math.min(60, Math.max(1, Number(args.days) || 21));
  const key = `${team}:${days}`; const hit = PARL_MEMO.get(key);
  if (hit && !args.fresh && Date.now() - hit.at < 10 * 60e3) return json({ ...hit.data, cached_at: new Date(hit.at).toISOString() });
  try {
    const data = await P.feed(team, { days });
    PARL_MEMO.set(key, { at: Date.now(), data });
    return json(data);
  } catch (e) {
    if (e.code === 'PARL_NOT_CONFIGURED') return json({ team, configured: false, covered: [], items: [], upcoming: [], note: e.message });
    throw err(e.message, 'ENGINE_UNAVAILABLE');
  }
}

// Tools › Link in bio [Phase 3, chosen 2 Nov; parity features 2 Nov]: the
// team's public page (/links/<slug>) and its buttons. Only the team's own
// members see or change it. action get (default): settings, every button in
// page order with its section, whether it shows (and why not), its clicks
// and signatures from the bio in the last 30 days, the petition's Bluebook
// total and Asana hints; plus page views by source, click rate and a daily
// series. action save: slug, title, intro, auto, settings and the saved
// buttons in order.
async function engineBio(store, args, { who }) {
  const B = require('../lib/bio');
  const ctx = await context(store, who);
  const team = teamById(ctx, String(args.team || ''));
  if (!team || !E.canEditTeam(ctx, team.id)) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
  let bio = await store.engineBio({ team_id: team.id });
  if (args.action === 'save') {
    const set = B.checkSettings({ slug: args.slug || (bio && bio.slug) || team.id, title: args.title != null ? args.title : bio && bio.title, intro: args.intro != null ? args.intro : bio && bio.intro, auto: args.auto != null ? args.auto : !(bio && bio.auto === false), settings: args.settings != null ? args.settings : (bio && bio.settings) || {} });
    if (set.error) throw err(set.error, 'ENGINE_REFUSED');
    const items = Array.isArray(args.items) ? args.items.slice(0, 40).map(B.cleanItem).filter(Boolean).map(({ image, ...i }) => i) : (bio && bio.items) || [];
    try { bio = await store.engineSaveBio({ team_id: team.id, ...set, items, updated_at: new Date().toISOString(), updated_by: who }); }
    catch (e) { if (e.status === 409) throw err('Another team already uses that page address.', 'ENGINE_REFUSED'); throw e; }
  }
  bio = bio || { team_id: team.id, slug: team.id, title: `CitizenGO ${team.name || ''}`.trim(), intro: '', auto: true, items: [], settings: {}, unsaved: true };
  const L = await B.load(store, { team, bio });
  const days = 30, now = Date.now();
  const since = new Date(now - days * 864e5).toISOString().slice(0, 10);
  const clicks = {}, views = {}, daily = {};
  if (!bio.unsaved) for (const c of await store.engineBioClicks({ slug: bio.slug, since }).catch(() => [])) {
    const n = c.clicks || 0;
    if (String(c.item_id).startsWith('_v')) {
      const src = String(c.item_id).split(':')[1] || 'other';
      views[src] = (views[src] || 0) + n; daily[c.day] = (daily[c.day] || 0) + n;
    } else clicks[c.item_id] = (clicks[c.item_id] || 0) + n;
  }
  // Signatures from the bio: Copilot codes marked BIO for each petition, in
  // the petition's own list (en_gb for an en-gb link).
  const sigs = {};
  const bioSigRows = store.bioSignatures ? await store.bioSignatures().catch(() => []) : [];
  const listOf = (url) => { const m = String(url || '').match(/citizengo\.org\/([a-z]{2})-([a-z]{2})\//i); return m ? `${m[1]}_${m[2]}`.toLowerCase() : null; };
  const lists = Object.fromEntries(L.all.filter((i) => i.petition_id).map((i) => [i.petition_id, listOf(i.url)]));
  for (const r of bioSigRows) {
    const pid = String(r.petition_id || ''); if (!(pid in lists)) continue;
    if (lists[pid] && !String(r.campaign_code).startsWith(lists[pid] + '-')) continue;
    sigs[pid] = (sigs[pid] || 0) + (Number(r.signatures) || 0);
  }
  const shown = new Set(L.shown.map((i) => i.id));
  const savedIds = new Set(((!bio.unsaved && bio.items) || []).map((i) => String(i.id)));
  const totalViews = Object.values(views).reduce((a, b) => a + b, 0);
  const totalClicks = Object.values(clicks).reduce((a, b) => a + b, 0);
  const series = [];
  for (let d = days - 1; d >= 0; d--) { const k = new Date(now - d * 864e5).toISOString().slice(0, 10); series.push({ day: k, views: daily[k] || 0 }); }
  return json({ team: team.id, bio: { slug: bio.slug, title: bio.title, intro: bio.intro || '', auto: bio.auto !== false, settings: B.cleanSettings(bio.settings || {}), saved: !bio.unsaved, updated_at: bio.updated_at || null, updated_by: bio.updated_by || null },
    path: `/links/${bio.slug}`, qr: `/links/${bio.slug}/qr.svg`, sources: B.SOURCES, sections: B.SECTIONS,
    hero: L.hero ? L.hero.id : null, grid: L.tiles.length, socials: L.socials,
    items: L.all.map((i) => {
      const st = i.petition_id ? L.status[i.petition_id] || null : null;
      return { ...i, saved: savedIds.has(i.id), shown: shown.has(i.id), clicks: clicks[i.id] || 0, signatures: i.petition_id ? sigs[i.petition_id] || 0 : null,
        total: st && st.total != null ? st.total : null, last14: st && st.last14 != null ? st.last14 : null, asana_closed: !!(st && st.asana_closed), asana_victory: !!(st && st.asana_victory), asana_project: (st && st.asana_project) || null,
        last_posted: (L.auto.find((a) => a.id === i.id) || {}).last_posted || null };
    }),
    stats: { days, views: totalViews, views_by_source: views, clicks: totalClicks, rate: totalViews ? Math.round((100 * totalClicks) / totalViews) : null, signatures: Object.values(sigs).reduce((a, b) => a + b, 0), daily: series },
    total_clicks: totalClicks, auto_days: B.AUTO_DAYS, quiet_days: B.QUIET_DAYS, win_days: B.WIN_DAYS });
}

// Calendar › Instagram grid [Phase 3, chosen 2 Nov]: each of the team's
// Instagram accounts with its latest posts from the nightly collection, so
// the desk can lay the planned posts on top of the live profile.
async function engineIgGrid(store, args, { who }) {
  const ctx = await context(store, who);
  const team = String(args.team || '');
  const t = teamById(ctx, team);
  if (!t) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
  const igs = (t.accounts || []).filter((a) => a.platform === 'instagram');
  const accounts = await Promise.all(igs.map(async (a) => {
    const media = (a.ig_id || a.handle) ? await store.igGridMedia({ ig_user_id: a.ig_id || null, username: a.ig_id ? null : a.handle, limit: 12 }) : [];
    return { key: a.key, name: a.name, handle: a.handle || (media[0] && media[0].ig_username) || null, media: media.map((m) => ({ id: m.media_id, type: m.media_type, product: m.media_product_type, caption: String(m.caption || '').slice(0, 140), url: m.permalink, img: m.thumbnail_url || null, at: m.timestamp })) };
  }));
  return json({ team, accounts });
}

// Inbox › Team [Phase 3, 2 Nov]: who has what, reply times and when comments
// arrive, over the last `days` (default 7, up to 30).
async function engineInboxTeam(store, args, { who }) {
  const ctx = await context(store, who);
  const team = String(args.team || '');
  if (!E.canEditTeam(ctx, team)) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
  const days = Math.min(30, Math.max(1, Number(args.days) || 7));
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const [items, open, actions, members, rules] = await Promise.all([
    store.engineInbox({ team_ids: [team], since, limit: 1000 }),
    store.engineInbox({ team_ids: [team], statuses: ['open'], limit: 1000 }),
    store.engineInboxActions({ team_ids: [team], limit: 1000 }),
    store.engineMembers({ team_id: team }),
    store.engineInboxRules ? store.engineInboxRules({ team_ids: [team] }).catch(() => []) : [],
  ]);
  const ids = new Set(items.map((i) => i.id));
  const all = items.concat(open.filter((i) => !ids.has(i.id)));
  const recent = actions.filter((a) => a.created_at >= since);
  const zone = E.teamZone(teamById(ctx, team));
  const stats = I.teamStats({ items: all, actions: recent, people: members.map((m) => m.who), tz: zone.tz, hostile: (i) => I.isHostile(i.text, rules) });
  stats.hours.forEach((h) => { h.arrived = 0; });
  for (const i of items) if (!i.from_us) stats.hours[hourIn(i.created_at, zone.tz).hour].arrived++;
  const checks = Object.fromEntries(members.map((m) => [m.who, !!m.needs_check]));
  stats.people = (stats.people || []).map((p) => ({ ...p, needs_check: !!checks[p.who] }));
  return json({ team, days, zone, ...stats, checker: isChecker(ctx, team), partial: items.length >= 1000 || actions.length >= 1000 });
}

// Analytics [slice 3, chosen 1 Nov]: the desk's dashboard as one structured
// answer, built from the same handlers the reporting tools use (their `data`,
// which the MCP text answers drop), so the figures match what Claude reports.
// scope: citizengo (every CitizenGO Page, the default), hazteoir (shown
// apart, never mixed into CitizenGO totals) or team (one of your teams).
const IS_CGO = /citizen\s?go/i;
const IS_HO = /hazte\s?o[ií]r/i;
// A post's language from its common words (no paid AI): en, es, pt, fr, it,
// de, pl, hu, sk, nl, hr; null when it can't tell.
const LANG_WORDS = {
  en: 'the and to of is that for you this with are our we be have not', es: 'el la los las que y en por para una con del es se su hoy ahora aquí muy hasta',
  pt: 'os as e em uma com do da não é você também está são muito pelo pela nos', fr: 'le la les des que de et en pour une avec du est pas ne',
  it: 'il la le che di e per una con del della non è sono', de: 'der die das und ist nicht mit für ein eine zu den von',
  pl: 'i w na nie się to że jest z do jak dla', hu: 'a az és hogy nem is egy meg már van', sk: 'a sa na je to že v do nie aj',
  nl: 'de het een en van is dat niet voor op met', hr: 'i je u na da se za ne su od',
};
const LANG_SETS = Object.fromEntries(Object.entries(LANG_WORDS).map(([k, v]) => [k, new Set(v.split(' '))]));
function langOf(text) {
  const words = String(text || '').toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  if (words.length < 4) return null;
  let best = null, top = 0;
  const uniq = [...new Set(words)];
  for (const [k, set] of Object.entries(LANG_SETS)) { const n = uniq.filter((w) => set.has(w)).length; if (n > top) { top = n; best = k; } }
  return top >= 2 ? best : null;
}
const median = (xs) => { const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null; };
// One post shared to a second Page (UK to Scotland) comes back once per Page
// with the same link: keep its first, original appearance.
const oncePerLink = (rows) => { const seen = new Set(); return rows.filter((r) => { const k = r.permalink_url || r.url; if (!k) return true; if (seen.has(k)) return false; seen.add(k); return true; }); };
const sumOf = (xs) => { const v = xs.filter((x) => typeof x === 'number'); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
// Analytics round two (3 Nov 2026): the report, the ranked posts and the
// Conversations figures for one window and its comparison window.
async function roundTwo(store, { pageIds, team, from, to, cfrom, cto }) {
  const { TOOLS } = require('./tools');
  const AX = require('../lib/analytics-extra');
  const run = (name, a) => TOOLS.find((t) => t.name === name).handler(store, a);
  const postsIn = async (since, until) => (since ? ((((await run('top_posts', { since, until, sort: 'views', compact: true, limit: 1000 })).data) || {}).rows || []).filter((r) => pageIds.has(r.page_id)) : []);
  const grow = (since, until) => (since && store.pageGrowth ? store.pageGrowth({ since, until }).catch(() => []) : []);
  // A day of follower counts before the window, so the first day has one to carry.
  const before = new Date(Date.parse(`${from}T00:00:00Z`) - 7 * 864e5).toISOString().slice(0, 10);
  const [growth, growthPrev, posts, postsPrev] = await Promise.all([grow(before, to), grow(cfrom, cto), postsIn(from, to), postsIn(cfrom, cto)]);
  const med = {};
  for (const id of pageIds) med[id] = median(posts.filter((r) => r.page_id === id).map((r) => r.views_total));
  const report = AX.report({ growth, growthPrev, posts, postsPrev, pageIds, from, to, cfrom, cto, med });
  const ranked = AX.ranked(oncePerLink(posts), { med, fbFormat, langOf });
  let talk = null;
  if (team) {
    const since = `${from}T00:00:00Z`, until = `${to}T23:59:59Z`;
    const [items, actions] = await Promise.all([
      store.engineInbox({ team_ids: [team.id], since, limit: 1000 }).catch(() => []),
      store.engineInboxActions({ team_ids: [team.id], statuses: ['done'], limit: 1000 }).catch(() => []),
    ]);
    const inWin = (t) => t >= since && t <= until;
    const tz = E.teamZone(team).tz;
    talk = AX.conversations(items.filter((i) => inWin(i.created_at)), actions.filter((a) => inWin(a.created_at)), {
      dates: report.dates, hourOf: (iso) => hourIn(iso, tz).hour,
      toneOf: (text) => { const t = SENT.toneOf(text, { lang: langOf(text) }); return t ? t.tone : null; },
    });
    talk.partial = items.length >= 1000 || actions.length >= 1000;
  }
  return { report, ranked, talk, zone: E.teamZone(team) };
}
async function rangeCompute(store, args, { who }) {
  const ctx = await context(store, who);
  const scope = ['citizengo', 'hazteoir', 'team'].includes(args.scope) ? args.scope : 'citizengo';
  let team = null;
  if (scope === 'team') {
    team = teamById(ctx, String(args.team || ''));
    if (!team || !E.canEditTeam(ctx, team.id)) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
  }
  const fbIds = ((team && team.accounts) || []).filter((a) => a.platform === 'facebook' && a.page_id).map((a) => a.page_id);
  const pagesAll = (await store.loadAll()).pages || [];
  const inScope = (page) => (scope === 'team' ? fbIds.includes(page.page_id) : scope === 'citizengo' ? IS_CGO.test(page.name || '') : !IS_CGO.test(page.name || ''));
  const pageIds = new Set(pagesAll.filter(inScope).map((p) => p.page_id));
  const two = await roundTwo(store, { pageIds, team, from: args.from, to: args.to, cfrom: args.cfrom, cto: args.cto });
  return json({ scope, team: team ? team.id : null, custom: true, days: args.days, from: args.from, to: args.to, counts: { facebook_pages: pageIds.size }, ...two });
}

async function analyticsCompute(store, args, { who }) {
  const ctx = await context(store, who);
  if (!ctx.maintainer && !Object.keys(ctx.myTeams).length) throw err('Join a Content Engine team to see Analytics.', 'ENGINE_NOT_MEMBER');
  if (!ctx.maintainer) {
    const off = (store.engineAccessLimits ? await store.engineAccessLimits({ who }) : []).filter((l) => l.account_key === '*' && l.can_analytics === false).map((l) => l.team_id);
    if (Object.keys(ctx.myTeams).every((t) => off.includes(t))) throw err("A team admin has turned Analytics off for you.", 'ENGINE_NOT_ALLOWED');
  }
  const scope = ['citizengo', 'hazteoir', 'team'].includes(args.scope) ? args.scope : 'citizengo';
  const days = [7, 30, 90].includes(Number(args.days)) ? Number(args.days) : 30;
  let team = null;
  if (scope === 'team') {
    team = teamById(ctx, String(args.team || ''));
    if (!team || !E.canEditTeam(ctx, team.id)) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
  }
  const { TOOLS } = require('./tools');
  const xtools = require('./x-tools');
  const run = (list, name, a) => list.find((t) => t.name === name).handler(store, a);
  const acc = (team && team.accounts) || [];
  const fbIds = acc.filter((a) => a.platform === 'facebook' && a.page_id).map((a) => a.page_id);
  const igNames = acc.filter((a) => a.platform === 'instagram' && a.handle).map((a) => a.handle.toLowerCase());
  const xHandles = acc.filter((a) => a.platform === 'x' && a.handle).map((a) => a.handle.toLowerCase());
  const pagesAll = (await store.loadAll()).pages || [];
  const inScope = (page) => (scope === 'team' ? fbIds.includes(page.page_id) : scope === 'citizengo' ? IS_CGO.test(page.name || '') : !IS_CGO.test(page.name || ''));
  const pageIds = new Set(pagesAll.filter(inScope).map((p) => p.page_id));
  const pageNames = new Set(pagesAll.filter(inScope).map((p) => p.name));

  // Page-level growth (Facebook) and Instagram follower movement.
  const growth = (await run(TOOLS, 'page_growth', { days })).data || { facebook: [], instagram: [] };
  const fb = (growth.facebook || []).filter((r) => pageNames.has(r.name));
  const ig = (growth.instagram || []).filter((r) => (scope === 'team' ? igNames.includes(String(r.name).toLowerCase()) : scope === 'citizengo' ? /citizengo/i.test(r.name) : !/citizengo/i.test(r.name)));

  // Every post in the window, each against its own Page's median.
  const tp = (await run(TOOLS, 'top_posts', { days, sort: 'views', compact: true, limit: 1000 })).data;
  const rows = ((tp && tp.rows) || []).filter((r) => pageIds.has(r.page_id));
  const med = {};
  for (const id of pageIds) med[id] = median(rows.filter((r) => r.page_id === id).map((r) => r.views_total));
  const top = oncePerLink(rows.filter((r) => typeof r.views_total === 'number').sort((a, b) => b.views_total - a.views_total || String(a.created_time).localeCompare(String(b.created_time)))).slice(0, 10).map((r) => ({
    page: r.page_name, text: String(r.message || '').slice(0, 140), url: r.permalink_url, created_time: r.created_time,
    views: r.views_total, x_median: med[r.page_id] ? Math.round((r.views_total / med[r.page_id]) * 10) / 10 : null,
    beyond_pct: r.beyond_followers_pct, engagement_rate: r.engagement_rate, shares: r.shares_total,
    engagements: r.engagement_total, format: fbFormat(r), lang: langOf(r.message),
  }));

  // Instagram posts (team: its linked Pages; otherwise every account, filtered by name).
  let igRows = [];
  for (const pid of scope === 'team' ? fbIds : [null]) {
    const d = (await run(TOOLS, 'instagram_posts', { days, sort: 'reach', limit: 100, ...(pid ? { page_id: pid } : {}) })).data;
    igRows = igRows.concat(Array.isArray(d) ? d : []);
  }
  if (scope !== 'team') igRows = igRows.filter((r) => (scope === 'citizengo' ? /citizengo/i.test(r.ig_username || '') : !/citizengo/i.test(r.ig_username || '')));
  const igTop = igRows.slice(0, 10).map((r) => ({
    account: r.ig_username, text: String(r.caption || '').slice(0, 140), url: r.permalink, created_time: r.timestamp, type: r.media_product_type || r.media_type,
    reach: r.reach, views: r.views, saves: r.saved, saves_per_1k: r.saves_per_1k_reached, rate: r.interaction_rate_pct, watch_s: r.reels_avg_watch_seconds,
  }));

  // X, if collected.
  let x = [];
  if (xtools.enabled()) {
    const to = new Date().toISOString().slice(0, 10), from = new Date(Date.now() - (days - 1) * 864e5).toISOString().slice(0, 10);
    const out = await run(xtools.X_TOOLS, 'x_period_summary', { from, to });
    x = ((out && out.rows) || []).filter((r) => {
      const u = String(r.username || '').toLowerCase();
      return scope === 'team' ? xHandles.includes(u) : scope === 'citizengo' ? /citizengo/i.test(u) : !/citizengo/i.test(u);
    }).map((r) => ({
      account: r.label || `@${r.username}`, posts: Number(r.posts || 0), impressions: Number(r.impressions || 0), engagements: Number(r.engagements || 0),
      rate: r.engagement_rate_pct, link_clicks: r.link_clicks, profile_clicks: r.profile_clicks ?? null, follower_change: r.followers_first === null || r.followers_first === undefined ? null : Number(r.followers_last) - Number(r.followers_first),
      followers: r.followers_last, top_text: r.top_post_text ? String(r.top_post_text).slice(0, 140) : null, top_url: r.top_post_url || null, top_impressions: r.top_post_impressions,
    }));
  }

  // 12-week trend: weekly reach, net follows and engagements for the scope's
  // biggest Pages (a team: all of its own), against the median CitizenGO Page.
  const trend = await weeklyTrend(store, { pagesAll, inScope, scope });
  const inbox = team ? await inboxFigures(store, team.id, days) : null;
  const now = Date.now();
  const teamPosts = team && store.enginePosts ? await store.enginePosts({ team_ids: [team.id], statuses: ['posted', 'scheduled'], limit: 500 }).catch(() => []) : [];
  const signatures = team && store.engineSignatures ? await signaturesFor(store, team.id, days, now, { posts: teamPosts }).catch(() => null) : null;
  const sigPrev = team && store.engineSignatures ? await signaturesFor(store, team.id, days, now - days * 864e5, { posts: teamPosts }).catch(() => null) : null;
  const zone = E.teamZone(team);
  const facebook = facebookDetail(rows, med, zone.tz);

  // Board C: what works, over 90 days whatever the window (enough posts to compare).
  const rows90 = days === 90 ? rows : (((await run(TOOLS, 'top_posts', { days: 90, sort: 'views', compact: true, limit: 1000 })).data || {}).rows || []).filter((r) => pageIds.has(r.page_id));
  const med90 = {};
  for (const id of pageIds) med90[id] = median(rows90.filter((r) => r.page_id === id).map((r) => r.views_total));
  const works = require('../lib/analytics-extra').works(oncePerLink(rows90), { med: med90, ukParts: (iso) => hourIn(iso, zone.tz), topicsOf: require('../lib/listen-topics').topicsOf, langOf, fbFormat });

  // Boards A and B: the window before this one, daily lines, what changed, campaigns.
  const AX = require('../lib/analytics-extra');
  const ymd = (t) => new Date(t).toISOString().slice(0, 10);
  const growthPrev = (await run(TOOLS, 'page_growth', { since: ymd(now - 2 * days * 864e5), until: ymd(now - (days + 1) * 864e5) })).data || { facebook: [], instagram: [] };
  const fbPrev = (growthPrev.facebook || []).filter((r) => pageNames.has(r.name));
  const igPrev = (growthPrev.instagram || []).filter((r) => (scope === 'team' ? igNames.includes(String(r.name).toLowerCase()) : scope === 'citizengo' ? /citizengo/i.test(r.name) : !/citizengo/i.test(r.name)));
  let xPrev = [];
  if (xtools.enabled() && x.length) {
    const out = await run(xtools.X_TOOLS, 'x_period_summary', { from: ymd(now - (2 * days - 1) * 864e5), to: ymd(now - days * 864e5) }).catch(() => null);
    xPrev = ((out && out.rows) || []).filter((r) => x.some((c) => c.account === (r.label || `@${r.username}`))).map((r) => ({ impressions: Number(r.impressions || 0) }));
  }
  const curT = AX.totals(fb, ig, x), prevT = AX.totals(fbPrev, igPrev, xPrev);
  if (sigPrev) prevT.signatures = sigPrev.total;
  if (signatures) curT.signatures = signatures.total;
  const daily = AX.dailySeries(store.pageGrowth ? await store.pageGrowth({ since: ymd(now - (days + 1) * 864e5) }).catch(() => []) : [], pageIds, { now, days });
  const changed = AX.whatChanged({ kpis: curT, prev: prevT, detail: facebook, top, sig: signatures, sigPrev, days, zone: zone.label });
  const campaignList = signatures ? AX.campaigns(signatures.linked || [], { fbRows: rows, igRows }) : null;
  // Signatures on the best posts, where a post was ours from the desk.
  if (signatures) { const by = {}; for (const p of signatures.linked || []) for (const u of p.urls || []) by[AX.postKey(u)] = p; for (const t of top) { const hit = by[AX.postKey(t.url)]; if (hit) t.signatures = hit.signatures; } }
  const instagramAll = team ? igRows.slice(0, 60).map((r) => ({
    account: r.ig_username, text: String(r.caption || '').slice(0, 140), url: r.permalink, created_time: r.timestamp, type: r.media_product_type || r.media_type,
    reach: r.reach, views: r.views, saves: r.saved, saves_per_1k: r.saves_per_1k_reached, rate: r.interaction_rate_pct, watch_s: r.reels_avg_watch_seconds, follows: r.follows,
  })) : null;

  const two = await roundTwo(store, { pageIds, team, from: ymd(now - days * 864e5), to: ymd(now - 864e5), cfrom: ymd(now - 2 * days * 864e5), cto: ymd(now - (days + 1) * 864e5) });
  return json({
    ...two,
    scope, team: team ? team.id : null, days, to: new Date().toISOString().slice(0, 10), trend, inbox, facebook: team ? facebook : null, instagram_all: instagramAll, signatures: signatures ? { ...signatures, linked: undefined } : null,
    previous: prevT, change: AX.changes(curT, prevT), daily, changed, campaigns: campaignList, works,
    counts: { facebook_pages: pageIds.size, instagram: ig.length, x: x.length },
    kpis: {
      reach: sumOf(fb.map((r) => r.reach)), views: sumOf(fb.map((r) => r.views)), engagements: sumOf(fb.map((r) => r.engagements)),
      net_follows: sumOf(fb.map((r) => r.netFollows)), followers: sumOf(fb.map((r) => r.followers)),
      ig_followers: sumOf(ig.map((r) => r.followers)), ig_new: sumOf(ig.map((r) => r.newFollowers)),
      x_impressions: sumOf(x.map((r) => r.impressions)), posts: rows.length,
    },
    pages: fb.map((r) => ({ name: r.name, followers: r.followers, reach: r.reach, views: r.views, engagements: r.engagements, net: r.netFollows, follows: r.newFollows, unfollows: r.unfollows })).sort((a, b) => (b.reach || 0) - (a.reach || 0)),
    instagram: ig.map((r) => ({ name: r.name, followers: r.followers, new: r.newFollowers, unfollows: r.unfollows, net: r.net })),
    top_posts: top, instagram_posts: igTop, x,
  });
}

// Board E, every country: each team's own Facebook Pages, reach and net
// follows against the window before, 12 weeks of weekly reach, signatures
// from its tracked links, and its best post against its Page's normal.
// 37E + 37C (Chris, 4 Nov): a friendly leaderboard of CitizenGO's own Facebook
// Pages (HazteOir kept apart), this window against the one before, so the desk
// can rank by any measure and show who moved. Trophies are picked on the desk.
// Only figures we already collect nightly; nothing about other organisations.
async function leaderboardCompute(store, ctx, days, now = Date.now()) {
  const { TOOLS } = require('./tools');
  const run = (name, a) => TOOLS.find((t) => t.name === name).handler(store, a);
  const ymd = (t) => new Date(t).toISOString().slice(0, 10);
  const all = await store.loadAll();
  const pages = (all.pages || []).filter((p) => !IS_HO.test(p.name || ''));
  const byName = Object.fromEntries(pages.map((p) => [p.name, p]));
  const pStart = now - 2 * days * 864e5, cStart = now - days * 864e5;
  const [cur, prev, tp] = await Promise.all([
    run('page_growth', { days }), run('page_growth', { since: ymd(pStart), until: ymd(cStart - 864e5) }),
    run('top_posts', { days, sort: 'views', compact: true, limit: 1000 }),
  ]);
  const count = { cur: {}, prev: {} };
  for (const x of all.posts || []) {
    const t = Date.parse(x.created_time); if (!t) continue;
    const k = t >= cStart ? 'cur' : t >= pStart ? 'prev' : null; if (k) count[k][x.page_id] = (count[k][x.page_id] || 0) + 1;
  }
  const rowsTp = (tp.data && tp.data.rows) || [];
  const med = {};
  for (const r of rowsTp) if (typeof r.views_total === 'number') (med[r.page_id] = med[r.page_id] || []).push(r.views_total);
  for (const k of Object.keys(med)) med[k] = median(med[k]);
  const teamOf = {};
  for (const t of ctx.teams || []) for (const a of t.accounts || []) if (a.platform === 'facebook' && a.page_id) teamOf[a.page_id] = { id: t.id, flag: t.flag || '' };
  const fig = (r, posts) => {
    if (!r) return null;
    const start = typeof r.followers === 'number' && typeof r.netFollows === 'number' ? r.followers - r.netFollows : null;
    return { followers: r.followers, net_follows: r.netFollows, growth: start > 0 && r.netFollows != null ? Math.round((r.netFollows / start) * 1000) / 10 : null,
      engagements: r.engagements, reach: r.reach, posts: posts || 0,
      per_post: posts && r.engagements != null ? Math.round(r.engagements / posts) : null,
      per_1k: r.followers && r.engagements != null ? Math.round((r.engagements / r.followers) * 10000) / 10 : null };
  };
  const curRows = (cur.data && cur.data.facebook) || [], prevRows = (prev.data && prev.data.facebook) || [];
  const out = [];
  for (const r of curRows) {
    const p = byName[r.name]; if (!p) continue;
    const pr = prevRows.find((x) => x.name === r.name);
    const best = rowsTp.filter((x) => x.page_id === p.page_id && med[x.page_id] && typeof x.views_total === 'number').sort((a, b) => b.views_total - a.views_total)[0];
    const tm = teamOf[p.page_id] || null;
    // Shared cache: no viewer-specific fields here (the desk marks its own teams' Pages).
    out.push({ page_id: p.page_id, name: r.name, team: tm && tm.id, flag: tm ? tm.flag : '',
      cur: fig(r, count.cur[p.page_id]), prev: fig(pr, count.prev[p.page_id]),
      best: best ? { text: String(best.message || '').slice(0, 140), url: best.permalink_url, views: best.views_total, x: Math.round((best.views_total / med[best.page_id]) * 10) / 10 } : null });
  }
  return json({ scope: 'leaderboard', days, to: ymd(now), pages: out.filter((x) => x.cur && (x.cur.posts || x.cur.engagements)) });
}

async function countriesCompute(store, ctx, days, now = Date.now()) {
  const { TOOLS } = require('./tools');
  const AX = require('../lib/analytics-extra');
  const run = (name, a) => TOOLS.find((t) => t.name === name).handler(store, a);
  const ymd = (t) => new Date(t).toISOString().slice(0, 10);
  const teams = (ctx.teams || []).filter((t) => (t.accounts || []).some((a) => a.platform === 'facebook' && a.page_id));
  const pagesAll = (await store.loadAll()).pages || [];
  const nameOf = Object.fromEntries(pagesAll.map((p) => [p.page_id, p.name]));
  const groups = Object.fromEntries(teams.map((t) => [t.id, new Set(t.accounts.filter((a) => a.platform === 'facebook' && a.page_id).map((a) => a.page_id))]));
  const [cur, prev, tp, growthRows] = await Promise.all([
    run('page_growth', { days }), run('page_growth', { since: ymd(now - 2 * days * 864e5), until: ymd(now - (days + 1) * 864e5) }),
    run('top_posts', { days, sort: 'views', compact: true, limit: 1000 }),
    store.pageGrowth ? store.pageGrowth({ since: ymd(now - 13 * 7 * 864e5) }).catch(() => []) : [],
  ]);
  const rows = ((tp.data && tp.data.rows) || []);
  const med = {};
  for (const r of rows) (med[r.page_id] = med[r.page_id] || []).push(r.views_total);
  for (const k of Object.keys(med)) med[k] = median(med[k]);
  const weekly = AX.weeklyByGroup(growthRows, groups, { now });
  const out = [];
  for (const t of teams) {
    const names = new Set([...groups[t.id]].map((id) => nameOf[id]).filter(Boolean));
    const fb = ((cur.data && cur.data.facebook) || []).filter((r) => names.has(r.name));
    const fbp = ((prev.data && prev.data.facebook) || []).filter((r) => names.has(r.name));
    const c = AX.totals(fb, [], []), p = AX.totals(fbp, [], []);
    const best = rows.filter((r) => groups[t.id].has(r.page_id) && med[r.page_id] && typeof r.views_total === 'number').sort((a, b) => b.views_total / med[b.page_id] - a.views_total / med[a.page_id])[0];
    const sig = store.engineSignatures ? await signaturesFor(store, t.id, days, now).catch(() => null) : null;
    out.push({ id: t.id, name: t.name, flag: t.flag || '', pages: names.size, reach: c.reach, reach_prev: p.reach, change: AX.pct(c.reach, p.reach), net_follows: c.net_follows, engagements: c.engagements,
      weekly: weekly.series[t.id], signatures: sig ? sig.total : null,
      best: best ? { page: best.page_name, text: String(best.message || '').slice(0, 140), url: best.permalink_url, x: Math.round((best.views_total / med[best.page_id]) * 10) / 10, views: best.views_total, format: fbFormat(best), created_time: best.created_time } : null });
  }
  out.sort((a, b) => (b.reach || 0) - (a.reach || 0));
  return json({ scope: 'countries', days, to: ymd(now), weeks: weekly.weeks, teams: out });
}

// Tools section (Nov 2026). Page Inviter results: the extension's own daily
// reports per Page, the window before, the Pages' new follows over the same
// days, and each Page's most-reacted posts of the last 30 days.
async function engineInviter(store, args, { who }) {
  const ctx = await context(store, who);
  if (!ctx.maintainer && !Object.keys(ctx.myTeams).length) throw err('Join a Content Engine team first.', 'ENGINE_NOT_MEMBER');
  const days = [7, 30, 90].includes(Number(args.days)) ? Number(args.days) : 30;
  const T = require('../lib/tools-extra');
  const { TOOLS } = require('./tools');
  const run = (name, a) => TOOLS.find((t) => t.name === name).handler(store, a);
  const ymd = (t) => new Date(t).toISOString().slice(0, 10);
  const now = Date.now();
  const all = store.inviterUsage ? await store.inviterUsage({ since: ymd(now - (2 * days - 1) * 864e5) }).catch(() => []) : [];
  const cut = ymd(now - (days - 1) * 864e5);
  const rows = all.filter((r) => r.day >= cut), prev = all.filter((r) => r.day < cut);
  const growth = ((await run('page_growth', { days }).catch(() => ({}))).data || {}).facebook || [];
  const follows = Object.fromEntries(growth.map((g) => [g.name, { follows: g.newFollows ?? null, net: g.netFollows ?? null }]));
  const out = T.inviterSummary(rows, prev, follows);
  const tp = (((await run('top_posts', { days: 30, sort: 'recent', compact: true, limit: 1000 }).catch(() => ({}))).data || {}).rows || []);
  const ids = new Set(out.pages.map((p) => p.page_id));
  const posts = tp.filter((r) => ids.has(r.page_id) && typeof r.reactions_total === 'number').sort((a, b) => b.reactions_total - a.reactions_total).slice(0, 8)
    .map((r) => ({ page: r.page_name, text: String(r.message || '').slice(0, 120), url: r.permalink_url, created_time: r.created_time, reactions: r.reactions_total, comments: r.comments_total }));
  // days last: the summary's own per-day list is `daily`, so it can't overwrite the window length.
  return json({ ...out, days, posts });
}

// Tracked links: every link the team's posts carry (made by the morning run)
// and links made here, with the signatures Looker counted for each code.
// action make: one Copilot link per network for a petition, saved for the list.
async function engineLinks(store, args, { who }) {
  const ctx = await context(store, who);
  const team = String(args.team || '');
  if (!E.canEditTeam(ctx, team)) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
  const T = require('../lib/tools-extra');
  const D = require('../lib/desk');
  if (args.action === 'make') {
    const pet = T.petitionOf(String(args.url || ''));
    if (!pet) return json({ ok: false, error: 'Paste a citizengo.org petition link (with its number in it).' });
    const plats = (Array.isArray(args.platforms) ? args.platforms : []).filter((p) => ['facebook', 'instagram', 'x'].includes(p));
    if (!plats.length) return json({ ok: false, error: 'Pick at least one network.' });
    const series = Math.min(5, Math.max(1, Number(args.series) || 1));
    const made = [];
    for (const platform of plats) {
      const a = T.copilotArgs(pet, { platform, series, scope: args.scope, title: args.title });
      try {
        const r = await copilot.call(store, 'generate_social_url', { channel: 'social', trafficType: 'organic', ...a });
        if (!r || !r.shortUrl) { made.push({ platform, error: 'Copilot gave no short link.' }); continue; }
        const doc = { team, platform, series, short: r.shortUrl, long: r.fullUrl, campaign: String(r.campaignName || '').toLowerCase(), petition_url: pet.url, petition_title: args.title ? String(args.title).slice(0, 200) : null, reused: !!r.reused, by: who, at: new Date().toISOString() };
        await D.docsPut('toolLinks', `${team}-${doc.campaign || platform + Date.now()}`.slice(0, 190), doc, who).catch(() => {});
        made.push(doc);
      } catch (e) {
        made.push({ platform, error: e.code === 'COPILOT_SIGNED_OUT' ? 'The engine is not signed in to Campaign Copilot: Chris runs npm run copilot:adopt.' : `Copilot: ${e.message}` });
      }
    }
    return json({ ok: made.some((m) => !m.error), links: made });
  }
  const since = new Date(Date.now() - 90 * 864e5).toISOString();
  const posts = store.enginePosts ? await store.enginePosts({ team_ids: [team], statuses: ['posted', 'scheduled', 'approved'], limit: 500 }).catch(() => []) : [];
  const list = [];
  for (const p of posts) {
    const doc = p.doc || {}; const at = (doc.posted && doc.posted.at) || p.post_at || p.updated_at || '';
    if (at < since) continue;
    for (const [plat, l] of Object.entries(doc.links || {})) if (l && (l.short || l.campaign)) list.push({ short: l.short || null, long: l.long || null, campaign: String(l.campaign || '').toLowerCase() || null, platform: plat, used_in: p.title, post_id: p.id, status: p.status, petition_title: (doc.action && doc.action.title) || null, petition_url: (doc.action && doc.action.url) || null, by: l.via === 'copilot' ? 'Morning run' : null, at: l.at || at });
  }
  const mine = (await D.docsList('toolLinks', { team }).catch(() => [])).map((r) => r.data || {}).filter((d) => d.team === team);
  for (const d of mine) if (!list.some((x) => x.short && x.short === d.short)) list.push({ ...d, used_in: null, made_here: true });
  const sig = store.engineSignatures ? await store.engineSignatures({ codes: list.map((l) => l.campaign).filter(Boolean) }).catch(() => []) : [];
  const by = {}; let pulled = null;
  for (const r of sig) { const k = r.campaign_code; const o = by[k] = by[k] || { signatures: 0, new_members: 0 }; o.signatures += Number(r.signatures) || 0; o.new_members += Number(r.new_members) || 0; if (!pulled || r.pulled_at > pulled) pulled = r.pulled_at; }
  for (const l of list) Object.assign(l, by[l.campaign] || { signatures: 0, new_members: 0 });
  list.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return json({ team, links: list.slice(0, 300), pulled_at: pulled });
}

// Health check for a team: who can post where, pauses, and how fresh each
// data feed is. Nothing is changed.
async function engineHealth(store, args, { who }) {
  const ctx = await context(store, who);
  const team = teamById(ctx, String(args.team || ''));
  if (!team || !E.canEditTeam(ctx, team.id)) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
  const now = Date.now();
  const keys = new Set((team.accounts || []).map((a) => a.key));
  const pageIds = (team.accounts || []).filter((a) => a.platform === 'facebook' && a.page_id).map((a) => a.page_id);
  const pagesAll = (await store.loadAll().catch(() => ({ pages: [] }))).pages || [];
  const nameOf = Object.fromEntries(pagesAll.map((p) => [p.page_id, p.name]));
  const twoDays = new Date(now - 2 * 864e5).toISOString();
  const [tokens, rights, pauses, runs, peers, media, news, usage, sig] = await Promise.all([
    store.engineConnectedTokens ? store.engineConnectedTokens().catch(() => []) : [],
    store.engineMetaRights ? store.engineMetaRights().catch(() => []) : [],
    store.enginePauses ? store.enginePauses().catch(() => []) : [],
    store.latestRuns ? store.latestRuns(pageIds).catch(() => []) : [],
    store.peerAccounts ? store.peerAccounts().catch(() => []) : [],
    store.listenHashtagMedia ? store.listenHashtagMedia({ since: twoDays }).catch(() => []) : [],
    store.listenNews ? store.listenNews({ since: twoDays }).catch(() => []) : [],
    store.inviterUsage ? store.inviterUsage({ since: new Date(now - 90 * 864e5).toISOString().slice(0, 10) }).catch(() => []) : [],
    store.linkSignaturesPulled ? store.linkSignaturesPulled().catch(() => null) : null,
  ]);
  const inviterLast = {};
  for (const r of usage) if (!inviterLast[r.page_id] || r.day > inviterLast[r.page_id]) inviterLast[r.page_id] = r.day;
  const T = require('../lib/tools-extra');
  const myPauses = pauses.filter((p) => p.scope === 'all' || p.team_id === team.id || (p.account_keys || []).some((k) => keys.has(k)));
  const checks = T.healthChecks({ team, tokens: tokens.filter((t) => keys.has(t.account_key)), rights: rights.filter((r) => keys.has(r.account_key)), pauses: myPauses,
    runs: runs.map((r) => ({ ...r, name: nameOf[r.page_id] })), sigPulled: sig || null,
    peersChecked: peers.map((a) => a.last_checked_at).filter(Boolean).sort().pop() || null, listenRows: media.length, newsRows: news.length, inviterLast, now });
  return json({ team: team.id, checked_at: new Date(now).toISOString(), checks });
}

// Listening [slice 3, 1 Nov]: posts beating their own normal, as data.
// citizengo: other CitizenGO Pages' posts (not your team's), views against that
// Page's 90-day median. allies / opponents: the watched Instagram accounts
// (likes + comments against their own 120-day median, from ally_watch and
// opponent_watch), opponents with their Meta Ad Library issue ads. "Rework
// for…" on the desk files a Plan request; nothing here posts anything.
async function listeningCompute(store, args, { who }) {
  const ctx = await context(store, who);
  if (!ctx.maintainer && !Object.keys(ctx.myTeams).length) throw err('Join a Content Engine team to see Listening.', 'ENGINE_NOT_MEMBER');
  const tab = ['citizengo', 'allies', 'opponents'].includes(args.tab) ? args.tab : 'citizengo';
  const minX = Math.max(1.5, Math.min(50, Number(args.min_multiple) || 3));
  const team = args.team ? teamById(ctx, String(args.team)) : null;
  if (team && !E.canEditTeam(ctx, team.id)) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
  if (tab === 'citizengo') {
    const days = [7, 30].includes(Number(args.days)) ? Number(args.days) : 30;
    const { TOOLS } = require('./tools');
    const own = new Set(((team && team.accounts) || []).filter((a) => a.page_id).map((a) => a.page_id));
    const rows = ((await TOOLS.find((t) => t.name === 'top_posts').handler(store, { days: 90, sort: 'recent', compact: true, limit: 1000 })).data || {}).rows || [];
    const cgo = rows.filter((r) => (IS_CGO.test(r.page_name || '') || IS_HO.test(r.page_name || '')) && typeof r.views_total === 'number');
    const med = {};
    for (const r of cgo) (med[r.page_id] = med[r.page_id] || []).push(r.views_total);
    for (const k of Object.keys(med)) med[k] = median(med[k]);
    const since = Date.now() - days * 864e5;
    const posts = oncePerLink(cgo.filter((r) => !own.has(r.page_id) && Date.parse(r.created_time) >= since && med[r.page_id] && r.views_total >= minX * med[r.page_id])
      .map((r) => ({ who: r.page_name, page_id: r.page_id, post_id: r.post_id, text: String(r.message || '').slice(0, 300), url: r.permalink_url, created_time: r.created_time, format: r.media_type || r.status_type || null,
        views: r.views_total, x: Math.round((r.views_total / med[r.page_id]) * 10) / 10, beyond_pct: r.beyond_followers_pct, hazteoir: IS_HO.test(r.page_name || ''), lang: langOf(r.message) }))
      .sort((a, b) => b.x - a.x)).slice(0, 60);
    await markReworked(store, ctx, posts);
    await addPictures(store, posts);
    for (const p of posts) delete p.post_id;
    return json({ tab, days, min_multiple: minX, posts, topics: topicsOf(posts) });
  }
  const { PEER_TOOLS } = require('./peer-tools');
  const days = [7, 10, 30].includes(Number(args.days)) ? Number(args.days) : (tab === 'allies' ? 10 : 7);
  const out = await PEER_TOOLS.find((t) => t.name === (tab === 'allies' ? 'ally_watch' : 'opponent_watch')).handler(store, { days, min_multiple: minX, limit: 40, ...(tab === 'allies' && args.country ? { country: String(args.country) } : {}) });
  const posts = ((out && out.rows) || []).map((r) => ({ who: r.label || `@${r.username}`, handle: r.username, country: r.country || null, text: String(r.caption || '').slice(0, 300), url: r.permalink, created_time: r.timestamp,
    format: r.media_product_type || r.media_type || null, likes: r.like_count, comments: r.comments_count, x: r.vs_median === null || r.vs_median === undefined ? null : Number(r.vs_median), settled: !!r.settled, lang: langOf(r.caption), media_id: r.media_id }));
  await addPictures(store, posts);
  await addDayGain(store, posts);
  if (tab === 'allies') await markReworked(store, ctx, posts);
  const ads = tab === 'opponents' ? ((out && out.ads) || []).slice(0, 40).map((a) => ({ who: a.label || a.page_name, started: a.delivery_start, running: !a.delivery_stop, spend_lower: Number(a.spend_lower) || 0, spend_upper: Number(a.spend_upper) || Number(a.spend_lower) || 0, currency: a.currency || null, title: a.link_titles || a.bodies || null, url: a.snapshot_url || null })) : [];
  // Convergence reads every watched post from the last 48 hours, not only the breakouts.
  let converging = [], building = [];
  if (tab === 'allies') {
    const all = await PEER_TOOLS.find((t) => t.name === 'ally_watch').handler(store, { days: 3, limit: 200, sort: 'recent' });
    const recent = ((all && all.rows) || []).map((r) => ({ who: r.label || `@${r.username}`, handle: r.username, text: r.caption, url: r.permalink, created_time: r.timestamp, x: r.vs_median }));
    converging = convergence(recent);
    building = convergenceBuilding(recent, converging);
  }
  return json({ tab, days, min_multiple: minX, posts, ads, converging, building, topics: topicsOf(posts), note: out && !out.rows ? String(out.text || '').slice(0, 300) : null });
}

// 37A (4 Nov): each post's picture as img (a link to Meta's own copy, which
// expires; the desk shows the words when it does). Never fails Listening.
async function addPictures(store, posts) {
  if (!store.listenPictures || !posts.length) return;
  const pics = await store.listenPictures({ ig_ids: posts.map((p) => p.media_id).filter(Boolean), fb_ids: posts.map((p) => p.post_id).filter(Boolean) }).catch(() => ({}));
  for (const p of posts) { const u = pics[p.media_id] || pics[p.post_id]; if (u && /^https:\/\//.test(u)) p.img = u; }
}

// Listening › Topics: every watched Instagram post and every CitizenGO Facebook
// post of the last 28 days in the team's language (English; México: Spanish),
// sorted into campaign topics.
async function topicsOverview(store, now = Date.now(), lang = 'en') {
  const posts = (await listeningCorpus(store, now)).filter((p) => p.lang === lang);
  return json({ tab: 'overview', lang, ...require('../lib/listen-topics').overview(posts, { now, storyKeys }), read: posts.length });
}
// Listening › Watches: the team's watches matched against the same 28 days of
// posts (every language), cached by the watches' words.
async function watchesCompute(store, watches, now = Date.now()) {
  const posts = await listeningCorpus(store, now);
  return json({ tab: 'watches', watches: require('../lib/listen-topics').watchMatches(posts, watches, { now }), read: posts.length });
}
async function listeningCorpus(store, now = Date.now()) {
  const since = new Date(now - 28 * 864e5).toISOString();
  const { TOOLS } = require('./tools');
  const [peers, fb] = await Promise.all([
    store.peerRecent ? store.peerRecent({ since }).catch(() => []) : [],
    TOOLS.find((t) => t.name === 'top_posts').handler(store, { days: 90, sort: 'recent', compact: true, limit: 1000 }).then((r) => ((r.data || {}).rows || [])).catch(() => []),
  ]);
  const cgo = fb.filter((r) => IS_CGO.test(r.page_name || '') && typeof r.views_total === 'number');
  const med = {};
  for (const r of cgo) (med[r.page_id] = med[r.page_id] || []).push(r.views_total);
  for (const k of Object.keys(med)) med[k] = median(med[k]);
  return [
    ...oncePerLink(cgo.filter((r) => r.created_time >= since)).map((r) => ({ src: 'citizengo', who: r.page_name, text: r.message, url: r.permalink_url, created_time: r.created_time, views: r.views_total, lang: langOf(r.message), x: med[r.page_id] ? Math.round((r.views_total / med[r.page_id]) * 10) / 10 : null })),
    ...(peers || []).map((r) => ({ src: r.stance === 'opponent' ? 'opponents' : 'allies', who: r.label || `@${r.username}`, text: r.caption, url: r.permalink, created_time: r.timestamp, likes: r.like_count, comments: r.comments_count, lang: langOf(r.caption), x: r.vs_median == null ? null : Number(r.vs_median) })),
  ];
}

// What each watched post gained (likes + comments) between its last two daily
// reads: the "still moving" signal on Rising now. Missing when only one read.
async function addDayGain(store, posts) {
  const rows = posts.length && store.peerDayMetrics ? await store.peerDayMetrics(posts.map((p) => p.media_id).filter(Boolean)).catch(() => []) : [];
  const by = {};
  for (const r of rows) (by[r.media_id] = by[r.media_id] || []).push((Number(r.like_count) || 0) + (Number(r.comments_count) || 0));
  for (const p of posts) {
    const l = by[p.media_id];
    if (l && l.length >= 2) p.gain_day = Math.max(0, l[l.length - 1] - l[l.length - 2]);
    delete p.media_id;
  }
}

// "Already reworked by": Plan requests (any team, last 60 days) that name the
// post's link, as team and status only.
async function markReworked(store, ctx, posts) {
  if (!posts.length || !store.engineRequests) return;
  const from = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
  const reqs = await store.engineRequests({ team_ids: ctx.teams.map((t) => t.id), from }).catch(() => []);
  for (const p of posts) {
    if (!p.url) continue;
    const hits = reqs.filter((r) => String(r.angle || '').includes(p.url));
    if (hits.length) p.reworked = hits.map((r) => { const t = teamById(ctx, r.team_id) || {}; return { team: r.team_id, name: t.name || r.team_id, flag: t.flag || '', status: r.status, post_id: r.post_id || null }; });
  }
}

// Topics: hashtags, links and names used by two or more of the posts shown.
function topicsOf(posts) {
  const by = {};
  for (const p of posts || []) for (const k of storyKeys(p.text)) (by[k] = by[k] || []).push(p);
  return Object.entries(by).map(([key, list]) => ({ key: key.replace(/^link:/, ''), kind: key.startsWith('#') ? 'hashtag' : key.startsWith('link:') ? 'link' : 'story', posts: list.length, accounts: new Set(list.map((p) => p.handle || p.who)).size, best_x: Math.max(...list.map((p) => Number(p.x) || 0)) }))
    .filter((t) => t.posts >= 2 && t.accounts >= 2).sort((a, b) => b.accounts - a.accounts || b.posts - a.posts).slice(0, 15);
}

// Facebook page for a team's Analytics: the best post, formats compared and
// the best hours to post (in the team's own time zone), from the window's posts. Medians, not
// averages, so one viral post doesn't make a format look better than it is.
const FORMAT_NAMES = { photo: 'Photo', video: 'Video', link: 'Link', album: 'Album', status: 'Text', share: 'Shared', event: 'Event' };
function fbFormat(r) {
  const t = String(r.media_type || r.status_type || '').toLowerCase();
  if (/reel/.test(t) || r.video_avg_seconds_watched != null) return 'Reel';
  for (const [k, v] of Object.entries(FORMAT_NAMES)) if (t.includes(k)) return v;
  return t ? t[0].toUpperCase() + t.slice(1) : 'Other';
}
// A time's hour and weekday in a team's time zone (UK by default).
function hourIn(iso, tz = E.DEFAULT_TZ) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false, weekday: 'short' }).formatToParts(new Date(iso));
  const g = (k) => (parts.find((p) => p.type === k) || {}).value;
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(g('weekday'));
  return { hour: Number(g('hour')) % 24, weekday, weekend: weekday >= 5 };
}
function facebookDetail(rows, med, tz) {
  const scored = rows.filter((r) => typeof r.views_total === 'number');
  if (!scored.length) return { posts: 0, formats: [], hours: [], best: null };
  const best = scored.slice().sort((a, b) => b.views_total - a.views_total)[0];
  const group = (keyOf) => { const g = {}; for (const r of scored) (g[keyOf(r)] = g[keyOf(r)] || []).push(r); return g; };
  const formats = Object.entries(group(fbFormat)).map(([format, list]) => ({
    format, posts: list.length, median_views: Math.round(median(list.map((r) => r.views_total))),
    median_rate: median(list.map((r) => r.engagement_rate)), median_beyond_pct: median(list.map((r) => r.beyond_followers_pct)), median_shares: median(list.map((r) => r.shares_total)),
  })).sort((a, b) => b.median_views - a.median_views);
  const slot = (r) => { const h = hourIn(r.created_time, tz); const b = Math.floor(h.hour / 3) * 3; return `${h.weekend ? 'Weekend' : 'Weekday'} ${String(b).padStart(2, '0')}:00–${String(b + 3).padStart(2, '0')}:00`; };
  const hours = Object.entries(group(slot)).filter(([, list]) => list.length >= 2).map(([when, list]) => ({ when, posts: list.length, median_views: Math.round(median(list.map((r) => r.views_total))) }))
    .sort((a, b) => b.median_views - a.median_views).slice(0, 6);
  const ranked = scored.slice().sort((a, b) => b.views_total - a.views_total).slice(0, 200).map((r, i) => ({
    rank: i + 1, page: r.page_name, text: String(r.message || '').slice(0, 140), url: r.permalink_url, created_time: r.created_time, format: fbFormat(r), lang: langOf(r.message),
    views: r.views_total, engagements: r.engagement_total, rate: r.engagement_rate, beyond_pct: r.beyond_followers_pct, shares: r.shares_total,
    x_median: med[r.page_id] ? Math.round((r.views_total / med[r.page_id]) * 10) / 10 : null,
  }));
  return {
    posts: scored.length, formats, hours, ranked,
    views: sumOf(scored.map((r) => r.views_total)), post_engagements: sumOf(scored.map((r) => r.engagement_total)),
    median_engagements: median(scored.map((r) => r.engagement_total)), median_rate: median(scored.map((r) => r.engagement_rate)),
    best: { page: best.page_name, text: String(best.message || '').slice(0, 200), url: best.permalink_url, created_time: best.created_time, views: best.views_total, beyond_pct: best.beyond_followers_pct, shares: best.shares_total, x_median: med[best.page_id] ? Math.round((best.views_total / med[best.page_id]) * 10) / 10 : null },
  };
}

// Signatures from social for a team's Analytics: the Looker pull (nightly on
// the Mini) joined to each post's tracked links by campaign code, for posts
// that went out in the window, plus the reply and DM links (by marker).
// Signatures count from the code's whole life, not only the window.
async function signaturesFor(store, teamId, days, now = Date.now(), { posts: given = null } = {}) {
  const since = new Date(now - days * 864e5).toISOString(), until = new Date(now).toISOString();
  const at = (p) => (p.doc && p.doc.posted && p.doc.posted.at ? p.doc.posted.at : p.post_at || '');
  const posts = (given || await store.enginePosts({ team_ids: [teamId], statuses: ['posted', 'scheduled'], limit: 500 }))
    .filter((p) => at(p) >= since && at(p) < until);
  const codeOf = {};
  for (const p of posts) for (const [plat, l] of Object.entries((p.doc && p.doc.links) || {})) if (l && l.campaign) codeOf[String(l.campaign).toLowerCase()] = { post: p, plat };
  const rows = await store.engineSignatures({ codes: Object.keys(codeOf), markers: true });
  const per = {};
  const marks = { DM: 0, RE: 0, ADM: 0, ARE: 0 };
  let pulled = null;
  for (const r of rows) {
    pulled = !pulled || r.pulled_at > pulled ? r.pulled_at : pulled;
    const hit = codeOf[r.campaign_code];
    if (hit) {
      const k = hit.post.id;
      const e = per[k] = per[k] || blankSig(hit.post);
      e.signatures += Number(r.signatures) || 0; e.new_members += Number(r.new_members) || 0;
      e.by_platform[hit.plat] = (e.by_platform[hit.plat] || 0) + (Number(r.signatures) || 0);
    }
    const m = String(r.campaign_code).match(/^[^-]+-[^-]+-(dm|re|adm|are)_/);
    if (m) marks[m[1].toUpperCase()] += Number(r.signatures) || 0;
  }
  const list = Object.values(per).sort((a, b) => b.signatures - a.signatures);
  // Every post with a tracked link, signatures or not, for Campaigns.
  const linked = {};
  for (const x of Object.values(codeOf)) linked[x.post.id] = per[x.post.id] || blankSig(x.post);
  return {
    total: list.reduce((n, p) => n + p.signatures, 0), new_members: list.reduce((n, p) => n + p.new_members, 0),
    posts_with_links: new Set(Object.values(codeOf).map((x) => x.post.id)).size, posts: list.slice(0, 30), linked: Object.values(linked), replies_and_dms: marks, pulled_at: pulled,
  };
}
function blankSig(post) {
  const doc = post.doc || {};
  return { id: post.id, title: post.title, posted_at: (doc.posted && doc.posted.at) || post.post_at, signatures: 0, new_members: 0, by_platform: {},
    action_url: (doc.action && doc.action.url) || null, action_title: (doc.action && doc.action.title) || null, urls: E.liveLinks(doc).map((l) => l.url) };
}

// The Inbox's own figures for a team's Analytics (Phase 2): what came in, how
// much we answered and how fast, and what was hidden or deleted, in the window.
async function inboxFigures(store, teamId, days, now = Date.now()) {
  const since = new Date(now - days * 864e5).toISOString();
  const [items, actions] = await Promise.all([
    store.engineInbox({ team_ids: [teamId], since, limit: 1000 }),
    store.engineInboxActions({ team_ids: [teamId], statuses: ['done'], limit: 1000 }),
  ]);
  const theirs = items.filter((i) => !i.from_us);
  const answered = theirs.filter((i) => i.replied_at);
  const mins = answered.map((i) => (Date.parse(i.replied_at) - Date.parse(i.created_at)) / 60000).filter((m) => m >= 0);
  const recent = actions.filter((a) => a.created_at >= since);
  const count = (pred) => recent.filter(pred).length;
  return {
    comments: theirs.filter((i) => i.kind === 'comment').length, messages: theirs.filter((i) => i.kind === 'message').length,
    answered: answered.length, answered_pct: theirs.length ? Math.round((100 * answered.length) / theirs.length) : null,
    median_reply_minutes: mins.length ? Math.round(median(mins)) : null,
    replies: count((a) => a.action === 'reply'), private_replies: count((a) => a.action === 'private_reply'),
    hidden: count((a) => a.action === 'hide' && !(a.detail && a.detail.auto)), auto_hidden: count((a) => a.action === 'hide' && a.detail && a.detail.auto),
    deleted: count((a) => a.action === 'delete'), on_ads: theirs.filter((i) => i.is_ad).length,
    // Phase 2: comment-to-DM links sent by automations, and tracked links in
    // replies and DMs (Copilot or the long fallback). Clicks need click data
    // from the shortener, not collected yet.
    automation_dms: count((a) => a.action === 'private_reply' && a.detail && a.detail.automation_id),
    automation_replies: count((a) => a.action === 'reply' && a.detail && a.detail.automation_id),
    tracked_links: recent.reduce((n, a) => n + ((a.detail && a.detail.links) || []).length, 0),
    tracked_links_long: recent.reduce((n, a) => n + ((a.detail && a.detail.links) || []).filter((l) => l.via === 'long').length, 0),
    link_clicks: null,
    capped: items.length >= 1000,
  };
}

// Convergence: the same hashtag, link or named story (two capitalised words
// together, e.g. "Prince Alois") used by at least CONVERGE_MIN watched accounts
// within 48 hours. Plain text matching, no paid AI.
const CONVERGE_MIN = 3, CONVERGE_MS = 48 * 3600_000;
const STOP_NAMES = new Set(['the', 'this', 'that', 'our', 'we', 'you', 'they', 'it', 'in', 'on', 'at', 'for', 'and', 'but', 'if', 'a', 'an', 'is', 'are', 'please', 'join', 'link', 'bio', 'click', 'read', 'watch', 'today', 'tonight', 'tomorrow', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
function storyKeys(text) {
  const t = String(text || '');
  const keys = new Set();
  for (const h of t.match(/#[\p{L}\p{N}_]{3,}/gu) || []) keys.add(h.toLowerCase());
  for (const u of t.match(/\bhttps?:\/\/[^\s)]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s)]+/gi) || []) keys.add(`link:${u.replace(/^https?:\/\/(www\.)?/i, '').replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase()}`);
  const words = t.split(/[^\p{L}\p{N}'-]+/u).filter(Boolean);
  for (let i = 0; i + 1 < words.length; i++) {
    const [a, b] = [words[i], words[i + 1]];
    if (/^\p{Lu}[\p{Ll}'-]+$/u.test(a) && /^\p{Lu}[\p{Ll}'-]+$/u.test(b) && !STOP_NAMES.has(a.toLowerCase()) && !STOP_NAMES.has(b.toLowerCase())) keys.add(`${a} ${b}`);
  }
  return [...keys];
}
// rows: { who, handle, text, url, created_time }. Returns stories used by
// CONVERGE_MIN+ different accounts within 48 hours, most accounts first.
function convergence(rows, now = Date.now()) {
  const by = {};
  for (const r of rows) {
    const at = Date.parse(r.created_time);
    if (!(at >= now - CONVERGE_MS)) continue;
    for (const k of storyKeys(r.text)) (by[k] = by[k] || []).push(r);
  }
  const out = [];
  for (const [key, list] of Object.entries(by)) {
    const accounts = [...new Set(list.map((r) => r.handle || r.who))];
    if (accounts.length < CONVERGE_MIN) continue;
    out.push({ key: key.replace(/^link:/, ''), kind: key.startsWith('#') ? 'hashtag' : key.startsWith('link:') ? 'link' : 'story', accounts: accounts.length,
      posts: list.sort((a, b) => String(a.created_time).localeCompare(String(b.created_time))).map((r) => ({ who: r.who, url: r.url, created_time: r.created_time, x: r.x })) });
  }
  // A story and its hashtag often name the same thing; keep the biggest per set of accounts.
  const seen = new Set();
  return out.sort((a, b) => b.accounts - a.accounts || b.posts.length - a.posts.length).filter((c) => { const sig = [...new Set(c.posts.map((p) => p.who))].sort().join('|'); if (seen.has(sig)) return false; seen.add(sig); return true; }).slice(0, 10);
}

// Convergence "building": a story one account has posted twice, or that two
// accounts share, in 48 hours: not an alert yet (that takes CONVERGE_MIN).
function convergenceBuilding(rows, converging = [], now = Date.now()) {
  const done = new Set(converging.map((c) => c.key));
  const seen = new Set();
  const by = {};
  for (const r of rows) { if (!(Date.parse(r.created_time) >= now - CONVERGE_MS)) continue; for (const k of storyKeys(r.text)) (by[k] = by[k] || []).push(r); }
  return Object.entries(by).map(([key, list]) => ({ key: key.replace(/^link:/, ''), raw: key, accounts: [...new Set(list.map((r) => r.handle || r.who))], list }))
    .filter((b) => !done.has(b.key) && b.accounts.length < CONVERGE_MIN && (b.accounts.length === 2 || b.list.length >= 2))
    .sort((a, b) => b.accounts.length - a.accounts.length || b.list.length - a.list.length)
    .filter((b) => { const sig = b.list.map((r) => `${r.handle || r.who}@${r.created_time}`).sort().join('|'); if (seen.has(sig)) return false; seen.add(sig); return true; }).slice(0, 8)
    .map((b) => ({ key: b.key, kind: b.raw.startsWith('#') ? 'hashtag' : b.raw.startsWith('link:') ? 'link' : 'story', accounts: b.accounts.length, posts: b.list.map((r) => ({ who: r.who, url: r.url, created_time: r.created_time })), needs: CONVERGE_MIN - b.accounts.length }));
}

const WEEKS = 12;
function weekStart(d) { const t = new Date(`${d}T00:00:00Z`); const wd = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - wd); return t.toISOString().slice(0, 10); }
async function weeklyTrend(store, { pagesAll, inScope, scope, now = Date.now() }) {
  // The last 12 COMPLETE weeks: a week still in progress would read as a collapse.
  const first = weekStart(new Date(now - WEEKS * 7 * 864e5).toISOString().slice(0, 10));
  const weeks = Array.from({ length: WEEKS }, (_, i) => new Date(Date.parse(`${first}T00:00:00Z`) + i * 7 * 864e5).toISOString().slice(0, 10));
  const rows = (await store.pageGrowth({ since: first })) || [];
  const cell = () => ({ reach: null, net: null, engagements: null });
  const add = (a, v) => (typeof v === 'number' ? (a || 0) + v : a);
  const by = {};
  for (const r of rows) {
    const w = weekStart(String(r.metric_date).slice(0, 10)), i = weeks.indexOf(w);
    if (i < 0) continue;
    const s = by[r.page_id] || (by[r.page_id] = weeks.map(cell));
    const c = s[i];
    c.reach = add(c.reach, r.media_view_unique); c.engagements = add(c.engagements, r.post_engagements);
    if (typeof r.daily_follows === 'number' || typeof r.daily_unfollows === 'number') c.net = (c.net || 0) + (r.daily_follows || 0) - (r.daily_unfollows || 0);
  }
  const name = Object.fromEntries(pagesAll.map((p) => [p.page_id, p.name]));
  const cgo = pagesAll.filter((p) => IS_CGO.test(p.name || '') && by[p.page_id]).map((p) => p.page_id);
  const metric = (ids, k) => weeks.map((_, i) => median(ids.map((id) => by[id][i][k])));
  const total = (id) => by[id].reduce((n, c) => n + (c.reach || 0), 0);
  const mine = pagesAll.filter((p) => inScope(p) && by[p.page_id]).map((p) => p.page_id).sort((a, b) => total(b) - total(a)).slice(0, 4);
  return {
    weeks,
    series: mine.map((id) => ({ name: name[id], reach: by[id].map((c) => c.reach), net: by[id].map((c) => c.net), engagements: by[id].map((c) => c.engagements) })),
    median: { name: 'CitizenGO median Page', reach: metric(cgo, 'reach'), net: metric(cgo, 'net'), engagements: metric(cgo, 'engagements') },
  };
}

// Reels and videos [1 Nov]: a published page can't reach Storage, so the desk
// sends the file here in pieces (action part), then asks for them to be
// checked (action done), which returns what goes in the post's final snapshot.
// The publisher on the Mini joins the pieces and uploads to Meta itself.
const VIDEO_PART_MAX = 2.5 * 1024 * 1024;
const VIDEO_MAX_BYTES = 150 * 1024 * 1024;
const VIDEO_MAX_PARTS = 64;
const VIDEO_TYPES = ['video/mp4', 'video/quicktime'];
async function engineVideo(store, args, { who }) {
  const ctx = await context(store, who);
  const post = await editablePost(store, ctx, args.id);
  if (['posted', 'rejected', 'archived'].includes(post.status)) return json({ ok: false, error: `A ${post.status} post can't take a new video.` });
  const upload = String(args.upload || '');
  if (!/^[a-z0-9]{8,32}$/.test(upload)) return json({ ok: false, error: 'upload must be 8-32 lowercase letters and digits.' });
  const prefix = `${post.team_id}/${String(post.id).replace(/[^a-z0-9-]/gi, '-')}/video-${upload}`;
  if (args.action === 'part') {
    const index = Number(args.index);
    if (!Number.isInteger(index) || index < 0 || index >= VIDEO_MAX_PARTS) return json({ ok: false, error: `A video is at most ${VIDEO_MAX_PARTS} pieces.` });
    const buf = Buffer.from(String(args.data || ''), 'base64');
    if (!buf.length) return json({ ok: false, error: 'No data received.' });
    if (buf.length > VIDEO_PART_MAX) return json({ ok: false, error: 'Each piece is at most 2.5 MB.' });
    await store.engineMediaUpload(`${prefix}/${String(index).padStart(3, '0')}.part`, buf, 'application/octet-stream');
    return json({ ok: true, index, bytes: buf.length });
  }
  if (args.action === 'done') {
    const parts = Number(args.parts), size = Number(args.size);
    const mime = String(args.mime || '');
    if (!VIDEO_TYPES.includes(mime)) return json({ ok: false, error: 'Videos must be MP4 or MOV.' });
    if (!/^[a-f0-9]{64}$/.test(String(args.sha256 || ''))) return json({ ok: false, error: 'sha256 must be the file\'s SHA-256 in hex.' });
    if (!(size > 0 && size <= VIDEO_MAX_BYTES)) return json({ ok: false, error: 'A video is at most 150 MB.' });
    if (!Number.isInteger(parts) || parts < 1 || parts > VIDEO_MAX_PARTS) return json({ ok: false, error: 'Wrong number of pieces.' });
    const have = await store.engineMediaList(prefix);
    const want = Array.from({ length: parts }, (_, i) => `${String(i).padStart(3, '0')}.part`);
    const missing = want.filter((n) => !have.some((h) => h.name === n));
    if (missing.length) return json({ ok: false, error: `${missing.length} piece${missing.length === 1 ? ' is' : 's are'} missing; send ${missing.length === 1 ? 'it' : 'them'} again.`, missing: missing.map((n) => Number(n.slice(0, 3))) });
    const total = have.filter((h) => want.includes(h.name)).reduce((n, h) => n + h.size, 0);
    if (total !== size) return json({ ok: false, error: `The pieces add up to ${total} bytes, not ${size}. Upload the video again.` });
    const video = { prefix, parts, size, sha256: String(args.sha256), mime, name: String(args.name || '').slice(0, 120) };
    await store.engineEvent({ post_id: post.id, team_id: post.team_id, who, action: 'video', detail: { size, parts } });
    return json({ ok: true, video });
  }
  return json({ ok: false, error: 'action is part or done.' });
}

// A signed link (1 hour) to a video preview stored for a post you can see in
// the desk (collector/video-preview.js puts them in the post's own folder).
async function enginePreview(store, args, { who }) {
  const ctx = await context(store, who);
  // Tools › Clip a video: a team's own clips, cut on the Mini into <team>/clips/<id>/.
  if (args.clip) {
    const team = String(args.team || '');
    if (!E.canEditTeam(ctx, team)) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
    const prefix = `${team}/clips/${String(args.clip).replace(/[^a-z0-9-]/gi, '-')}/`;
    const p = String(args.path || '');
    if (!p.startsWith(prefix) || p.includes('..') || !/\.mp4$/.test(p)) return json({ ok: false, error: 'That file is not part of this clip.' });
    const url = await store.engineMediaUrl(p, 3600);
    return url ? json({ ok: true, url, expires_in: 3600 }) : json({ ok: false, error: 'The clip could not be found.' });
  }
  const post = await editablePost(store, ctx, args.id);
  const prefix = `${post.team_id}/${String(post.id).replace(/[^a-z0-9-]/gi, '-')}/preview-`;
  const p = String(args.path || '');
  if (!p.startsWith(prefix) || p.includes('..') || !/\.mp4$/.test(p)) return json({ ok: false, error: 'That preview is not part of this post.' });
  const url = await store.engineMediaUrl(p, 3600);
  return url ? json({ ok: true, url, expires_in: 3600 }) : json({ ok: false, error: 'The preview could not be found.' });
}

async function engineMedia(store, args, { who }) {
  const ctx = await context(store, who);
  const post = await editablePost(store, ctx, args.id);
  if (!['facebook', 'instagram', 'story'].includes(args.platform)) return json({ ok: false, error: 'Images are stored for Facebook, Instagram or the Instagram Story.' });
  const index = Number(args.index || 0);
  if (!Number.isInteger(index) || index < 0 || index > 9) return json({ ok: false, error: 'Up to 10 images per post.' });
  const mime = String(args.mime || '');
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png' }[mime];
  if (!ext) return json({ ok: false, error: 'Images must be JPEG or PNG.' });
  const buf = Buffer.from(String(args.data || ''), 'base64');
  if (!buf.length) return json({ ok: false, error: 'No image received.' });
  if (buf.length > MEDIA_MAX_BYTES) return json({ ok: false, error: 'That image is over 3 MB.' });
  const magic = ext === 'jpg' ? buf[0] === 0xff && buf[1] === 0xd8 : buf.slice(0, 4).toString('hex') === '89504e47';
  if (!magic) return json({ ok: false, error: `That isn't a ${ext.toUpperCase()} image.` });
  const hash = require('crypto').createHash('sha256').update(buf).digest('hex').slice(0, 12);
  const safeId = String(post.id).replace(/[^a-z0-9-]/gi, '-');
  const path = `${post.team_id}/${safeId}/${args.platform}-${index}-${hash}.${ext}`;
  await store.engineMediaUpload(path, buf, mime);
  return json({ ok: true, path, bytes: buf.length });
}

// Slice 2: the "Connect Facebook" link for the signed-in person. The link
// names them, lasts ten minutes, and starts api/fb/authorize.js.
async function engineConnect(store, args, { who }) {
  await context(store, who);
  const fbflow = require('../lib/fbflow');
  const cfg = fbflow.config();
  if (!cfg.ok) return json({ ok: false, configured: false, error: 'Connecting Facebook is not switched on yet.' });
  const origin = String(process.env.PUBLIC_ORIGIN || '').replace(/\/+$/, '');
  if (!origin) return json({ ok: false, configured: false, error: 'Connecting Facebook is not switched on yet.' });
  return json({ ok: true, configured: true, url: `${origin}/api/fb/authorize?t=${encodeURIComponent(fbflow.signLink(cfg.secret, who))}`, expires_in: 600 });
}

// The bell [Priority One 21A, chosen 3 Nov]: what needs this person, inside
// the desk only (no email, phone or Slack). Built from what is already stored:
// Inbox items assigned to them, teammates' actions waiting for their check
// (admins), their own checked, sent back or failed actions, their posts
// approved, sent back or rejected by someone else, publishing failures on posts
// they made or approved, and their Facebook connection running out (20C:
// Meta asks people to sign in again every 90 days, counted from Connect).
const CONNECT_DAYS = 90;
async function engineBell(store, args, { who }) {
  const ctx = await context(store, who);
  const team = String(args.team || '');
  if (!E.canEditTeam(ctx, team)) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
  const now = Date.now(), since = new Date(now - 7 * 864e5).toISOString();
  const me = String(who).toLowerCase(), isMe = (x) => String(x || '').toLowerCase() === me;
  const safe = (p) => Promise.resolve(p).catch(() => []);
  const [open, acts, posts, conns, prefs] = await Promise.all([
    safe(store.engineInbox({ team_ids: [team], statuses: ['open'], limit: 500 })),
    safe(store.engineInboxActions({ team_ids: [team], limit: 300 })),
    safe(store.enginePosts({ team_ids: [team], limit: 300 })),
    store.engineMyConnections ? safe(store.engineMyConnections(who)) : [],
    store.enginePrefs ? Promise.resolve(store.enginePrefs(who)).catch(() => ({})) : {},
  ]);
  const out = [];
  const add = (o) => { if (o.at && o.at >= since) out.push(o); };
  const quote = (t) => `“${String(t || 'a post').replace(/\s+/g, ' ').trim().slice(0, 70)}”`;
  for (const i of open || []) if (isMe(i.assigned_to)) add({ id: `as:${i.id}`, kind: 'assigned', at: i.updated_at || i.created_at, text: `${i.author_name || 'Someone'}'s ${i.kind === 'message' ? 'message' : 'comment'} was assigned to you`, go: 'inbox:mine', ref: i.id });
  const ACT = { reply: 'reply', private_reply: 'private reply', hide: 'hide', unhide: 'unhide', delete: 'delete', ban: 'ban', like: 'like' };
  if (isChecker(ctx, team)) for (const a of acts || []) if (a.status === 'check' && !isMe(a.by)) add({ id: `ck:${a.id}`, kind: 'check', at: a.created_at, text: `${a.by} asked you to check a ${ACT[a.action] || a.action}`, go: 'inbox:check', ref: a.item_id });
  for (const a of acts || []) {
    if (!isMe(a.by)) continue;
    const d = a.detail || {}, what = ACT[a.action] || a.action;
    if (a.status === 'cancelled' && d.sent_back) add({ id: `sb:${a.id}`, kind: 'sent_back', at: a.done_at || a.created_at, text: `${d.checked_by || 'An admin'} sent back your ${what}${d.note ? `: ${String(d.note).slice(0, 120)}` : ''}`, go: 'inbox:inbox', ref: a.item_id });
    else if (a.status === 'failed') add({ id: `fa:${a.id}`, kind: 'failed', at: a.done_at || a.created_at, text: `Your ${what} didn't go through${a.result && a.result.error ? `: ${String(a.result.error).slice(0, 120)}` : ''}`, go: 'inbox:inbox', ref: a.item_id });
    else if (d.checked_by && ['queued', 'running', 'done'].includes(a.status)) add({ id: `ok:${a.id}`, kind: 'approved', at: d.checked_at || a.done_at || a.created_at, text: `${d.checked_by} approved your ${what}`, go: 'inbox:inbox', ref: a.item_id });
  }
  const teamRow = ctx.teams.find((t) => t.id === team) || {};
  const accName = (k) => { const a = (teamRow.accounts || []).find((x) => x.key === k); return a ? `${a.name || k} ${a.platform === 'instagram' ? 'Instagram' : a.platform === 'facebook' ? 'Facebook' : a.platform || ''}`.trim() : k; };
  const VERB = { scheduled: 'approved', hold: 'approved (on hold)', changes: 'sent back', rejected: 'rejected' };
  for (const p of posts || []) {
    const doc = p.doc || {}, r = doc.review || {};
    const mine = isMe(p.created_by) || isMe(doc.own && doc.own.who);
    if (mine && VERB[p.status] && r.by && !isMe(r.by)) add({ id: `pv:${p.id}:${r.at}`, kind: p.status === 'scheduled' || p.status === 'hold' ? 'approved' : 'sent_back', at: r.at, text: `${r.by} ${VERB[p.status]} ${quote(p.title || doc.title)}${r.note ? `: ${String(r.note).slice(0, 120)}` : ''}`, go: 'post', ref: p.id });
    if (mine || isMe(r.by)) for (const [slot, e] of Object.entries(doc.publishErrors || {})) if (e && e.at) add({ id: `pf:${p.id}:${slot}:${e.at}`, kind: 'failed', at: e.at, text: `Post failed: ${quote(p.title || doc.title)} on ${accName(slot)}${e.message ? `. ${String(e.message).slice(0, 160)}` : ''}`, go: 'post', ref: p.id });
  }
  const connections = (conns || []).filter((c) => c.connected_at).map((c) => {
    const ends = Date.parse(c.connected_at) + CONNECT_DAYS * 864e5;
    return { account_key: c.account_key, connected_at: c.connected_at, ends_at: new Date(ends).toISOString(), days_left: Math.ceil((ends - now) / 864e5) };
  }).sort((a, b) => a.days_left - b.days_left);
  const ending = connections.filter((c) => c.days_left <= 7);
  if (ending.length) {
    const c = ending[0];
    out.push({ id: `cn:${c.ends_at.slice(0, 10)}:${c.days_left <= 1 ? 1 : c.days_left <= 3 ? 3 : 7}`, kind: 'connection', at: new Date(Math.min(now, Date.parse(c.ends_at) - Math.max(0, c.days_left) * 864e5)).toISOString(), text: c.days_left > 0 ? `Your Facebook connection ends in ${c.days_left} day${c.days_left === 1 ? '' : 's'} (${ending.length} account${ending.length === 1 ? '' : 's'}). Renew it so scheduled posts keep going out.` : 'Your Facebook connection has ended. Renew it so scheduled posts go out.', go: 'renew' });
  }
  // 40A + 40C (4 Nov): problem reports. Chris sees new ones; whoever sent one sees when it's fixed.
  const reps = await reportsAll(store).catch(() => []);
  for (const r of reps) {
    if (ctx.maintainer && r.status === 'open' && !isMe(r.by)) add({ id: `rp:${r.id}`, kind: 'report', at: r.at, text: `${r.by} reported a problem${r.page ? ` on ${r.page}` : ''}: ${quote(r.text)}`, go: 'reports', ref: r.id });
    if (isMe(r.by) && r.status === 'fixed' && r.fixed_at) add({ id: `rf:${r.id}`, kind: 'fixed', at: r.fixed_at, text: `${r.fixed_by || 'Chris'} fixed the problem you reported: ${quote(r.text)}${r.reply ? ` · ${String(r.reply).slice(0, 120)}` : ''}`, go: 'reports', ref: r.id });
  }
  out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return json({ team, items: out.slice(0, 50), seen: (prefs && prefs.bell_seen) || null, connections });
}

// 40A + 40C (Chris, 4 Nov): "Report a problem" from the Help menu or a page's
// "?". Text and the page it came from only (no screenshots: an Inbox
// screenshot shows the public's comments). Only maintainers (Chris) see every
// report; people see their own. Deleted 30 days after it's marked fixed.
const REPORT_KEEP_DAYS = 30, REPORT_MAX_DAY = 20;
async function reportsAll(store) {
  if (store.reportsList) return store.reportsList();
  const D = require('../lib/desk');
  const cut = new Date(Date.now() - REPORT_KEEP_DAYS * 864e5).toISOString();
  try { await D.pg('DELETE', `engine_desk_docs?collection=eq.reports&data->>status=eq.fixed&data->>fixed_at=lt.${encodeURIComponent(cut)}`, undefined, 'return=minimal'); } catch (e) { /* sweep again next time */ }
  const rows = await D.docsList('reports', { limit: 500, engine: true });
  return rows.map((r) => ({ id: r.id, ...r.data }));
}
async function reportPut(store, id, doc, who) {
  if (store.reportsPut) return store.reportsPut(id, doc);
  return require('../lib/desk').docsPut('reports', id, doc, who, { engine: true });
}
async function engineReport(store, args, { who }) {
  const ctx = await context(store, who);
  if (!ctx.maintainer && !Object.keys(ctx.myTeams).length) throw err('Join a Content Engine team to use the desk.', 'ENGINE_NOT_MEMBER');
  const action = String(args.action || 'list');
  const all = (await reportsAll(store)).filter((r) => !(r.status === 'fixed' && Date.parse(r.fixed_at) < Date.now() - REPORT_KEEP_DAYS * 864e5));
  const mine = (r) => String(r.by || '').toLowerCase() === String(who).toLowerCase();
  if (action === 'send') {
    const text = String(args.text || '').trim().slice(0, 2000);
    if (text.length < 3) return json({ ok: false, error: 'Say what went wrong first.' });
    const team = args.team ? String(args.team) : null;
    if (team && !E.canEditTeam(ctx, team)) return json({ ok: false, error: 'You are not in that team.' });
    if (all.filter((r) => mine(r) && Date.parse(r.at) > Date.now() - 864e5).length >= REPORT_MAX_DAY) return json({ ok: false, error: 'That is a lot of reports today: tell Chris directly.' });
    const at = new Date().toISOString();
    const id = `r-${at.replace(/\D/g, '').slice(0, 14)}-${require('crypto').randomBytes(3).toString('hex')}`;
    const doc = { by: who, team, page: String(args.page || '').slice(0, 120) || null, text, at, status: 'open' };
    await reportPut(store, id, doc, who);
    return json({ ok: true, report: { id, ...doc } });
  }
  if (action === 'fix' || action === 'reopen') {
    if (!ctx.maintainer) return json({ ok: false, error: 'Only Chris can mark reports fixed.' });
    const r = all.find((x) => x.id === String(args.id || ''));
    if (!r) return json({ ok: false, error: 'No such report (fixed reports go after 30 days).' });
    const { id, ...rest } = r;
    const doc = action === 'fix' ? { ...rest, status: 'fixed', fixed_at: new Date().toISOString(), fixed_by: who, reply: args.reply ? String(args.reply).slice(0, 500) : null } : { ...rest, status: 'open', fixed_at: null, fixed_by: null, reply: null };
    await reportPut(store, id, doc, who);
    return json({ ok: true, report: { id, ...doc } });
  }
  const list = (ctx.maintainer ? all : all.filter(mine)).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 200);
  return json({ ok: true, maintainer: !!ctx.maintainer, reports: list, keep_days: REPORT_KEEP_DAYS });
}

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const ENGINE_TOOLS = [
  { name: 'engine_report', description: 'Content Engine desk: report a problem with the desk (action send: text, page, team), list reports (Chris sees all, everyone else their own), or for Chris mark one fixed or open again (action fix / reopen: id, optional reply). Text only, no screenshots; deleted 30 days after it is fixed. Reports show in the desk bell, never by email or Slack.', inputSchema: obj({ action: { type: 'string', enum: ['send', 'list', 'fix', 'reopen'] }, text: { type: 'string' }, page: { type: 'string' }, team: { type: 'string' }, id: { type: 'string' }, reply: { type: 'string' } }), handler: engineReport },
  { name: 'engine_me', description: 'Content Engine: who you are, your country teams and the accounts you can publish to. Used by the posts desk.', inputSchema: obj({}), handler: engineMe },
  { name: 'engine_posts', description: 'Content Engine: the posts in one of your teams (the desk), optionally by status (one, or several comma-separated: review, changes, hold, scheduled, posted, rejected, archived: rejected posts cleared from the desk bin). Each post comes with track (its Asana task, results check, posted time, stale flag and source); full: true returns each whole post instead.', inputSchema: obj({ team: { type: 'string' }, status: { type: 'string' }, full: { type: 'boolean' }, limit: { type: 'number' } }, ['team']), handler: enginePosts },
  { name: 'engine_post', description: 'Content Engine: one whole post from your teams.', inputSchema: obj({ id: { type: 'string' } }, ['id']), handler: enginePost },
  { name: 'engine_save', description: 'Content Engine: save changes to a post (text, graphic, first comment, where and when). patch merges into the post; version must be the one you read, or the save is refused as a conflict.', inputSchema: obj({ id: { type: 'string' }, version: { type: 'number' }, patch: { type: 'object' } }, ['id', 'version', 'patch']), handler: engineSave },
  { name: 'engine_pause', description: 'Content Engine Pause everything: hold every scheduled post at once (action pause: scope mine = every account you can post to, team = one of your teams (team), all = every account, admins only; a reason the team sees; optional hours, otherwise until someone resumes), or resume a pause (action resume: id). Nothing is deleted or changed: the publisher just waits.', inputSchema: obj({ action: { type: 'string', enum: ['pause', 'resume'] }, scope: { type: 'string', enum: ['mine', 'team', 'all'] }, team: { type: 'string' }, reason: { type: 'string' }, hours: { type: 'number' }, id: { type: 'number' } }, ['action']), handler: enginePause },
  { name: 'engine_video', description: 'Content Engine: send a Reel or video for a post you can edit, in pieces of up to 2.5 MB (action part: id, upload (8-32 lowercase letters and digits, the same for every piece), index from 0, data base64), then check them (action done: id, upload, parts, size, sha256 hex, mime video/mp4 or video/quicktime, optional name). done returns the video to save in the post\'s final snapshot. Up to 150 MB.', inputSchema: obj({ action: { type: 'string', enum: ['part', 'done'] }, id: { type: 'string' }, upload: { type: 'string' }, index: { type: 'number' }, data: { type: 'string' }, parts: { type: 'number' }, size: { type: 'number' }, sha256: { type: 'string' }, mime: { type: 'string', enum: ['video/mp4', 'video/quicktime'] }, name: { type: 'string' } }, ['action', 'id', 'upload']), handler: engineVideo },
  { name: 'engine_inbox', description: 'Content Engine Inbox: comments and DMs on one of your teams\' Facebook Pages and Instagram accounts, newest first (status open by default, or done, or all; optional platform facebook/instagram, kind comment/message, before an ISO time), each with its tone from its words (positive, negative, mixed, neutral; tone of the words, not whether they agree with us), with open counts, the open items\' tone, actions still in their undo window and pile-on alerts from the last 24 hours. thread returns one post\'s comments or one conversation, oldest first. q searches the words, the person\'s name and the post; accounts limits to some account keys; since an ISO time. Also lists actions waiting for a check (checks) and whether yours need one (me).', inputSchema: obj({ team: { type: 'string' }, status: { type: 'string', enum: ['open', 'done', 'all'] }, platform: { type: 'string', enum: ['facebook', 'instagram'] }, kind: { type: 'string', enum: ['comment', 'message', 'mention'] }, thread: { type: 'string' }, before: { type: 'string' }, since: { type: 'string' }, accounts: { type: 'array', items: { type: 'string' } }, q: { type: 'string' }, limit: { type: 'number' } }, ['team']), handler: engineInbox },
  { name: 'engine_inbox_act', description: 'Content Engine Inbox: act on a comment or message. done, reopen, assign (assign_to, or empty to unassign) and label (labels) apply at once. reply, private_reply (Facebook comments, within 7 days), like (Facebook only), hide, unhide, delete and ban / unban (block the author from the Facebook Page; threats can be hidden but not deleted) go to Meta from the Mini with your own Page token after 10 seconds, so they can be undone; message replies only within 24 hours of their last message. A public reply to a Facebook comment can carry one desk picture (attachment, kind image; no GIFs). If your actions need a check, they wait for a team admin instead (check). tone (positive, neutral, negative, mixed) fixes a wrong tone by hand.', inputSchema: obj({ id: { type: 'string' }, action: { type: 'string', enum: ['reply', 'private_reply', 'like', 'hide', 'unhide', 'delete', 'ban', 'unban', 'done', 'reopen', 'assign', 'label', 'tone'] }, text: { type: 'string' }, attachment: obj({ url: { type: 'string' }, kind: { type: 'string', enum: ['image'] } }, ['url']), assign_to: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } }, tone: { type: 'string', enum: ['positive', 'neutral', 'negative', 'mixed'] } }, ['id', 'action']), handler: engineInboxAct },
  { name: 'engine_inbox_check', description: 'Content Engine Inbox checks (team admins): approve or send back (decision approve / reject, optional note) a teammate\'s reply, hide, delete or ban waiting for a check (action_id from engine_inbox checks), or switch checks on or off for a teammate (person, needs_check).', inputSchema: obj({ team: { type: 'string' }, action_id: { type: 'number' }, decision: { type: 'string', enum: ['approve', 'reject'] }, note: { type: 'string' }, person: { type: 'string' }, needs_check: { type: 'boolean' } }, ['team']), handler: engineInboxCheck },
  { name: 'engine_inbox_post', description: "Content Engine Inbox: the post a conversation is on (thread_id from engine_inbox), with its newest nightly figures (reactions by type, shares, comments, views), the post's own tone and how many comments are open on it.", inputSchema: obj({ team: { type: 'string' }, thread_id: { type: 'string' } }, ['team', 'thread_id']), handler: engineInboxPost },
  { name: 'engine_inbox_similar', description: "Content Engine Inbox: up to three of the team's own past replies to comments like this one (id of an inbox item, or text), matched by shared words, best first. No AI.", inputSchema: obj({ team: { type: 'string' }, id: { type: 'string' }, text: { type: 'string' } }, ['team']), handler: engineInboxSimilar },
  { name: 'engine_benchmark', description: "Content Engine Analytics: your team's Instagram beside allied organisations' Instagram over the last days (7, 30 or 90; 30 by default): followers, posts, likes + comments, per post and each ally's best post. country: UK, US, IE... or all (default the team's country). Allies only.", inputSchema: obj({ team: { type: 'string' }, days: { type: 'number' }, country: { type: 'string' } }, ['team']), handler: engineBenchmark },
  { name: 'engine_house_rules', description: "Content Engine: read or save a team's house rules (voice, tone, audience, always, never, spelling and style, plus the rules teammates added, each marked for compose, inbox and/or the morning run): the team's saved copy over the built-in default, and prompt-ready text for: compose (default), inbox or morning.", inputSchema: obj({ team: { type: 'string' }, for: { type: 'string', enum: ['compose', 'inbox', 'morning'] }, set: { type: 'object', description: 'Save: { sections, rules } (anyone in the team)' }, reset: { type: 'boolean', description: 'Back to the built-in default' } }, ['team']), handler: engineHouseRules },
  { name: 'engine_bell', description: 'Content Engine: what needs you in one team (the desk bell): Inbox items assigned to you, teammates\' actions waiting for your check, your actions checked, sent back or failed, your posts approved or sent back, publishing failures, and your Facebook connection running out. Read state is engine_prefs bell_seen.', inputSchema: obj({ team: { type: 'string' } }, ['team']), handler: engineBell },
  { name: 'engine_prefs', description: 'Content Engine: your own desk settings and saved Inbox views. No set reads them; set merges keys (inbox_views, settings; null removes one).', inputSchema: obj({ set: { type: 'object' } }), handler: enginePrefsTool },
  { name: 'engine_inbox_undo', description: 'Content Engine Inbox: undo a reply, like, hide, unhide or delete you did while it is still in its window (action_id from engine_inbox_act), or a whole bulk action (action_ids from engine_inbox_bulk).', inputSchema: obj({ action_id: { type: 'number' }, action_ids: { type: 'array', items: { type: 'number' } } }), handler: engineInboxUndo },
  { name: 'engine_inbox_bulk', description: 'Content Engine Inbox bulk by topic: one action on up to 100 comments (ids): reply (texts: up to 5 wordings, rotated), like, hide, unhide, delete, done, reopen, assign (assign_to) or label (labels). Same rules as one at a time; refusals are listed. Facebook and Instagram actions wait 30 seconds so the whole batch can be undone with engine_inbox_undo action_ids.', inputSchema: obj({ ids: { type: 'array', items: { type: 'string' } }, action: { type: 'string', enum: ['reply', 'like', 'hide', 'unhide', 'delete', 'ban', 'done', 'reopen', 'assign', 'label'] }, text: { type: 'string' }, texts: { type: 'array', items: { type: 'string' } }, assign_to: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } } }, ['ids', 'action']), handler: engineInboxBulk },
  { name: 'engine_inbox_person', description: 'Content Engine Inbox supporter history: one person\'s comments and messages on your team\'s accounts in the last 90 days (author_id from an inbox item), with counts (comments, messages, hidden, on ads), their labels, the most recent, what the team did about them before (handled, from the moderation log), and the team\'s tags on them. Pass tags (Regular supporter, Asks questions, Journalist, Politician, Organisation, Repeat abuse; empty to clear) to set them: fixed tags only, seen by this team, deleted 120 days after they were set.', inputSchema: obj({ team: { type: 'string' }, author_id: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, ['team', 'author_id']), handler: engineInboxPerson },
  { name: 'engine_inbox_posts', description: 'Content Engine Inbox by post: the last days\' comments (7 by default, up to 30) grouped by the post or ad they\'re on, with comment, open, hidden and our-reply counts and the comments\' tone (positive, negative, mixed, neutral), most open first; ads: true for ads only. Open one with engine_inbox thread.', inputSchema: obj({ team: { type: 'string' }, days: { type: 'number' }, ads: { type: 'boolean' } }, ['team']), handler: engineInboxPosts },
  { name: 'engine_inbox_rules', description: 'Content Engine Inbox auto-hide list for one of your teams: banned words, phrases, "any link that isn\'t ours" and the built-in scam phrases (listed), and whether you can change it (team admins).', inputSchema: obj({ team: { type: 'string' } }, ['team']), handler: engineInboxRules },
  { name: 'engine_inbox_rule', description: 'Content Engine Inbox: add to or remove from a team\'s auto-hide list (team admins). add: kind word (whole word), phrase (anywhere), links (any link that isn\'t citizengo.org or cgo.ac) or scams (the built-in scam phrases), with value for word and phrase. remove: id. New comments that match are hidden (never deleted) as you, and labelled auto-hidden.', inputSchema: obj({ action: { type: 'string', enum: ['add', 'remove'] }, team: { type: 'string' }, kind: { type: 'string', enum: ['word', 'phrase', 'links', 'scams'] }, value: { type: 'string' }, id: { type: 'number' } }, ['action', 'team']), handler: engineInboxRule },
  { name: 'engine_inbox_alert', description: 'Content Engine Inbox: mark a pile-on alert (from engine_inbox alerts) as seen, so it leaves the desk for everyone in the team.', inputSchema: obj({ team: { type: 'string' }, id: { type: 'number' } }, ['team', 'id']), handler: engineInboxAlert },
  { name: 'engine_access', description: "Content Engine Settings › Team and access for one of your teams: each person's role, initials (used in tracked links) and, per Facebook and Instagram account, whether they can post, reply and DM, and moderate (from their own Facebook connection, or set up by hand), plus Analytics per team. Team admins narrow access (action limit: who, account_key or '*' for Analytics, post / reply / moderate / analytics true or false; turning one back on only restores what Facebook already allows, it never widens). Anyone sets their own initials, admins anyone's (action initials: who, initials).", inputSchema: obj({ action: { type: 'string', enum: ['list', 'limit', 'initials'] }, team: { type: 'string' }, who: { type: 'string' }, account_key: { type: 'string' }, post: { type: 'boolean' }, reply: { type: 'boolean' }, moderate: { type: 'boolean' }, analytics: { type: 'boolean' }, initials: { type: 'string' } }, ['team']), handler: engineAccess },
  { name: 'engine_inviter', description: 'Content Engine Tools: Page Inviter results as data: invites per Page and person (from the extension\'s reports) for the last 7, 30 or 90 days against the window before, the Pages\' new follows over the same days, and the most-reacted posts of the last 30 days on those Pages.', inputSchema: obj({ days: { type: 'number', enum: [7, 30, 90] } }), handler: engineInviter },
  { name: 'engine_links', description: 'Content Engine Tools: tracked links. action list (default): a team\'s links from its posts (90 days) and links made here, each with Looker signatures by campaign code. action make: url (citizengo.org petition), title, platforms [facebook, instagram, x], series 1-5, scope LO/IN/GL: one Campaign Copilot link per network, saved for the list.', inputSchema: obj({ action: { type: 'string', enum: ['list', 'make'] }, team: { type: 'string' }, url: { type: 'string' }, title: { type: 'string' }, platforms: { type: 'array', items: { type: 'string' } }, series: { type: 'number' }, scope: { type: 'string' } }), handler: engineLinks },
  { name: 'engine_health', description: 'Content Engine Tools: health check for a team: who can post to each account, pauses, and how fresh the Facebook figures, Looker signatures, ally and opponent watch, hashtags and news, and Page Inviter runs are. Read only.', inputSchema: obj({ team: { type: 'string' } }), handler: engineHealth },
  { name: 'engine_copilot_link', description: "Content Engine: make one Campaign Copilot tracked link with the engine's Copilot sign-in. args = one copilotArgs object from make_links.py --dry-run (assetType petition, petitionId, ctaFamilyCode, platformCode, seriesFlow FB1-5/IG1-5/TW1-5, listCode, topicCode, scopeCode, campaignTitle). Returns link {short, long, campaign, linkId, via, at} to write into the post's links for that platform. Asking twice with the same args returns the same link.", inputSchema: obj({ args: { type: 'object' } }, ['args']), handler: engineCopilotLink },
  { name: 'engine_desk_docs', description: "Content Engine desk documents (formerly the board artifact's collections): feedback (reviewers' decisions and notes), videoRequests (requested video cuts) and results (one row per checked post). action list: collection, optional since (ISO time; newer only), status, limit; newest first. action put: collection, id (omit to create), data, merge (true updates fields, e.g. a video request's status).", inputSchema: obj({ action: { type: 'string', enum: ['list', 'put'] }, collection: { type: 'string', enum: ['feedback', 'videoRequests', 'results'] }, since: { type: 'string' }, status: { type: 'string' }, limit: { type: 'number' }, id: { type: 'string' }, data: { type: 'object' }, merge: { type: 'boolean' } }, ['collection']), handler: engineDeskDocs },
  { name: 'engine_ai_job', description: "Content Engine Desk AI helper: the web desk's AI requests are answered with the requester's own Claude. action get (id): the request's prompt (yours only). action next: your newest unanswered request from the last 30 minutes, with its id. action complete (id, text): save the answer for the desk. action fail (id, error).", inputSchema: obj({ action: { type: 'string', enum: ['get', 'next', 'complete', 'fail'] }, id: { type: 'string' }, text: { type: 'string' }, error: { type: 'string' } }, []), handler: engineAiJob },
  { name: 'engine_automations', description: 'Content Engine comment-to-DM automations for one of your teams: each rule\'s keywords, private message, public replies (taking turns), what it applies to (one post, a post type, or every post; the most specific wins), Facebook and/or Instagram, tag and hand-over, whether it is on, and its last 7 days (queued, sent, failed, and per step). paused: Pause everything is holding the team\'s accounts, so automations are held too.', inputSchema: obj({ team: { type: 'string' } }, ['team']), handler: engineAutomationsList },
  { name: 'engine_automation', description: 'Content Engine: add or update a comment-to-DM automation (team admins; name, keywords (whole words), dm_text with the real cgo.ac link, reply_texts (up to 5 public replies, taking turns), scope all / type (post_type petition, prayer, reel, wins, news) / post (thread_id), platforms facebook and/or instagram, skip_repeat (someone who already got the link just gets a like; default on), tag, hand_to (who to assign the comment to)), or pause, resume or remove one (id). A new comment with a keyword gets the private message (and a public reply) as you, through the Mini, at most one per comment and 200 per rule a day; Pause everything holds them too.', inputSchema: obj({ action: { type: 'string', enum: ['add', 'update', 'pause', 'resume', 'remove'] }, team: { type: 'string' }, id: { type: 'number' }, name: { type: 'string' }, keywords: { type: 'array', items: { type: 'string' } }, dm_text: { type: 'string' }, reply_text: { type: 'string' }, reply_texts: { type: 'array', items: { type: 'string' } }, scope: { type: 'string', enum: ['all', 'type', 'post'] }, post_type: { type: 'string', enum: ['petition', 'prayer', 'reel', 'wins', 'news'] }, thread_id: { type: 'string' }, platforms: { type: 'array', items: { type: 'string', enum: ['facebook', 'instagram'] } }, skip_repeat: { type: 'boolean' }, tag: { type: 'string' }, hand_to: { type: 'string' } }, ['action', 'team']), handler: engineAutomation },
  { name: 'engine_parliament', description: 'Content Engine Listening › Parliament for one of your teams (UK for now): Westminster and Scottish Parliament items on our issues that the Parliamentary Monitor triaged as worth a line or worth acting on (score 2 or 3), newest first, with why it matters, issue areas, kind and date, plus coming deadlines; last 21 days by default (days up to 60).', inputSchema: obj({ team: { type: 'string' }, days: { type: 'number' }, fresh: { type: 'boolean' } }, ['team']), handler: engineParliament },
  { name: 'engine_bio', description: 'Content Engine Tools › Link in bio for one of your teams (only its members can see or change it): its public page (/links/<slug>, QR at /links/<slug>/qr.svg), filled with the petitions the team linked to in the last 30 days plus saved buttons. action get (default) lists every button in page order with its section, whether it shows (why: removed, closed, asana, quiet, ended, not_yet, won_old), clicks and signatures from the bio in 30 days, the Bluebook total and Asana hints, plus page views by source (ig, x, fb, tt, qr, wa), click rate and a daily series; action save sets slug, title, intro, auto, settings (donate_url, emails_url, whatsapp_url, grid, socials, totals, quiet) and items in order (id, title, url, petition_id, pinned, featured, hidden = removed, closed, won, won_at, section (Act now, Pray with us, Get involved, More), starts, ends, cd_date, cd_label, auto).', inputSchema: obj({ team: { type: 'string' }, action: { type: 'string', enum: ['get', 'save'] }, slug: { type: 'string' }, title: { type: 'string' }, intro: { type: 'string' }, auto: { type: 'boolean' }, settings: { type: 'object' }, items: { type: 'array', items: { type: 'object' } } }, ['team']), handler: engineBio },
  { name: 'engine_ig_grid', description: 'Content Engine Calendar › Instagram grid for one of your teams: each Instagram account with its latest 12 posts (type, caption start, link, preview image, time) from the nightly collection.', inputSchema: obj({ team: { type: 'string' } }, ['team']), handler: engineIgGrid },
  { name: 'engine_inbox_team', description: 'Content Engine Inbox › Team for one of your teams: open conversations per person and unassigned, each person\'s replies and median first-reply time, what has waited over 2 hours, and comments arriving by hour (in the team\'s own time zone) against reply times, over the last 7 days (days up to 30).', inputSchema: obj({ team: { type: 'string' }, days: { type: 'number' } }, ['team']), handler: engineInboxTeam },
  { name: 'engine_inbox_history', description: 'Content Engine Inbox moderation history for one of your teams: every reply, hide, delete, like, assignment, label and done, by whom, newest first.', inputSchema: obj({ team: { type: 'string' }, limit: { type: 'number' } }, ['team']), handler: engineInboxHistory },
  { name: 'engine_analytics', description: 'Content Engine Analytics for the desk, as data: page reach, views, engagements and net follows, Instagram follower movement, top Facebook posts against their own Page\'s median, top Instagram posts and X totals, for the last 7, 30 or 90 days. scope citizengo (every CitizenGO Page, default), hazteoir (kept apart), team (with team), countries (every team side by side) or leaderboard (every CitizenGO Facebook Page, this window and the one before: followers, growth, engagements, posts, per post, per 1,000 followers, best post).', inputSchema: obj({ scope: { type: 'string', enum: ['citizengo', 'hazteoir', 'team', 'countries', 'leaderboard'] }, team: { type: 'string' }, days: { type: 'number', enum: [7, 30, 90] }, from: { type: 'string', description: 'Custom range start, YYYY-MM-DD (up to 92 days). Returns only the report, ranked posts and conversations.' }, to: { type: 'string', description: 'Custom range end, inclusive; defaults to today.' }, compare_from: { type: 'string', description: 'First day of the window to compare with (same length). Default: the days just before.' }, compare: { type: 'string', enum: ['previous', 'none'] }, fresh: { type: 'boolean' } }), handler: engineAnalytics },
  { name: 'engine_listening', description: 'Content Engine Listening for the desk, as data: posts beating their own normal (min_multiple, default 3). tab citizengo: other CitizenGO Pages\' posts (not your team\'s, with team) by views against that Page\'s 90-day median, last 7 or 30 days. tab allies: watched ally Instagram accounts (optional country UK, US, IE, CA, AU), last 7, 10 or 30 days. tab opponents: watched opponent accounts plus their Meta Ad Library issue ads. tab beyond: hashtag posts from anyone (config/listen-hashtags.json), UK headlines per topic, and accounts our watched posts keep tagging that are not on our lists. tab opponents_mix: each opponent organisation\'s last 7 or 14 days split by topic (posts, best post, ads, spend). tab watches: watches [{id, words, not, sources}] matched against the last 14 days of those posts. tab overview: English posts from all of those in the last 14 days sorted into campaign topics (posts, change, share of voice, words, top posts, gaps) plus rising hashtags, links and names.', inputSchema: obj({ tab: { type: 'string', enum: ['citizengo', 'allies', 'opponents', 'overview', 'watches', 'opponents_mix', 'beyond'] }, watches: { type: 'array', items: { type: 'object' } }, team: { type: 'string' }, country: { type: 'string' }, days: { type: 'number' }, min_multiple: { type: 'number' }, fresh: { type: 'boolean' } }), handler: engineListening },
  { name: 'engine_record', description: 'Content Engine: record bookkeeping on a post in any status, posted and rejected included: results, posted (the real post links and time), stale, and posting.asanaTaskGid / asanaUrl / syncedAt / removedAt. Nothing else; the post itself is saved with engine_save. version must be the one you read.', inputSchema: obj({ id: { type: 'string' }, version: { type: 'number' }, patch: { type: 'object' } }, ['id', 'version', 'patch']), handler: engineRecord },
  { name: 'engine_trash', description: "Content Engine: the desk's bin of rejected posts for one of your teams. action count (default) says how many the morning run has already learnt from (ready) and how many are newer (waiting); action empty archives the ready ones: they leave the desk but the morning run still reads them like rejected posts.", inputSchema: obj({ team: { type: 'string' }, action: { type: 'string', enum: ['count', 'empty'] } }, ['team']), handler: engineTrash },
  { name: 'engine_status', description: 'Content Engine: approve (schedules it; needs publishing rights for every Facebook and Instagram account), hold, changes (needs a note), reject, reopen, or mark as posted (it went out) a post.', inputSchema: obj({ id: { type: 'string' }, version: { type: 'number' }, action: { type: 'string', enum: ['approve', 'hold', 'changes', 'reject', 'reopen', 'posted'] }, note: { type: 'string' }, reasons: { type: 'array', items: { type: 'string' } } }, ['id', 'version', 'action']), handler: engineStatus },
  { name: 'engine_create', description: 'Content Engine: add a new post to Review in one of your teams (the daily engine, "Rework for…" and imports use this).', inputSchema: obj({ team: { type: 'string' }, doc: { type: 'object' }, id: { type: 'string' }, source_team: { type: 'string' }, source_post: { type: 'string' } }, ['team', 'doc']), handler: engineCreate },
  { name: 'engine_copy', description: 'Content Engine: copy a post you can see (yours, or another team\'s scheduled or posted one) into one of your teams as a new draft in Review.', inputSchema: obj({ id: { type: 'string' }, to_team: { type: 'string' } }, ['id', 'to_team']), handler: engineCopy },
  { name: 'engine_requests', description: 'Content Engine Plan: the "draft this for that date" requests for one of your teams (open and drafted by default), optionally between from and to (YYYY-MM-DD).', inputSchema: obj({ team: { type: 'string' }, status: { type: 'string', enum: ['open', 'drafted', 'cancelled'] }, from: { type: 'string' }, to: { type: 'string' } }, ['team']), handler: engineRequests },
  { name: 'engine_request', description: 'Content Engine Plan: ask the daily engine to draft a post for a date (action create: team, for_date YYYY-MM-DD, title, optional angle, source key_date or idea), cancel an open request (action cancel: id), or record that it was drafted (action drafted: id, post_id).', inputSchema: obj({ action: { type: 'string', enum: ['create', 'cancel', 'drafted'] }, id: { type: 'number' }, team: { type: 'string' }, for_date: { type: 'string' }, title: { type: 'string' }, angle: { type: 'string' }, source: { type: 'string', enum: ['key_date', 'idea', 'evergreen'] }, evergreen_id: { type: 'number' }, post_id: { type: 'string' } }, ['action']), handler: engineRequest },
  { name: 'engine_evergreen', description: 'Content Engine evergreen bank for one of your teams: past winners with their state (due, coming, resting, retired), due date and any open fresh-draft request. Due 10 weeks after a post last went out.', inputSchema: obj({ team: { type: 'string' } }, ['team']), handler: engineEvergreen },
  { name: 'engine_evergreen_update', description: 'Content Engine evergreen bank: add a past winner (action add: team, title, last_out YYYY-MM-DD, optional url, format, account_key, result, why), or snooze it 4 weeks, retire, restore, or record that a fresh version went out (went_out, optional last_out) by id.', inputSchema: obj({ action: { type: 'string', enum: ['add', 'snooze', 'retire', 'restore', 'went_out'] }, id: { type: 'number' }, team: { type: 'string' }, title: { type: 'string' }, last_out: { type: 'string' }, url: { type: 'string' }, format: { type: 'string' }, account_key: { type: 'string' }, result: { type: 'string' }, why: { type: 'string' }, source_post: { type: 'string' } }, ['action']), handler: engineEvergreenUpdate },
  { name: 'engine_preview', description: "Content Engine: a 1-hour signed link to play a video preview stored for a post (path from the post's video.preview or a videoSuggestions entry's preview), for the desk's trimmer. Or clip + team: a file from that team's clip (Tools › Clip a video).", inputSchema: obj({ id: { type: 'string' }, clip: { type: 'string' }, team: { type: 'string' }, path: { type: 'string' } }, ['path']), handler: enginePreview },
  { name: 'engine_media', description: 'Content Engine: store one finished image (base64 JPEG or PNG, up to 3 MB) for a post you can edit, for Facebook or Instagram (index 0-9 for carousels), or platform story for the Instagram Story frames (index 0-9, in order). Returns its path for the post\'s final snapshot.', inputSchema: obj({ id: { type: 'string' }, platform: { type: 'string', enum: ['facebook', 'instagram', 'story'] }, index: { type: 'number' }, mime: { type: 'string', enum: ['image/jpeg', 'image/png'] }, data: { type: 'string' } }, ['id', 'platform', 'mime', 'data']), handler: engineMedia },
  { name: 'engine_connect', description: 'Content Engine: a ten-minute link that connects your own Facebook account, so the Pages you can post to become your publishing rights.', inputSchema: obj({}), handler: engineConnect },
  { name: 'engine_calendar', description: 'Content Engine calendar: every team\'s scheduled and posted items (read-only for teams you are not in) plus your own teams\' drafts and holds, and the key dates (CitizenGO-wide and your teams\' own), between from and to (YYYY-MM-DD).', inputSchema: obj({ from: { type: 'string' }, to: { type: 'string' } }), handler: engineCalendar },
];

module.exports = { cached, wellFormed, signaturesFor, CACHE_MS, addDayGain, addPictures, convergence, convergenceBuilding, topicsOf, langOf, storyKeys, ENGINE_TOOLS, context };
