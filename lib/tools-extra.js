'use strict';
// Tools section (Nov 2026), pure parts: Page Inviter results from the
// extension's own usage reports, Campaign Copilot arguments for a petition
// link (the same rules as content-engine/make_links.py), and health checks.

const sum = (l) => l.reduce((a, r) => a + (Number(r.invites) || 0), 0);

// rows: inviter_usage rows; prevRows: the window before; follows: { page name: {follows, net} }.
function inviterSummary(rows, prevRows = [], follows = {}) {
  const names = new Map(rows.filter((r) => r.page_name).map((r) => [r.page_id, r.page_name]));
  const group = (list, key) => { const m = new Map(); for (const r of list) { const k = key(r); m.set(k, [...(m.get(k) || []), r]); } return m; };
  const prevBy = group(prevRows, (r) => r.page_id);
  const pages = [...group(rows, (r) => r.page_id)].map(([id, l]) => {
    const name = names.get(id) || id; const f = follows[name] || {};
    return { page_id: id, name, invites: sum(l), before: sum(prevBy.get(id) || []), people: new Set(l.map((r) => r.user_email)).size,
      last: l.reduce((a, r) => (r.day > a ? r.day : a), ''), follows: f.follows ?? null, net: f.net ?? null };
  }).sort((a, b) => b.invites - a.invites);
  const people = [...group(rows, (r) => r.user_email)].map(([u, l]) => ({ who: u, invites: sum(l), pages: new Set(l.map((r) => r.page_id)).size, computers: new Set(l.map((r) => r.device_id)).size,
    last: l.reduce((a, r) => (r.day > a ? r.day : a), ''), version: l.reduce((a, r) => (String(r.updated_at) > a.t ? { t: String(r.updated_at), v: r.extension_version } : a), { t: '' }).v || null })).sort((a, b) => b.invites - a.invites);
  const days = [...group(rows, (r) => r.day)].map(([d, l]) => ({ day: d, invites: sum(l) })).sort((a, b) => a.day.localeCompare(b.day));
  return { invites: sum(rows), before: sum(prevRows), pages, people, days };
}

