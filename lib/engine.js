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

const STATUSES = ['review', 'changes', 'hold', 'scheduled', 'posted', 'rejected'];
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
      if (from === 'posted' || from === 'rejected') return fail(`A ${from} post can't be rejected.`);
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
  if (status === 'posted' || status === 'rejected') return { ok: false, error: `A ${status} post can't be edited.` };
  if (status !== 'scheduled') return { ok: true };
  const had = new Set(destinations(before));
  const added = { posting: { destinations: destinations(after).filter((k) => !had.has(k)) } };
  const missing = missingRights({ team, doc: added, rights });
  return missing.length ? { ok: false, error: `You can't publish to ${missing.join(', ')}.` } : { ok: true };
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

// One calendar item, as a person may see it.
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
  mergeDoc, calendarItem, calendarFor,
};
