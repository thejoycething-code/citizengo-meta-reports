'use strict';
// Content Engine rules (Phase 2, Nov 2026). Pure functions, so every rule the
// desk relies on is tested without a database (scripts/test-engine.js).
//
// Who sees what (country teams, options 1 + 3 of the Phase 2 design):
//   * A team's posts (the desk) are seen and edited only by its members and by
//     the maintainers (ENGINE_ADMINS). Nobody else learns they exist.
//   * Every signed-in person can see every team's calendar, but only the
//     SCHEDULED and POSTED items of teams they are not in, read-only. Their
//     own team's calendar shows drafts too, and is editable.
//   * Approving a post schedules it, so it needs a publishing right (from the
//     person's own Meta connection) for every Facebook or Instagram account it
//     goes to. X is posted by hand until the X API is paid for, so it needs none.

// 'archived' = a rejected post cleared from the desk's bin once the morning run
// has learnt from it (engine_trash). The run still reads it like 'rejected'.
const STATUSES = ['review', 'changes', 'hold', 'scheduled', 'posted', 'rejected', 'archived'];
const OPEN = ['review', 'changes', 'hold', 'scheduled'];

// Board statuses (the artifact's store) to Phase 2 ones, for the move-over.
// "approved" on the board meant "ready for a person to post by hand": with a
// future time it is scheduled, otherwise it waits on hold for a time.
function fromBoardStatus(status, at, now = Date.now()) {
  switch (status || 'pending') {
    case 'pending': return 'review';
    case 'changes': return 'changes';
    case 'approved': return at && Date.parse(at) > now ? 'scheduled' : 'hold';
    case 'scheduled': return 'scheduled';
    case 'posted': return 'posted';
    case 'rejected': return 'rejected';
    // The board's weekly purge moved old rejects to "archived".
    case 'archived': return 'rejected';
    default: return 'review';
  }
}

const list = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const isMaintainer = (who, env = process.env) => !!who && list(env.ENGINE_ADMINS).includes(String(who).toLowerCase());
const signedIn = (who) => !!who && who !== 'anonymous';

// members: engine_members rows. Returns { team_id: role } for this person.
function teamsOf(members, who) {
  const me = String(who || '').toLowerCase();
  const out = {};
  for (const m of members || []) if (String(m.who).toLowerCase() === me) out[m.team_id] = m.role;
  return out;
}

function canEditTeam({ who, myTeams, maintainer }, teamId) {
  return !!maintainer || Object.prototype.hasOwnProperty.call(myTeams || {}, teamId);
}

// The account keys a post goes to.
function destinations(doc) {
  const d = doc && doc.posting && doc.posting.destinations;
  return Array.isArray(d) ? d.filter((x) => typeof x === 'string') : [];
}

// When it goes out: per-account times win over the single time. Earliest
// first, for the calendar.
function postTimes(doc) {
  const p = (doc && doc.posting) || {};
  const out = {};
  for (const k of destinations(doc)) {
    const t = (p.times && p.times[k]) || p.at;
    if (t && !Number.isNaN(Date.parse(t))) out[k] = new Date(t).toISOString();
  }
  return out;
}
function postAt(doc) {
  const ts = Object.values(postTimes(doc)).sort();
  return ts[0] || null;
}

// Accounts that need a Meta publishing right: Facebook and Instagram. X is
// copied and posted by hand for now.
function needsRight(team, key) {
  const acc = ((team && team.accounts) || []).find((a) => a.key === key);
  const platform = acc ? acc.platform : (String(key).endsWith('-x') ? 'x' : 'meta');
  return platform !== 'x';
}

// rights: engine_publish_rights rows for this person.
function missingRights({ team, doc, rights }) {
  const have = new Set((rights || []).map((r) => r.account_key));
  return destinations(doc).filter((k) => needsRight(team, k) && !have.has(k));
}

