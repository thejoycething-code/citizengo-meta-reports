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
});

async function engineMe(store, args, { who }) {
  const ctx = await context(store, who);
  const rights = await store.engineRights({ who });
  return json({
    who, maintainer: ctx.maintainer,
    teams: ctx.teams.filter((t) => E.canEditTeam(ctx, t.id)).map((t) => ({ ...t, role: ctx.myTeams[t.id] || 'maintainer' })),
    all_teams: ctx.teams.map((t) => ({ id: t.id, name: t.name, flag: t.flag })),
    publish_rights: rights.map((r) => r.account_key),
  });
}

async function enginePosts(store, args, { who }) {
  const ctx = await context(store, who);
  const team = String(args.team || '');
  if (!E.canEditTeam(ctx, team)) throw err('You are not in that team.', 'ENGINE_NOT_MEMBER');
  const statuses = args.status ? [String(args.status)].filter((s) => E.STATUSES.includes(s)) : null;
  const rows = await store.enginePosts({ team_ids: [team], statuses, limit: args.limit });
  return json({ team, posts: args.full ? rows : rows.map(lite) });
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

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const ENGINE_TOOLS = [
  { name: 'engine_me', description: 'Content Engine: who you are, your country teams and the accounts you can publish to. Used by the posts desk.', inputSchema: obj({}), handler: engineMe },
  { name: 'engine_posts', description: 'Content Engine: the posts in one of your teams (the desk), optionally one status (review, changes, hold, scheduled, posted, rejected). full: true returns each whole post.', inputSchema: obj({ team: { type: 'string' }, status: { type: 'string' }, full: { type: 'boolean' }, limit: { type: 'number' } }, ['team']), handler: enginePosts },
  { name: 'engine_post', description: 'Content Engine: one whole post from your teams.', inputSchema: obj({ id: { type: 'string' } }, ['id']), handler: enginePost },
  { name: 'engine_save', description: 'Content Engine: save changes to a post (text, graphic, first comment, where and when). patch merges into the post; version must be the one you read, or the save is refused as a conflict.', inputSchema: obj({ id: { type: 'string' }, version: { type: 'number' }, patch: { type: 'object' } }, ['id', 'version', 'patch']), handler: engineSave },
  { name: 'engine_status', description: 'Content Engine: approve (schedules it; needs publishing rights for every Facebook and Instagram account), hold, changes (needs a note), reject, reopen, or mark as posted (it went out) a post.', inputSchema: obj({ id: { type: 'string' }, version: { type: 'number' }, action: { type: 'string', enum: ['approve', 'hold', 'changes', 'reject', 'reopen', 'posted'] }, note: { type: 'string' }, reasons: { type: 'array', items: { type: 'string' } } }, ['id', 'version', 'action']), handler: engineStatus },
  { name: 'engine_create', description: 'Content Engine: add a new post to Review in one of your teams (the daily engine, "Rework for…" and imports use this).', inputSchema: obj({ team: { type: 'string' }, doc: { type: 'object' }, id: { type: 'string' }, source_team: { type: 'string' }, source_post: { type: 'string' } }, ['team', 'doc']), handler: engineCreate },
  { name: 'engine_copy', description: 'Content Engine: copy a post you can see (yours, or another team\'s scheduled or posted one) into one of your teams as a new draft in Review.', inputSchema: obj({ id: { type: 'string' }, to_team: { type: 'string' } }, ['id', 'to_team']), handler: engineCopy },
  { name: 'engine_calendar', description: 'Content Engine calendar: every team\'s scheduled and posted items (read-only for teams you are not in) plus your own teams\' drafts and holds, and the key dates (CitizenGO-wide and your teams\' own), between from and to (YYYY-MM-DD).', inputSchema: obj({ from: { type: 'string' }, to: { type: 'string' } }), handler: engineCalendar },
];

module.exports = { ENGINE_TOOLS, context };