// Copilot arguments for one platform, from a citizengo.org petition URL.
const SOURCE = { facebook: 'fb', instagram: 'ig', x: 'tw' };
const SERIES = { facebook: 'FB', instagram: 'IG', x: 'TW' };
function cleanTitle(title) {
  const t = String(title || '').normalize('NFKD').replace(/[^\x00-\x7f]/g, '').replace(/['’]/g, '');
  let out = '';
  for (const w of t.split(/[^A-Za-z0-9]+/).filter(Boolean).map((x) => x[0].toUpperCase() + x.slice(1))) {
    const nxt = out ? `${out} ${w}` : w;
    if (nxt.length > 60) break;
    out = nxt;
  }
  return out.replace(/( (And|Or|The|To|Of|A|An|For|In|On|With))+$/, '') || 'NA';
}
function petitionOf(url) {
  let u; try { u = new URL(/^https?:\/\//.test(url) ? url : `https://${url}`); } catch (e) { return null; }
  if (!/(^|\.)citizengo\.org$/.test(u.hostname)) return null;
  const path = u.pathname.split('/').filter(Boolean);
  const idSeg = path.find((s) => /^\d{3,}/.test(s));
  if (!idSeg || path.length < 2) return null;
  return { url: `https://citizengo.org/${path.join('/')}`, petitionId: Number(idSeg.match(/^\d+/)[0]), listCode: path[0].toUpperCase().replace(/-/g, '_'), topicCode: path.length > 2 ? path[1].toUpperCase() : 'NA' };
}
function copilotArgs(pet, { platform, series = 1, scope = 'LO', title }) {
  return { assetType: 'petition', petitionId: pet.petitionId, ctaFamilyCode: 'AA', platformCode: SOURCE[platform], seriesFlow: `${SERIES[platform]}${series}`,
    listCode: pet.listCode, topicCode: pet.topicCode, scopeCode: ['LO', 'IN', 'GL'].includes(scope) ? scope : 'LO', campaignTitle: cleanTitle(title) };
}

// Health checks. Each is { level: 'bad'|'warn'|'ok'|'info', title, detail }.
const hoursAgo = (t, now) => (t ? (now - Date.parse(t)) / 3600e3 : null);
const ago = (h) => (h === null ? 'never' : h < 1 ? 'under an hour ago' : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`);
function healthChecks({ team, tokens = [], rights = [], pauses = [], runs = [], sigPulled = null, peersChecked = null, listenRows = 0, newsRows = 0, inviterLast = {}, now = Date.now() }) {
  const out = [];
  const accts = (team.accounts || []).filter((a) => ['facebook', 'instagram'].includes(a.platform));
  for (const a of accts) {
    const can = rights.filter((r) => r.account_key === a.key).map((r) => r.who);
    if (!can.length) out.push({ level: 'bad', title: `Nobody can post to ${a.name || a.label || a.key}`, detail: 'Someone with access to it connects Facebook in Settings › Connect Facebook.' });
    else if (can.length === 1) out.push({ level: 'warn', title: `Only ${can[0]} can post to ${a.name || a.label || a.key}`, detail: 'If their connection lapses, posts to it stop. A second person connecting Facebook covers it.' });
  }
  const checked = rights.map((r) => r.checked_at).filter(Boolean).sort().pop();
  if (rights.length) {
    const h = hoursAgo(checked, now);
    out.push(h !== null && h > 36 ? { level: 'warn', title: 'Posting rights not re-checked lately', detail: `Last checked ${ago(h)}; the Mini re-checks every night.` }
      : { level: 'ok', title: 'Posting rights checked', detail: `Every connection re-checked ${ago(h)}.` });
  }
  const stale = [];
  for (const a of accts) { const t = tokens.find((x) => x.account_key === a.key && x.connected_at); if (t && hoursAgo(t.connected_at, now) > 50 * 24) stale.push(`${t.who} on ${a.name || a.label || a.key}`); }
  if (stale.length) out.push({ level: 'info', title: 'Old Facebook connections', detail: `Connected over 50 days ago: ${stale.join(', ')}. Facebook can end them; reconnecting refreshes them.` });
  for (const p of pauses) out.push({ level: 'warn', title: 'Posting is paused', detail: `${p.reason || 'Paused'} (by ${p.paused_by}${p.until ? `, until ${String(p.until).slice(0, 16).replace('T', ' ')}` : ''}).` });
  const lateRuns = runs.filter((r) => hoursAgo(r.started_at, now) > 36 || r.status === 'error');
  out.push(lateRuns.length ? { level: 'warn', title: 'Facebook figures are late', detail: lateRuns.map((r) => `${r.name || r.page_id}: ${r.status === 'error' ? 'last read failed' : `last read ${ago(hoursAgo(r.started_at, now))}`}`).join('; ') }
    : runs.length ? { level: 'ok', title: 'Facebook figures up to date', detail: `Last read ${ago(hoursAgo(runs.map((r) => r.started_at).sort().pop(), now))}.` } : { level: 'info', title: 'No Facebook figures yet', detail: 'This team has no Pages being read.' });
  const sh = hoursAgo(sigPulled, now);
  out.push(sh === null ? { level: 'info', title: 'No signatures pulled yet', detail: 'Looker signatures arrive nightly once links are made.' } : sh > 36 ? { level: 'warn', title: 'Signatures are late', detail: `Looker last pulled ${ago(sh)}.` } : { level: 'ok', title: 'Signatures up to date', detail: `Looker pulled ${ago(sh)}.` });
  const ph = hoursAgo(peersChecked, now);
  if (ph !== null) out.push(ph > 36 ? { level: 'warn', title: 'Ally and opponent watch is late', detail: `Last read ${ago(ph)}.` } : { level: 'ok', title: 'Ally and opponent watch up to date', detail: `Last read ${ago(ph)}.` });
  out.push(listenRows || newsRows ? { level: 'ok', title: 'Hashtags and news read', detail: `${listenRows} hashtag posts and ${newsRows} headlines in the last two days.` } : { level: 'warn', title: 'No hashtags or news in two days', detail: 'The daily Listening job (06:40) may have failed.' });
  for (const a of (team.accounts || []).filter((x) => x.platform === 'facebook' && x.page_id)) {
    const last = inviterLast[a.page_id]; const h = last ? hoursAgo(`${last}T23:59:00Z`, now) : null;
    if (h === null) out.push({ level: 'info', title: `Page Inviter hasn't run on ${a.name || a.label || a.key}`, detail: 'Nobody has reported invites for this Page in 90 days.' });
    else if (h > 7 * 24) out.push({ level: 'info', title: `Page Inviter last ran on ${a.name || a.label || a.key} ${ago(h)}`, detail: 'Reactions keep coming in; a run invites them to like the Page.' });
  }
  const rank = { bad: 0, warn: 1, info: 2, ok: 3 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

module.exports = { inviterSummary, cleanTitle, petitionOf, copilotArgs, healthChecks };
