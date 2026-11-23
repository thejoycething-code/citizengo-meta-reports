'use strict';
// D5 Quiet petitions (Chris, 23 Nov 2026): the team's live petitions that are
// still gaining signatures but haven't had a post for QUIET_DAYS, so the
// morning run gives each one a draft before the campaign goes quiet.
//
// "Ours": petitions the team's accounts linked to in the last LOOK_DAYS
// (link_posts) or its desk posts asked people to sign. Still gaining:
// petition_status.last14 > 0 (Bluebook, nightly). Live: not closed or won in
// Asana. Quiet: nothing posted, and no desk draft made, for QUIET_DAYS.

const B = require('./bio');

const QUIET_DAYS = 14;
const LOOK_DAYS = 90;
const MAX = 3;

function quietPetitions({ accounts, links = [], posts = [], status = [], now = Date.now(), days = QUIET_DAYS, max = MAX }) {
  const mine = B.teamMatcher(accounts);
  const cut = now - days * 864e5;
  const pets = {};
  const seen = (pid, at, title, url) => {
    const id = String(pid || '');
    if (!/^\d{1,9}$/.test(id)) return;
    const p = pets[id] = pets[id] || { id, last: 0, title: null, url: null };
    const t = Date.parse(at || '');
    if (Number.isFinite(t) && t > p.last) p.last = t;
    if (title && !p.title && !B.badTitle(title)) p.title = String(title).slice(0, 200);
    if (url && !p.url) p.url = B.cleanPetitionUrl(url);
  };
  for (const r of links || []) if (mine(r)) seen(r.petition_id, r.posted_at, null, r.full_url || r.url);
  for (const p of posts || []) {
    const a = (p.doc && p.doc.action) || {};
    if (!a.petitionId) continue;
    // Any draft counts as activity, binned ones too: a fresh one comes after QUIET_DAYS.
    const at = p.status === 'posted' || p.status === 'scheduled' ? (p.post_at || p.doc.createdAt || p.created_at) : (p.doc.createdAt || p.created_at);
    seen(a.petitionId, at, a.title, a.url);
  }
  const st = Object.fromEntries((status || []).map((s) => [String(s.petition_id), s]));
  return Object.values(pets).map((p) => {
    const s = st[p.id] || {};
    return { ...p, total: Number(s.site_total || s.total) || null, last14: s.last14 == null ? null : Number(s.last14), closed: B.autoClosed({ ...s, total: Number(s.total) || 0, last14: s.last14 == null ? null : Number(s.last14) }, { quiet: false }), victory: !!s.asana_victory, title: p.title || s.page_title || null };
  }).filter((p) => p.last && p.last < cut && p.last14 > 0 && !p.closed && !p.victory)
    .sort((a, b) => b.last14 - a.last14)
    .slice(0, max)
    .map((p) => ({ ref: `quiet:${p.id}:${new Date(now).toISOString().slice(0, 10)}`, petition_id: p.id, title: p.title, url: p.url || `https://citizengo.org/en-gb/${p.id}`, signatures: p.total, last14: p.last14, last_post: new Date(p.last).toISOString().slice(0, 10), quiet_days: Math.floor((now - p.last) / 864e5) }));
}

async function quietFor(store, team, { now = Date.now() } = {}) {
  const [links, posts] = await Promise.all([
    store.linkPostsSince ? store.linkPostsSince({ since: new Date(now - LOOK_DAYS * 864e5).toISOString() }).catch(() => []) : [],
    store.enginePosts({ team_ids: [team.id], limit: 500 }).catch(() => []),
  ]);
  const ids = new Set();
  const mine = B.teamMatcher(team.accounts);
  for (const r of links || []) if (mine(r) && r.petition_id) ids.add(String(r.petition_id));
  for (const p of posts || []) if (p.doc && p.doc.action && p.doc.action.petitionId) ids.add(String(p.doc.action.petitionId));
  const status = ids.size && store.petitionStatus ? await store.petitionStatus({ ids: [...ids] }).catch(() => []) : [];
  return quietPetitions({ accounts: team.accounts, links, posts, status, now });
}

module.exports = { QUIET_DAYS, LOOK_DAYS, quietPetitions, quietFor };
