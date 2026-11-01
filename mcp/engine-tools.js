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

async function enginePosts(store, args, { who }) {
  const ctx = await context(store, who);
  const team = String(args.team || '');
  if (!E.canEditTeam(ctx, team)) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
  const statuses = args.status ? String(args.status).split(',').map((s) => s.trim()).filter((s) => E.STATUSES.includes(s)) : null;
  const rows = await store.enginePosts({ team_ids: [team], statuses, limit: args.limit });
  return json({ team, posts: args.full ? rows : rows.map(lite), pauses: await pausesFor(store, ctx) });
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
  const rights = await store.engineRights({ who });
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
  const rights = await store.engineRights({ who });
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
    return json({ team, thread: String(args.thread), items });
  }
  const status = args.status === 'all' ? null : [args.status === 'done' ? 'done' : 'open'];
  const items = await store.engineInbox({ team_ids: [team], statuses: status, platform: args.platform || null, kind: args.kind || null, before: args.before || null, limit: args.limit || 200 });
  const open = status && status[0] === 'open' && !args.platform && !args.kind ? items : await store.engineInbox({ team_ids: [team], statuses: ['open'], limit: 1000 });
  const counts = { open: open.length, facebook: 0, instagram: 0, messages: 0, mine: 0 };
  for (const i of open) { counts[i.platform]++; if (i.kind === 'message') counts.messages++; if (String(i.assigned_to || '').toLowerCase() === String(who).toLowerCase()) counts.mine++; }
  const pending = await store.engineInboxActions({ team_ids: [team], statuses: ['queued', 'running'], limit: 100 });
  const alerts = await store.engineInboxAlerts({ team_ids: [team], statuses: ['open'], since: new Date(Date.now() - 24 * 3600_000).toISOString() });
  return json({ team, items, counts, pending, alerts });
}

async function engineInboxAct(store, args, { who }) {
  const ctx = await context(store, who);
  const item = await inboxItem(store, ctx, args.id);
  const action = String(args.action || '');
  const now = new Date();
  const base = { item_id: item.id, team_id: item.team_id, account_key: item.account_key, action, by: who };
  if (I.DESK_ACTIONS.includes(action)) {
    let fields;
    if (action === 'done' || action === 'reopen') fields = { status: action === 'done' ? 'done' : 'open' };
    else if (action === 'assign') fields = { assigned_to: args.assign_to ? String(args.assign_to).slice(0, 120) : null };
    else {
      const labels = [...new Set([].concat(args.labels || []).map((l) => String(l).trim().slice(0, 30)).filter(Boolean))];
      if (labels.length > 10) return json({ ok: false, error: 'At most 10 labels.' });
      fields = { labels };
    }
    const saved = await store.engineInboxUpdate(item.id, { ...fields, updated_at: now.toISOString(), updated_by: who });
    await store.engineInboxInsertAction({ ...base, detail: fields, status: 'done', run_after: now.toISOString(), done_at: now.toISOString() });
    return json({ ok: true, item: saved });
  }
  const rights = (await store.engineRights({ who })).map((r) => r.account_key);
  if (!rights.includes(item.account_key)) return json({ ok: false, error: `You can't act for ${item.account_key}: connect Facebook with a Page role on it, or leave it for someone who has one.` });
  let lastIncomingAt, recipient;
  if (item.kind === 'message') {
    const thread = await store.engineInbox({ team_ids: [item.team_id], thread_id: item.thread_id, limit: 500 });
    const theirs = thread.filter((m) => !m.from_us);
    const last = theirs[theirs.length - 1] || item;
    lastIncomingAt = last.created_at; recipient = last.author_id;
    if (!recipient) return json({ ok: false, error: "Can't tell who to reply to in this conversation." });
  }
  const ok = I.allowed(item, action, { text: args.text, lastIncomingAt, now: now.getTime() });
  if (!ok.ok) return json(ok);
  const row = await store.engineInboxInsertAction({
    ...base, text: args.text ? String(args.text).trim() : null, detail: recipient ? { recipient } : {},
    run_after: new Date(now.getTime() + I.UNDO_MS).toISOString(), status: 'queued',
  });
  return json({ ok: true, queued: row, undo_until: row.run_after });
}

