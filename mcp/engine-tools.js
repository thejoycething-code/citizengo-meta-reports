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
    connected_rights: rights.filter((r) => r.source === 'meta').map((r) => r.account_key),
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
async function engineMedia(store, args, { who }) {
  const ctx = await context(store, who);
  const post = await editablePost(store, ctx, args.id);
  if (!['facebook', 'instagram'].includes(args.platform)) return json({ ok: false, error: 'Images are stored for Facebook or Instagram.' });
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
  { name: 'engine_posts', description: 'Content Engine: the posts in one of your teams (the desk), optionally one status (review, changes, hold, scheduled, posted, rejected). full: true returns each whole post.', inputSchema: obj({ team: { type: 'string' }, status: { type: 'string' }, full: { type: 'boolean' }, limit: { type: 'number' } }, ['team']), handler: enginePosts },
  { name: 'engine_post', description: 'Content Engine: one whole post from your teams.', inputSchema: obj({ id: { type: 'string' } }, ['id']), handler: enginePost },
  { name: 'engine_save', description: 'Content Engine: save changes to a post (text, graphic, first comment, where and when). patch merges into the post; version must be the one you read, or the save is refused as a conflict.', inputSchema: obj({ id: { type: 'string' }, version: { type: 'number' }, patch: { type: 'object' } }, ['id', 'version', 'patch']), handler: engineSave },
  { name: 'engine_status', description: 'Content Engine: approve (schedules it; needs publishing rights for every Facebook and Instagram account), hold, changes (needs a note), reject, reopen, or mark as posted (it went out) a post.', inputSchema: obj({ id: { type: 'string' }, version: { type: 'number' }, action: { type: 'string', enum: ['approve', 'hold', 'changes', 'reject', 'reopen', 'posted'] }, note: { type: 'string' }, reasons: { type: 'array', items: { type: 'string' } } }, ['id', 'version', 'action']), handler: engineStatus },
  { name: 'engine_create', description: 'Content Engine: add a new post to Review in one of your teams (the daily engine, "Rework for…" and imports use this).', inputSchema: obj({ team: { type: 'string' }, doc: { type: 'object' }, id: { type: 'string' }, source_team: { type: 'string' }, source_post: { type: 'string' } }, ['team', 'doc']), handler: engineCreate },
  { name: 'engine_copy', description: 'Content Engine: copy a post you can see (yours, or another team\'s scheduled or posted one) into one of your teams as a new draft in Review.', inputSchema: obj({ id: { type: 'string' }, to_team: { type: 'string' } }, ['id', 'to_team']), handler: engineCopy },
  { name: 'engine_requests', description: 'Content Engine Plan: the "draft this for that date" requests for one of your teams (open and drafted by default), optionally between from and to (YYYY-MM-DD).', inputSchema: obj({ team: { type: 'string' }, status: { type: 'string', enum: ['open', 'drafted', 'cancelled'] }, from: { type: 'string' }, to: { type: 'string' } }, ['team']), handler: engineRequests },
  { name: 'engine_request', description: 'Content Engine Plan: ask the daily engine to draft a post for a date (action create: team, for_date YYYY-MM-DD, title, optional angle, source key_date or idea), cancel an open request (action cancel: id), or record that it was drafted (action drafted: id, post_id).', inputSchema: obj({ action: { type: 'string', enum: ['create', 'cancel', 'drafted'] }, id: { type: 'number' }, team: { type: 'string' }, for_date: { type: 'string' }, title: { type: 'string' }, angle: { type: 'string' }, source: { type: 'string', enum: ['key_date', 'idea', 'evergreen'] }, evergreen_id: { type: 'number' }, post_id: { type: 'string' } }, ['action']), handler: engineRequest },
  { name: 'engine_evergreen', description: 'Content Engine evergreen bank for one of your teams: past winners with their state (due, coming, resting, retired), due date and any open fresh-draft request. Due 10 weeks after a post last went out.', inputSchema: obj({ team: { type: 'string' } }, ['team']), handler: engineEvergreen },
  { name: 'engine_evergreen_update', description: 'Content Engine evergreen bank: add a past winner (action add: team, title, last_out YYYY-MM-DD, optional url, format, account_key, result, why), or snooze it 4 weeks, retire, restore, or record that a fresh version went out (went_out, optional last_out) by id.', inputSchema: obj({ action: { type: 'string', enum: ['add', 'snooze', 'retire', 'restore', 'went_out'] }, id: { type: 'number' }, team: { type: 'string' }, title: { type: 'string' }, last_out: { type: 'string' }, url: { type: 'string' }, format: { type: 'string' }, account_key: { type: 'string' }, result: { type: 'string' }, why: { type: 'string' }, source_post: { type: 'string' } }, ['action']), handler: engineEvergreenUpdate },
  { name: 'engine_media', description: 'Content Engine: store one finished image (base64 JPEG or PNG, up to 3 MB) for a post you can edit, for Facebook or Instagram (index 0-9 for carousels). Returns its path for the post\'s final snapshot.', inputSchema: obj({ id: { type: 'string' }, platform: { type: 'string', enum: ['facebook', 'instagram'] }, index: { type: 'number' }, mime: { type: 'string', enum: ['image/jpeg', 'image/png'] }, data: { type: 'string' } }, ['id', 'platform', 'mime', 'data']), handler: engineMedia },
  { name: 'engine_connect', description: 'Content Engine: a ten-minute link that connects your own Facebook account, so the Pages you can post to become your publishing rights.', inputSchema: obj({}), handler: engineConnect },
  { name: 'engine_calendar', description: 'Content Engine calendar: every team\'s scheduled and posted items (read-only for teams you are not in) plus your own teams\' drafts and holds, and the key dates (CitizenGO-wide and your teams\' own), between from and to (YYYY-MM-DD).', inputSchema: obj({ from: { type: 'string' }, to: { type: 'string' } }), handler: engineCalendar },
];

module.exports = { ENGINE_TOOLS, context };