// Status changes. Returns { ok, status, error }.
function transition({ from, action, doc, team, rights, note }) {
  const fail = (error) => ({ ok: false, status: from, error });
  switch (action) {
    case 'approve': {
      if (!['review', 'changes', 'hold', 'scheduled'].includes(from)) return fail(`A ${from} post can't be approved.`);
      if (!destinations(doc).length) return fail('Choose at least one account in "Where and when" first.');
      const missing = missingRights({ team, doc, rights });
      if (missing.length) return fail(`You can't publish to ${missing.join(', ')}. Untick ${missing.length === 1 ? 'it' : 'them'}, or ask someone who manages ${missing.length === 1 ? 'that Page' : 'those Pages'}.`);
      const times = postTimes(doc);
      const untimed = destinations(doc).filter((k) => !times[k]);
      if (untimed.length) return fail(`No time set for ${untimed.join(', ')}.`);
      return { ok: true, status: 'scheduled' };
    }
    case 'hold':
      if (!['review', 'changes', 'scheduled'].includes(from)) return fail(`A ${from} post can't be put on hold.`);
      return { ok: true, status: 'hold' };
    case 'changes':
      if (!['review', 'hold', 'scheduled'].includes(from)) return fail(`A ${from} post can't be sent back for changes.`);
      if (!String(note || '').trim()) return fail('Say what needs to change.');
      return { ok: true, status: 'changes' };
    case 'reject':
      if (['posted', 'rejected', 'archived'].includes(from)) return fail(`A ${from} post can't be rejected.`);
      return { ok: true, status: 'rejected' };
    case 'reopen':
      if (!['rejected', 'changes', 'hold', 'scheduled'].includes(from)) return fail(`A ${from} post can't go back to review.`);
      return { ok: true, status: 'review' };
    // Records that it went out (by hand on X, or before Meta publishing
    // exists). Needs no right: it changes nothing on the Page.
    case 'posted':
      if (!['scheduled', 'hold'].includes(from)) return fail(`A ${from} post can't be marked as posted.`);
      return { ok: true, status: 'posted' };
    default:
      return fail(`Unknown action: ${action}.`);
  }
}

// A save while scheduled must not add an account the person can't publish to.
function saveAllowed({ status, before, after, team, rights }) {
  if (status === 'posted' || status === 'rejected' || status === 'archived') return { ok: false, error: `A ${status} post can't be edited.` };
  if (status !== 'scheduled') return { ok: true };
  const had = new Set(destinations(before));
  const added = { posting: { destinations: destinations(after).filter((k) => !had.has(k)) } };
  const missing = missingRights({ team, doc: added, rights });
  return missing.length ? { ok: false, error: `You can't publish to ${missing.join(', ')}.` } : { ok: true };
}

// Pause everything [1 Nov, A + B + C]. A person pauses only what they can
// post to: Facebook and Instagram accounts they hold a right for, and their
// teams' X accounts (posted by hand). Scope 'all' (every account) is for
// maintainers. Returns { ok, account_keys } or { ok: false, error }.
const PAUSE_MAX_HOURS = 24 * 7;
function pauseAccounts({ scope, team, ctx, teams, rights }) {
  const have = new Set((rights || []).map((r) => r.account_key));
  const mine = (t) => ((t && t.accounts) || []).map((a) => a.key).filter((k) => !needsRight(t, k) || have.has(k));
  if (scope === 'all') {
    if (!ctx.maintainer) return { ok: false, error: 'Only an organisation admin can pause every account.' };
    return { ok: true, account_keys: [] };
  }
  if (scope === 'team') {
    const t = (teams || []).find((x) => x.id === team);
    if (!t || !canEditTeam(ctx, t.id)) return { ok: false, error: 'You can only pause your own teams.' };
    const keys = mine(t);
    return keys.length ? { ok: true, account_keys: keys } : { ok: false, error: `You can't post to any of ${t.name || t.id}'s accounts, so there is nothing for you to pause.` };
  }
  if (scope === 'mine') {
    const keys = [...new Set((teams || []).filter((t) => canEditTeam(ctx, t.id)).flatMap(mine))];
    return keys.length ? { ok: true, account_keys: keys } : { ok: false, error: "You can't post to any account, so there is nothing for you to pause." };
  }
  return { ok: false, error: `Unknown scope: ${scope}.` };
}