async function engineInboxUndo(store, args, { who }) {
  const ctx = await context(store, who);
  const rows = await store.engineInboxActions({ team_ids: Object.keys(ctx.myTeams).concat(ctx.maintainer ? ctx.teams.map((t) => t.id) : []), statuses: ['queued'], limit: 500 });
  const a = rows.find((r) => Number(r.id) === Number(args.action_id));
  if (!a) return json({ ok: false, error: 'Too late to undo: it has already gone to Meta, or was undone.' });
  if (String(a.by).toLowerCase() !== String(who).toLowerCase() && !ctx.maintainer) return json({ ok: false, error: 'Only the person who did it can undo it.' });
  const done = await store.engineInboxUpdateAction(a.id, 'queued', { status: 'cancelled', done_at: new Date().toISOString() });
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
  return json({
    team, author_id: String(args.author_id), author_name: (rows[0] && rows[0].author_name) || null,
    counts: { comments: rows.filter((r) => r.kind === 'comment').length, messages: rows.filter((r) => r.kind === 'message').length, hidden: rows.filter((r) => r.hidden).length, on_ads: rows.filter((r) => r.is_ad).length },
    labels, recent: rows.slice(0, 8),
  });
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
    const p = by[r.thread_id] || (by[r.thread_id] = { thread_id: r.thread_id, account_key: r.account_key, platform: r.platform, post_text: r.post_text, post_url: r.post_url, is_ad: r.is_ad, comments: 0, open: 0, hidden: 0, ours: 0, last_at: r.created_at });
    if (r.from_us) { p.ours++; continue; }
    p.comments++; if (r.status === 'open') p.open++; if (r.hidden) p.hidden++;
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

async function engineInboxHistory(store, args, { who }) {
  const ctx = await context(store, who);
  const team = String(args.team || '');
  if (!E.canEditTeam(ctx, team)) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
  return json({ team, actions: await store.engineInboxActions({ team_ids: [team], limit: Math.min(500, Number(args.limit) || 200) }) });
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
  if (['posted', 'rejected'].includes(post.status)) return json({ ok: false, error: `A ${post.status} post can't take a new video.` });
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

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const ENGINE_TOOLS = [
  { name: 'engine_me', description: 'Content Engine: who you are, your country teams and the accounts you can publish to. Used by the posts desk.', inputSchema: obj({}), handler: engineMe },
  { name: 'engine_posts', description: 'Content Engine: the posts in one of your teams (the desk), optionally by status (one, or several comma-separated: review, changes, hold, scheduled, posted, rejected). Each post comes with track (its Asana task, results check, posted time, stale flag and source); full: true returns each whole post instead.', inputSchema: obj({ team: { type: 'string' }, status: { type: 'string' }, full: { type: 'boolean' }, limit: { type: 'number' } }, ['team']), handler: enginePosts },
  { name: 'engine_post', description: 'Content Engine: one whole post from your teams.', inputSchema: obj({ id: { type: 'string' } }, ['id']), handler: enginePost },
  { name: 'engine_save', description: 'Content Engine: save changes to a post (text, graphic, first comment, where and when). patch merges into the post; version must be the one you read, or the save is refused as a conflict.', inputSchema: obj({ id: { type: 'string' }, version: { type: 'number' }, patch: { type: 'object' } }, ['id', 'version', 'patch']), handler: engineSave },
  { name: 'engine_pause', description: 'Content Engine Pause everything: hold every scheduled post at once (action pause: scope mine = every account you can post to, team = one of your teams (team), all = every account, admins only; a reason the team sees; optional hours, otherwise until someone resumes), or resume a pause (action resume: id). Nothing is deleted or changed: the publisher just waits.', inputSchema: obj({ action: { type: 'string', enum: ['pause', 'resume'] }, scope: { type: 'string', enum: ['mine', 'team', 'all'] }, team: { type: 'string' }, reason: { type: 'string' }, hours: { type: 'number' }, id: { type: 'number' } }, ['action']), handler: enginePause },
  { name: 'engine_video', description: 'Content Engine: send a Reel or video for a post you can edit, in pieces of up to 2.5 MB (action part: id, upload (8-32 lowercase letters and digits, the same for every piece), index from 0, data base64), then check them (action done: id, upload, parts, size, sha256 hex, mime video/mp4 or video/quicktime, optional name). done returns the video to save in the post\'s final snapshot. Up to 150 MB.', inputSchema: obj({ action: { type: 'string', enum: ['part', 'done'] }, id: { type: 'string' }, upload: { type: 'string' }, index: { type: 'number' }, data: { type: 'string' }, parts: { type: 'number' }, size: { type: 'number' }, sha256: { type: 'string' }, mime: { type: 'string', enum: ['video/mp4', 'video/quicktime'] }, name: { type: 'string' } }, ['action', 'id', 'upload']), handler: engineVideo },
  { name: 'engine_inbox', description: 'Content Engine Inbox: comments and DMs on one of your teams\' Facebook Pages and Instagram accounts, newest first (status open by default, or done, or all; optional platform facebook/instagram, kind comment/message, before an ISO time), with open counts, actions still in their undo window and pile-on alerts from the last 24 hours. thread returns one post\'s comments or one conversation, oldest first.', inputSchema: obj({ team: { type: 'string' }, status: { type: 'string', enum: ['open', 'done', 'all'] }, platform: { type: 'string', enum: ['facebook', 'instagram'] }, kind: { type: 'string', enum: ['comment', 'message'] }, thread: { type: 'string' }, before: { type: 'string' }, limit: { type: 'number' } }, ['team']), handler: engineInbox },
  { name: 'engine_inbox_act', description: 'Content Engine Inbox: act on a comment or message. done, reopen, assign (assign_to, or empty to unassign) and label (labels) apply at once. reply, private_reply (Facebook comments, within 7 days), like (Facebook only), hide, unhide and delete go to Meta from the Mini with your own Page token after 10 seconds, so they can be undone; message replies only within 24 hours of their last message.', inputSchema: obj({ id: { type: 'string' }, action: { type: 'string', enum: ['reply', 'private_reply', 'like', 'hide', 'unhide', 'delete', 'done', 'reopen', 'assign', 'label'] }, text: { type: 'string' }, assign_to: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } } }, ['id', 'action']), handler: engineInboxAct },
  { name: 'engine_inbox_undo', description: 'Content Engine Inbox: undo a reply, like, hide, unhide or delete you did, while it is still in its 10-second window (action_id from engine_inbox_act).', inputSchema: obj({ action_id: { type: 'number' } }, ['action_id']), handler: engineInboxUndo },
  { name: 'engine_inbox_person', description: 'Content Engine Inbox supporter history: one person\'s comments and messages on your team\'s accounts in the last 90 days (author_id from an inbox item), with counts (comments, messages, hidden, on ads), their labels and the most recent.', inputSchema: obj({ team: { type: 'string' }, author_id: { type: 'string' } }, ['team', 'author_id']), handler: engineInboxPerson },
  { name: 'engine_inbox_posts', description: 'Content Engine Inbox by post: the last days\' comments (7 by default, up to 30) grouped by the post or ad they\'re on, with comment, open, hidden and our-reply counts, most open first; ads: true for ads only. Open one with engine_inbox thread.', inputSchema: obj({ team: { type: 'string' }, days: { type: 'number' }, ads: { type: 'boolean' } }, ['team']), handler: engineInboxPosts },
  { name: 'engine_inbox_rules', description: 'Content Engine Inbox auto-hide list for one of your teams: banned words, phrases, "any link that isn\'t ours" and the built-in scam phrases (listed), and whether you can change it (team admins).', inputSchema: obj({ team: { type: 'string' } }, ['team']), handler: engineInboxRules },
  { name: 'engine_inbox_rule', description: 'Content Engine Inbox: add to or remove from a team\'s auto-hide list (team admins). add: kind word (whole word), phrase (anywhere), links (any link that isn\'t citizengo.org or cgo.ac) or scams (the built-in scam phrases), with value for word and phrase. remove: id. New comments that match are hidden (never deleted) as you, and labelled auto-hidden.', inputSchema: obj({ action: { type: 'string', enum: ['add', 'remove'] }, team: { type: 'string' }, kind: { type: 'string', enum: ['word', 'phrase', 'links', 'scams'] }, value: { type: 'string' }, id: { type: 'number' } }, ['action', 'team']), handler: engineInboxRule },
  { name: 'engine_inbox_alert', description: 'Content Engine Inbox: mark a pile-on alert (from engine_inbox alerts) as seen, so it leaves the desk for everyone in the team.', inputSchema: obj({ team: { type: 'string' }, id: { type: 'number' } }, ['team', 'id']), handler: engineInboxAlert },
  { name: 'engine_inbox_history', description: 'Content Engine Inbox moderation history for one of your teams: every reply, hide, delete, like, assignment, label and done, by whom, newest first.', inputSchema: obj({ team: { type: 'string' }, limit: { type: 'number' } }, ['team']), handler: engineInboxHistory },
  { name: 'engine_record', description: 'Content Engine: record bookkeeping on a post in any status, posted and rejected included: results, posted (the real post links and time), stale, and posting.asanaTaskGid / asanaUrl / syncedAt / removedAt. Nothing else; the post itself is saved with engine_save. version must be the one you read.', inputSchema: obj({ id: { type: 'string' }, version: { type: 'number' }, patch: { type: 'object' } }, ['id', 'version', 'patch']), handler: engineRecord },
  { name: 'engine_status', description: 'Content Engine: approve (schedules it; needs publishing rights for every Facebook and Instagram account), hold, changes (needs a note), reject, reopen, or mark as posted (it went out) a post.', inputSchema: obj({ id: { type: 'string' }, version: { type: 'number' }, action: { type: 'string', enum: ['approve', 'hold', 'changes', 'reject', 'reopen', 'posted'] }, note: { type: 'string' }, reasons: { type: 'array', items: { type: 'string' } } }, ['id', 'version', 'action']), handler: engineStatus },
  { name: 'engine_create', description: 'Content Engine: add a new post to Review in one of your teams (the daily engine, "Rework for…" and imports use this).', inputSchema: obj({ team: { type: 'string' }, doc: { type: 'object' }, id: { type: 'string' }, source_team: { type: 'string' }, source_post: { type: 'string' } }, ['team', 'doc']), handler: engineCreate },
  { name: 'engine_copy', description: 'Content Engine: copy a post you can see (yours, or another team\'s scheduled or posted one) into one of your teams as a new draft in Review.', inputSchema: obj({ id: { type: 'string' }, to_team: { type: 'string' } }, ['id', 'to_team']), handler: engineCopy },
  { name: 'engine_requests', description: 'Content Engine Plan: the "draft this for that date" requests for one of your teams (open and drafted by default), optionally between from and to (YYYY-MM-DD).', inputSchema: obj({ team: { type: 'string' }, status: { type: 'string', enum: ['open', 'drafted', 'cancelled'] }, from: { type: 'string' }, to: { type: 'string' } }, ['team']), handler: engineRequests },
  { name: 'engine_request', description: 'Content Engine Plan: ask the daily engine to draft a post for a date (action create: team, for_date YYYY-MM-DD, title, optional angle, source key_date or idea), cancel an open request (action cancel: id), or record that it was drafted (action drafted: id, post_id).', inputSchema: obj({ action: { type: 'string', enum: ['create', 'cancel', 'drafted'] }, id: { type: 'number' }, team: { type: 'string' }, for_date: { type: 'string' }, title: { type: 'string' }, angle: { type: 'string' }, source: { type: 'string', enum: ['key_date', 'idea', 'evergreen'] }, evergreen_id: { type: 'number' }, post_id: { type: 'string' } }, ['action']), handler: engineRequest },
  { name: 'engine_evergreen', description: 'Content Engine evergreen bank for one of your teams: past winners with their state (due, coming, resting, retired), due date and any open fresh-draft request. Due 10 weeks after a post last went out.', inputSchema: obj({ team: { type: 'string' } }, ['team']), handler: engineEvergreen },
  { name: 'engine_evergreen_update', description: 'Content Engine evergreen bank: add a past winner (action add: team, title, last_out YYYY-MM-DD, optional url, format, account_key, result, why), or snooze it 4 weeks, retire, restore, or record that a fresh version went out (went_out, optional last_out) by id.', inputSchema: obj({ action: { type: 'string', enum: ['add', 'snooze', 'retire', 'restore', 'went_out'] }, id: { type: 'number' }, team: { type: 'string' }, title: { type: 'string' }, last_out: { type: 'string' }, url: { type: 'string' }, format: { type: 'string' }, account_key: { type: 'string' }, result: { type: 'string' }, why: { type: 'string' }, source_post: { type: 'string' } }, ['action']), handler: engineEvergreenUpdate },
  { name: 'engine_media', description: 'Content Engine: store one finished image (base64 JPEG or PNG, up to 3 MB) for a post you can edit, for Facebook or Instagram (index 0-9 for carousels), or platform story for the Instagram Story frames (index 0-9, in order). Returns its path for the post\'s final snapshot.', inputSchema: obj({ id: { type: 'string' }, platform: { type: 'string', enum: ['facebook', 'instagram', 'story'] }, index: { type: 'number' }, mime: { type: 'string', enum: ['image/jpeg', 'image/png'] }, data: { type: 'string' } }, ['id', 'platform', 'mime', 'data']), handler: engineMedia },
  { name: 'engine_connect', description: 'Content Engine: a ten-minute link that connects your own Facebook account, so the Pages you can post to become your publishing rights.', inputSchema: obj({}), handler: engineConnect },
  { name: 'engine_calendar', description: 'Content Engine calendar: every team\'s scheduled and posted items (read-only for teams you are not in) plus your own teams\' drafts and holds, and the key dates (CitizenGO-wide and your teams\' own), between from and to (YYYY-MM-DD).', inputSchema: obj({ from: { type: 'string' }, to: { type: 'string' } }), handler: engineCalendar },
];

module.exports = { ENGINE_TOOLS, context };