// A post's type for automations: petition, prayer, reel, wins or news (null
// when it is none of these).
const NEWS_TEMPLATES = ['news', 'newsbox', 'newscaps', 'newsecon', 'roundup', 'torn'];
function postType(doc) {
  const d = doc || {}; const card = d.card || {}; const t = String(card.template || '');
  if (t === 'agenda' || /\bpray/i.test(`${d.title || ''} ${d.kind || ''}`)) return 'prayer';
  if (t === 'duo' && /victory|win|won/i.test(`${card.flag || ''} ${card.tag || ''}`) || /\bwins?\b|victory/i.test(d.kind || '')) return 'wins';
  if (t === 'reel' || ['facebook', 'instagram'].some((p) => d.final && d.final[p] && d.final[p].video)) return 'reel';
  if (NEWS_TEMPLATES.includes(t)) return 'news';
  if (d.action && /citizengo\.org|cgo\.ac/i.test(d.action.url || '')) return 'petition';
  return null;
}
// Comment-to-DM set on the draft itself: on by default for petition posts.
function draftCommentDm(doc) {
  const d = doc || {}; const c = d.commentDm || {};
  const flag = c.on !== undefined ? c.on : (d.posting || {}).comment_dm;
  const on = flag === undefined ? postType(d) === 'petition' : !!flag;
  if (!on) return null;
  const link = (d.links && Object.values(d.links).map((l) => l && l.short).find(Boolean)) || (d.action && d.action.url) || null;
  if (!link) return null;
  return { keyword: String(c.keyword || 'SIGN').trim() || 'SIGN', dm: String(c.dm || `Thank you for standing with us! Here's the link to add your name: ${link}`).replace(/\[ACTION LINK\]/g, link), link };
}

function pauseActive(p, now = Date.now()) {
  return !!p && !p.resumed_at && (!p.until || Date.parse(p.until) > now);
}

// { account_key: pause } for the accounts held right now ('*' = every one).
function pausedKeys(pauses, now = Date.now()) {
  const out = {};
  for (const p of pauses || []) {
    if (!pauseActive(p, now)) continue;
    for (const k of p.scope === 'all' ? ['*'] : p.account_keys || []) if (!out[k]) out[k] = p;
  }
  return out;
}
function pauseFor(held, key) { return held[key] || held['*'] || null; }

// The person who paused, a maintainer, or anyone who could have paused every
// account it covers can resume it.
function canResume(p, { ctx, teams, rights }) {
  if (ctx.maintainer || String(p.paused_by).toLowerCase() === String(ctx.who || '').toLowerCase()) return true;
  if (p.scope === 'all') return false;
  const mine = pauseAccounts({ scope: 'mine', ctx, teams, rights });
  return mine.ok && (p.account_keys || []).every((k) => mine.account_keys.includes(k));
}

// Pauses a person sees: any that touch their teams' accounts, and every
// organisation-wide one.
function pausesVisible(pauses, { ctx, teams }, now = Date.now()) {
  const keys = new Set((teams || []).filter((t) => canEditTeam(ctx, t.id)).flatMap((t) => (t.accounts || []).map((a) => a.key)));
  return (pauses || []).filter((p) => pauseActive(p, now) && (p.scope === 'all' || ctx.maintainer || (p.account_keys || []).some((k) => keys.has(k))));
}

// The daily engine's bookkeeping on a post [cutover, 1 Nov]: results, the
// real post links, its Asana task and the stale flag. Allowed in any status,
// posted and rejected included, because none of it changes what goes out.
const RECORD_KEYS = ['posted', 'results', 'stale'];
const RECORD_POSTING_KEYS = ['asanaTaskGid', 'asanaUrl', 'syncedAt', 'removedAt'];
function recordAllowed(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) return { ok: false, error: 'Nothing to record.' };
  for (const [k, v] of Object.entries(patch)) {
    if (RECORD_KEYS.includes(k)) continue;
    if (k === 'posting' && v && typeof v === 'object' && !Array.isArray(v)) {
      const bad = Object.keys(v).filter((x) => !RECORD_POSTING_KEYS.includes(x));
      if (!bad.length) continue;
      return { ok: false, error: `Only the Asana fields of posting can be recorded, not ${bad.join(', ')}.` };
    }
    return { ok: false, error: `${k} is part of the post: save it with engine_save instead.` };
  }
  return { ok: true };
}

// Plain-object deep merge for saves: objects merge, arrays and scalars
// replace, null removes the key. Matches how the board's store merged.
function mergeDoc(doc, patch) {
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const out = isObj(doc) ? { ...doc } : {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === null) delete out[k];
    else if (isObj(v) && isObj(out[k])) out[k] = mergeDoc(out[k], v);
    else out[k] = v;
  }
  return out;
}

// A Plan request: a date not in the past, a title, and nothing too long.
function checkRequest({ for_date, title, angle, source }, now = new Date()) {
  const d = String(for_date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))) return { ok: false, error: 'Pick the date it should go out.' };
  if (d < now.toISOString().slice(0, 10)) return { ok: false, error: 'That date has passed.' };
  const t = String(title || '').trim();
  if (!t) return { ok: false, error: 'Say what the post is about.' };
  return { ok: true, request: { for_date: d, title: t.slice(0, 200), angle: angle ? String(angle).trim().slice(0, 1000) : null, source: ['key_date', 'evergreen'].includes(source) ? source : 'idea' } };
}

// Evergreen bank A: due 10 weeks after it last went out (the 10-12 week
// window; still due after that until it is refreshed, snoozed or retired),
// "coming up" in the 4 weeks before, otherwise resting.
const EVERGREEN_DUE_WEEKS = 10;
function evergreenState(row, today = new Date()) {
  const day = (d) => new Date(`${String(d).slice(0, 10)}T00:00:00Z`);
  const t = day(today.toISOString());
  const last = day(row.last_out);
  const weeks = Math.floor((t - last) / (7 * 864e5));
  let due = new Date(last.getTime() + EVERGREEN_DUE_WEEKS * 7 * 864e5);
  if (row.snoozed_until && day(row.snoozed_until) > due) due = day(row.snoozed_until);
  const dueOn = due.toISOString().slice(0, 10);
  if (row.status === 'retired') return { state: 'retired', due_on: null, weeks_since: weeks };
  if (due <= t) return { state: 'due', due_on: dueOn, weeks_since: weeks };
  if (due - t <= 28 * 864e5) return { state: 'coming', due_on: dueOn, weeks_since: weeks };
  return { state: 'resting', due_on: dueOn, weeks_since: weeks };
}

function checkEvergreen({ title, last_out, url, format, account_key, result, why }, now = new Date()) {
  const t = String(title || '').trim();
  if (!t) return { ok: false, error: 'Give the post a title.' };
  const d = String(last_out || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))) return { ok: false, error: 'When did it last go out?' };
  if (d > now.toISOString().slice(0, 10)) return { ok: false, error: 'That date is in the future.' };
  if (url && !/^https:\/\//.test(String(url))) return { ok: false, error: 'The link should start https://' };
  const cut = (v, n) => (v ? String(v).trim().slice(0, n) : null);
  return { ok: true, row: { title: t.slice(0, 300), last_out: d, url: cut(url, 500), format: cut(format, 40), account_key: cut(account_key, 40), result: cut(result, 120), why: cut(why, 1000) } };
}

// "Connect Facebook" [slice 2]: the Pages a person manages (Graph
// /me/accounts) become publishing rights on the team accounts they match. A
// Facebook account needs the CREATE_CONTENT task on its Page; an Instagram
// account needs that Page's linked Instagram business account (by id, or by
// handle when the team only knows the handle). Returns one entry per account
// with the Page token to seal; never decides on anything the person can't post.
function rightsFromPages(teams, pages) {
  const out = [];
  const norm = (v) => String(v || '').replace(/^@/, '').toLowerCase();
  for (const page of pages || []) {
    if (!(page.tasks || []).includes('CREATE_CONTENT') || !page.access_token) continue;
    const ig = page.instagram_business_account || null;
    for (const team of teams || []) {
      for (const acc of team.accounts || []) {
        const fb = acc.platform === 'facebook' && acc.page_id && String(acc.page_id) === String(page.id);
        const insta = acc.platform === 'instagram' && ig
          && ((acc.ig_id && String(acc.ig_id) === String(ig.id)) || (!acc.ig_id && acc.handle && norm(acc.handle) === norm(ig.username)));
        if (fb || insta) out.push({ account_key: acc.key, team_id: team.id, page_id: String(page.id), page_name: page.name || '', ig_id: insta ? String(ig.id) : null, token: page.access_token });
      }
    }
  }
  return out;
}

// One calendar item, as a person may see it.
// The live post on each network once it has gone out: [{account, url}].
function liveLinks(doc) {
  const out = [];
  for (const [k, v] of Object.entries(doc.published || {})) if (v && /^https:\/\//.test(v.url || '')) out.push({ account: k, url: v.url });
  const r = doc.results || {};
  for (const k of ['facebook', 'instagram', 'x']) if (r[k] && /^https:\/\//.test(r[k].url || '') && !out.some((o) => o.url === r[k].url)) out.push({ account: k, url: r[k].url });
  return out;
}

function calendarItem(post, { editable }) {
  const doc = post.doc || {};
  const card = doc.card || {};
  return {
    id: post.id,
    team_id: post.team_id,
    status: post.status,
    title: post.title || doc.title || '',
    at: post.post_at,
    times: postTimes(doc),
    destinations: destinations(doc),
    thumb: (card.photo && card.photo.url) || (card.layers && (card.layers.find((l) => l.type === 'photo') || {}).url) || null,
    editable: !!editable,
    // Other teams see what is going out, not their working text.
    text: editable ? (doc.platforms && doc.platforms.facebook) || '' : undefined,
    // Live posts are public: their links let any team open what went out.
    links: liveLinks(doc),
  };
}

// Which posts a person sees on the calendar, and whether each is theirs to edit.
function calendarFor(posts, ctx) {
  const out = [];
  for (const p of posts || []) {
    const mine = canEditTeam(ctx, p.team_id);
    if (p.status === 'rejected') continue;
    if (!mine && !['scheduled', 'posted'].includes(p.status)) continue;
    out.push(calendarItem(p, { editable: mine && p.status !== 'posted' }));
  }
  return out.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
}

module.exports = {
  STATUSES, OPEN, fromBoardStatus, isMaintainer, signedIn, teamsOf, canEditTeam,
  destinations, postTimes, postAt, needsRight, missingRights, transition, saveAllowed,
  mergeDoc, calendarItem, calendarFor, checkRequest, evergreenState, checkEvergreen, EVERGREEN_DUE_WEEKS,
  rightsFromPages, recordAllowed, RECORD_KEYS, RECORD_POSTING_KEYS,
  postType, draftCommentDm, NEWS_TEMPLATES,
  pauseAccounts, pauseActive, pausedKeys, pauseFor, canResume, pausesVisible, PAUSE_MAX_HOURS,
};
