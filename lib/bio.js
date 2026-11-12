'use strict';
// Link in bio [Phase 3, chosen 2 Nov 2026; "Classic" style and parity
// features 2 Nov]: one public page per country team, for the Instagram and X
// bio. Only that country's team edits it (engine_bio tool). It fills itself
// with the petitions the team's posts linked to recently, newest first;
// people can reorder, pin, feature, section, close, mark won, remove, retitle,
// date, add a countdown and add links. Every petition button goes out as a
// Campaign Copilot link marked BIO (lib/tracked.js), so signatures from the
// bio are attributed in Looker like any other link. Page views (by where the
// visitor came from, ?s=ig|x|fb|tt|qr|wa) and clicks are counted by the
// page's own redirect, no cookies.
//
// Petition totals come from the Bluebook (Looker), and closed or won hints
// from each campaign's Asana project, both pulled nightly on the Mini into
// petition_status (scripts/link-signatures-mini.sh). A petition with no
// signatures in the Bluebook for 14 days drops off by itself; one whose
// Asana project is complete or archived, or whose evaluation task is done,
// counts as closed. Won is always a person's call.
//
// Pure functions here; storage and the Copilot calls live in the engine_bio
// tool and api/bio.js.

const L = require('./links');

const AUTO_DAYS = 30;
const AUTO_MAX = 6;
const ITEMS_MAX = 24;
const TITLE_MAX = 100;
const SHOW_MAX = 5; // petitions shown in a section before "More petitions"
const WIN_DAYS = 30;
const QUIET_DAYS = 14;
const GRID_MAX = 9;
const SLUG = /^[a-z0-9][a-z0-9-]{1,30}$/;
const SECTIONS = ['Act now', 'Pray with us', 'Get involved', 'More'];
const WINS = 'Recent wins';
const SOURCES = { ig: 'Instagram', x: 'X', fb: 'Facebook', tt: 'TikTok', qr: 'QR code', wa: 'WhatsApp' };
// Where a visitor's country sends them on the global link (team ids).
const COUNTRY_TEAM = { GB: 'uk', UK: 'uk' };

const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const day = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? String(d) : null);
const httpsUrl = (u, n = 500) => (/^https:\/\/[^\s"'<>]+$/i.test(String(u || '').trim()) ? String(u).trim().slice(0, n) : null);
const fmt = (n) => Number(n || 0).toLocaleString('en-GB');

// "19691-sacked-for-being--pro-life---send-anita-your-support" → "Sacked for being pro life send anita your support"
function titleFromUrl(url) {
  try {
    const m = new URL(url).pathname.match(/\/\d+-([^/?#]+)/);
    if (!m) return null;
    const t = decodeURIComponent(m[1]).replace(/-+/g, ' ').trim();
    return t ? clip(t[0].toUpperCase() + t.slice(1), TITLE_MAX) : null;
  } catch (e) { return null; }
}

// Titles [12 Nov 2026, L1]. A page's own title, without the site's name.
function pageTitle(t) {
  const v = String(t || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim()
    .replace(/\s*[|\-–—]\s*CitizenGO(\.org)?\s*$/i, '').replace(/^CitizenGO(\.org)?\s*[|\-–—:]\s*/i, '').trim();
  return v && !/^citizengo(\.org)?$/i.test(v) ? clip(v, TITLE_MAX) : null;
}
// "EN_GB - Tell Andy Burnham: Rule Out UK Rejoining the EU  - 10/2026" → the title.
function asanaTitle(name) {
  const v = String(name || '').replace(/^\s*[A-Z]{2}_[A-Z]{2}\s*[-–]\s*/, '').replace(/\s*[-–]\s*\d{1,2}\/\d{4}\s*$/, '').replace(/\s+/g, ' ').trim();
  return v && v !== String(name || '').trim() ? clip(v, TITLE_MAX) : null;
}
// A title that shouldn't go on the page: a placeholder, an internal working
// name, or words lifted from the address (all lower case).
function badTitle(t) {
  const v = String(t || '').trim();
  if (!v || /^(petition|link)( \d+)?$/i.test(v) || /^citizengo$/i.test(v)) return 'placeholder';
  if (/\b(petition launch|launch post|EN_[A-Z]{2}|draft|test post)\b/i.test(v)) return 'internal';
  const words = v.split(/\s+/);
  if (words.length >= 4 && words.slice(1).every((w) => w === w.toLowerCase()) && /\b(eu|uk|nhs|bbc|mp|mps|[a-z]+ham|london|scotland|england)\b/.test(v)) return 'lower';
  return null;
}
// Long titles are shortened at a word, not mid-word.
// A button title from the first sentence of our own post about a petition,
// when nothing better exists: emoji, hashtags and links dropped.
function titleFromText(text) {
  const first = String(text || '').split(/\n/).map((l) => l.trim()).find((l) => /[A-Za-z]{3}/.test(l)) || '';
  const v = first.replace(/https?:\/\/\S+/g, '').replace(/#\w+/g, '').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}👇👉]/gu, '').replace(/\s+/g, ' ').trim();
  if (v.length < 12) return null;
  if (v.length <= 90) return v;
  const s = v.match(/^(.{20,90}?[.!?])(\s|$)/);
  return s ? s[1] : shortTitle(v, 90);
}
function shortTitle(t, n = 72) {
  const v = String(t || '').trim();
  if (v.length <= n) return v;
  const cut = v.slice(0, n - 1);
  const at = cut.lastIndexOf(' ');
  return (at > n * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:\-–]+$/, '') + '…';
}

// Short titles [12 Nov 2026, Chris]: a button reads best under about 60
// characters. A long title keeps its first part when it has one ("Stop X -
// Protect Y: Z" becomes "Stop X"), else it is cut at a word.
const SHORT_MAX = 60;
function shortName(t, n = SHORT_MAX) {
  const v = String(t || '').replace(/\s+/g, ' ').trim();
  if (v.length <= n) return v;
  for (const sep of [' - ', ' – ', ' — ', ' | ', ': ']) {
    const at = v.indexOf(sep);
    if (at >= 15 && at <= n) return v.slice(0, at).trim();
  }
  return shortTitle(v, n);
}

// The bare petition link (no tracking parameters), so the same petition
// shared from three accounts is one button.
function cleanPetitionUrl(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)citizengo\.org$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/([a-z]{2}-[a-z]{2})\/([a-z]{2,3})\/(\d+)/i);
    return m ? `https://citizengo.org/${m[1].toLowerCase()}/${m[2].toLowerCase()}/${m[3]}` : null;
  } catch (e) { return null; }
}

// Which link_posts rows belong to a team: Facebook by Page id, Instagram by
// IG user id, X by handle.
function teamMatcher(accounts) {
  const ids = new Set(), handles = new Set();
  for (const a of accounts || []) {
    if (a.page_id) ids.add(String(a.page_id));
    if (a.ig_id) ids.add(String(a.ig_id));
    if (a.handle) handles.add('@' + String(a.handle).toLowerCase());
  }
  return (r) => ids.has(String(r.account_id)) || handles.has(String(r.account_label || '').toLowerCase());
}

// Recent campaigns: petitions the team linked to in the last AUTO_DAYS,
// newest first, one per petition. titles: petition id → title from the
// team's engine posts (better than the URL's words). lead: a petition a post
// asked to put in the bio when it went out (it comes first, even if the
// collection hasn't seen the post yet).
function autoItems(rows, { accounts, titles = {}, now = Date.now(), days = AUTO_DAYS, max = AUTO_MAX, lead = null } = {}) {
  const mine = teamMatcher(accounts);
  const since = now - days * 864e5;
  const seen = new Map();
  if (lead && lead.url && cleanPetitionUrl(lead.url)) {
    const id = String(lead.petition_id || L.petitionIdOf(lead.url));
    seen.set(id, { id: 'p' + id, petition_id: id, url: cleanPetitionUrl(lead.url), title: clip(titles[id] || lead.title, TITLE_MAX) || titleFromUrl(lead.url) || `Petition ${id}`, last_posted: lead.at, posts: 1, auto: true, lead: true });
  }
  for (const r of (rows || []).slice().sort((a, b) => String(b.posted_at).localeCompare(String(a.posted_at)))) {
    if (!mine(r) || Date.parse(r.posted_at) < since) continue;
    const url = cleanPetitionUrl(r.full_url || r.url);
    if (!url) continue;
    const id = String(r.petition_id || L.petitionIdOf(url) || url.split('/').pop());
    const prev = seen.get(id);
    if (prev) { prev.posts++; continue; }
    if (seen.size >= max) continue;
    seen.set(id, { id: 'p' + id, petition_id: id, url, title: clip(titles[id], TITLE_MAX) || titleFromUrl(r.full_url || r.url) || `Petition ${id}`, last_posted: r.posted_at, posts: 1, auto: true });
  }
  return [...seen.values()];
}

// The petition a post asked to put in the bio: the newest posted (or handed
// off) post going
// to Instagram, with "Change the Instagram link in bio" left ticked and a
// petition to act on, in the last AUTO_DAYS.
function leadFromPosts(posts, { now = Date.now(), days = AUTO_DAYS } = {}) {
  const since = now - days * 864e5;
  let best = null;
  for (const p of posts || []) {
    const doc = p.doc || {}, posting = doc.posting || {}, action = doc.action || {};
    // Posted, or (since posting moved to Asana, 8 Nov) handed off and its
    // time has come [12 Nov 2026, L9]: the person posting it may not close
    // the task for hours.
    const handed = p.status === 'scheduled' && posting.handoff && Date.parse(p.post_at || '') <= now;
    if ((p.status !== 'posted' && !handed) || posting.link_in_bio === false || !action.url || !cleanPetitionUrl(action.url)) continue;
    if (!(posting.destinations || []).some((k) => /(^|-)ig\d*$|instagram/i.test(String(k)))) continue;
    const at = (doc.posted && doc.posted.at) || p.post_at || p.updated_at;
    if (!at || Date.parse(at) < since || Date.parse(at) > now) continue;
    if (!best || String(at) > String(best.at)) best = { url: action.url, petition_id: action.petitionId || L.petitionIdOf(action.url), title: action.title || p.title, at };
  }
  return best;
}

// A saved item, checked: what people may set on a button.
function cleanItem(i) {
  const url = httpsUrl(i.url);
  if (!url) return null;
  const id = String(i.id || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'l' + Math.random().toString(36).slice(2, 8);
  const section = SECTIONS.includes(i.section) ? i.section : null;
  return {
    id, url, title: clip(i.title, TITLE_MAX) || 'Link',
    petition_id: String(i.petition_id || (cleanPetitionUrl(url) && L.petitionIdOf(url)) || '').replace(/\D/g, '').slice(0, 12) || null,
    pinned: !!i.pinned, featured: !!i.featured, hidden: !!(i.hidden || i.removed),
    closed: !!i.closed, won: !!i.won, won_at: i.won ? day(i.won_at) : null,
    starts: day(i.starts), ends: day(i.ends), auto: !!i.auto, section,
    cd_date: day(i.cd_date), cd_label: clip(i.cd_label, 40) || null,
    image: httpsUrl(i.image), retitled: !!i.retitled,
    title_src: ['page', 'asana', 'post', 'text', 'url', 'id'].includes(i.title_src) ? i.title_src : null,
    tracked: httpsUrl(i.tracked), code: i.code ? String(i.code).slice(0, 160) : null,
  };
}

const SETTINGS_DEFAULT = { donate_url: null, emails_url: null, whatsapp_url: null, grid: true, socials: true, totals: true, quiet: true };
function cleanSettings(s = {}) {
  const b = (k) => (s[k] === undefined ? SETTINGS_DEFAULT[k] : s[k] !== false);
  return { donate_url: httpsUrl(s.donate_url), emails_url: httpsUrl(s.emails_url), whatsapp_url: httpsUrl(s.whatsapp_url), grid: b('grid'), socials: b('socials'), totals: b('totals'), quiet: b('quiet'), bio_line: clip(s.bio_line, 160) || null };
}

function checkSettings(s) {
  const slug = String(s.slug || '').toLowerCase();
  if (!SLUG.test(slug)) return { error: 'The page address can use lower-case letters, numbers and dashes, 2 to 31 characters.' };
  return { slug, title: clip(s.title, 60) || 'CitizenGO', intro: clip(s.intro, 160), auto: s.auto !== false, settings: cleanSettings(s.settings || {}) };
}

// Why a petition is off the page by itself, from petition_status
// (Bluebook totals and Asana): 'asana' (campaign closed in Asana), 'quiet'
// (no signatures in 14 days) or null.
function autoClosed(st, { quiet = true } = {}) {
  if (!st) return null;
  if (st.asana_closed) return 'asana';
  if (quiet && st.total > 0 && st.last14 === 0) return 'quiet';
  return null;
}

// The buttons as the page shows them, in order: pinned first, then (if auto
// is on) recent campaigns not already saved, newest first, then the other
// saved buttons in the order people put them. Each comes with its section
// and, if it isn't shown, why. A saved item with the same petition as an
// auto one replaces it (so a retitle, move or remove sticks).
function resolve(bio, auto, { now = Date.now(), status = {} } = {}) {
  const today = new Date(now).toISOString().slice(0, 10);
  const settings = cleanSettings(bio.settings || {});
  const seenPet = new Set();
  const saved = (bio.items || []).map(cleanItem).filter(Boolean).filter((i) => !i.petition_id || (seenPet.has(i.petition_id) ? false : seenPet.add(i.petition_id)));
  const savedPet = new Set(saved.map((i) => i.petition_id).filter(Boolean));
  // New campaigns: the one a post asked for first, then the most signed in
  // the last 14 days, then the newest.
  const l14 = (a) => (status[a.petition_id] && Number(status[a.petition_id].last14)) || 0;
  const fresh = bio.auto === false ? [] : (auto || []).filter((a) => !savedPet.has(a.petition_id)).map((a) => ({ ...cleanItem(a), lead: !!a.lead, last_posted: a.last_posted })).filter((a) => a.id)
    .sort((a, b) => (b.lead - a.lead) || (l14(b) - l14(a)) || String(b.last_posted || '').localeCompare(String(a.last_posted || '')));
  const winFrom = new Date(now - WIN_DAYS * 864e5).toISOString().slice(0, 10);
  const why = (i) => {
    if (i.hidden) return 'removed';
    if (i.won) return i.won_at && i.won_at < winFrom ? 'won_old' : null;
    if (i.closed) return 'closed';
    if (i.starts && i.starts > today) return 'not_yet';
    if (i.ends && i.ends < today) return 'ended';
    if (i.petition_id && !i.pinned && !i.featured) { const a = autoClosed(status[i.petition_id], settings); if (a) return a; }
    return null;
  };
  const sectionOf = (i) => (i.won ? WINS : i.section || (i.petition_id ? SECTIONS[0] : SECTIONS[2]));
  const pinned = saved.filter((i) => i.pinned);
  const rest = saved.filter((i) => !i.pinned);
  const all = pinned.concat(fresh, rest).map((i) => ({ ...i, section: sectionOf(i), why: why(i) }));
  return { shown: all.filter((i) => !i.why).slice(0, ITEMS_MAX), all, today, settings };
}

// The big card at the top: the featured petition, else the one a post asked
// for, else the newest petition in Act now.
// The top card [12 Nov 2026, Chris, N1a]: the one chosen in the desk, else
// the petition with most signatures in the last 14 days, else the one a
// post asked for, else the first in Act now.
function pickHero(shown, status = {}) {
  const pets = shown.filter((i) => i.petition_id && !i.won);
  const busy = (i) => Number(status[String(i.petition_id)] && status[String(i.petition_id)].last14) || 0;
  const busiest = pets.filter((i) => busy(i) > 0).sort((a, b) => busy(b) - busy(a))[0];
  return pets.find((i) => i.featured) || busiest || pets.find((i) => i.lead) || pets.find((i) => i.section === SECTIONS[0]) || null;
}
function heroWhy(hero, status = {}) {
  if (!hero) return null;
  if (hero.featured) return 'chosen';
  const n = Number(status[String(hero.petition_id)] && status[String(hero.petition_id)].last14) || 0;
  return n > 0 ? 'busiest' : hero.lead ? 'post' : 'first';
}

// Round numbers worth a "Just passed" tag [N2]: 1,000, 5,000, 10,000,
// 25,000, 50,000, then every 10,000 to 100,000, then every 100,000.
function markOf(n) {
  const v = Number(n) || 0;
  if (v >= 100000) return Math.floor(v / 100000) * 100000;
  if (v >= 50000) return Math.floor(v / 10000) * 10000;
  return [25000, 10000, 5000, 1000].find((m) => v >= m) || 0;
}
// A petition's tag [12 Nov 2026, Chris, N2b]: "Just passed" for 2 days
// after a round number, else "New" for 7 days after it started.
function tagOf(st, now = Date.now()) {
  if (!st) return null;
  const at = Date.parse(st.passed_at || '');
  if (st.passed_mark && at && now - at < 2 * 864e5) return { kind: 'passed', mark: Number(st.passed_mark) };
  const start = Date.parse(st.site_start || '');
  if (start && now - start >= 0 && now - start < 7 * 864e5) return { kind: 'new' };
  return null;
}
const shortMark = (m) => (m >= 1e6 ? `${+(m / 1e6).toFixed(1)}m` : m >= 1000 ? `${Math.round(m / 1000)}k` : String(m));

// A round number to aim for, a little above where it is now.
const STEPS = [1000, 2500, 5000, 10000, 15000, 20000, 25000, 30000, 40000, 50000, 75000, 100000, 150000, 200000, 250000, 300000, 400000, 500000, 750000, 1000000];
function goalFor(total) {
  const t = Number(total) || 0;
  return STEPS.find((s) => s >= t * 1.1) || Math.ceil((t * 1.25) / 500000) * 500000;
}

// "Council decides in 4 days", from a countdown date and label.
function countdownText(i, today) {
  if (!i || !i.cd_date || !today) return null;
  const n = Math.round((Date.parse(i.cd_date) - Date.parse(today)) / 864e5);
  if (n < 0) return null;
  const what = i.cd_label || 'Ends';
  return n === 0 ? `${what} today` : n === 1 ? `${what} tomorrow` : `${what} in ${n} days`;
}

// The team's own accounts, one per platform, for the icons row.
function socialsFor(accounts, { whatsapp_url } = {}) {
  const out = [], seen = new Set();
  for (const a of accounts || []) {
    let url = null;
    if (a.platform === 'instagram' && a.handle) url = `https://www.instagram.com/${encodeURIComponent(a.handle)}`;
    else if (a.platform === 'facebook' && a.page_id) url = `https://www.facebook.com/${encodeURIComponent(a.page_id)}`;
    else if (a.platform === 'x' && a.handle) url = `https://x.com/${encodeURIComponent(String(a.handle).replace(/^@/, ''))}`;
    if (url && !seen.has(a.platform)) { seen.add(a.platform); out.push({ platform: a.platform, url }); }
  }
  if (whatsapp_url) out.push({ platform: 'whatsapp', url: whatsapp_url });
  return out;
}

const ICON = {
  instagram: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/>',
  facebook: '<path d="M15 3h-3a4 4 0 0 0-4 4v3H5v4h3v7h4v-7h3l1-4h-4V7h3z"/>',
  x: '<path d="M4 4l16 16M20 4L4 20"/>',
  whatsapp: '<path d="M4 20l1.5-4A8 8 0 1 1 8 18.5z"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>',
  link: '<path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
};
const icon = (k, s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;
const LABEL = { instagram: 'Instagram', facebook: 'Facebook', x: 'X', whatsapp: 'WhatsApp channel' };

// The one script on the page: Copy link. Its hash goes in the CSP.
const COPY_JS = 'document.addEventListener("click",function(e){var b=e.target.closest("[data-copy]");if(!b||!navigator.clipboard)return;e.preventDefault();navigator.clipboard.writeText(b.getAttribute("data-copy")).then(function(){b.setAttribute("aria-label","Link copied");b.classList.add("ok")})});';
const COPY_HASH = 'sha256-' + require('crypto').createHash('sha256').update(COPY_JS).digest('base64');

// The public page ("Classic"). Light and dark follow the phone.
function pageHtml({ bio, items, hero = null, grid = [], socials = [], status = {}, origin = '', src = null, today = null, logo = '/desk/go.png' }) {
  const settings = cleanSettings(bio.settings || {});
  const q = src && SOURCES[src] ? `?s=${src}` : '';
  const go = (i, s = q) => `${origin}/links/${bio.slug}/go/${encodeURIComponent(i.id)}${s}`;
  // One share button: the petition's own share page, the one signers see
  // after signing [12 Nov 2026, Chris]. Without it, our link to the petition.
  const share = (i) => {
    const st = i.petition_id && status[i.petition_id];
    const link = (st && st.share_url) || go(i, '?s=share');
    return `<a class="ic sq" href="${esc(link)}" aria-label="Share this petition" rel="noopener">${icon('share', 18)}</a>`;
  };
  // The total citizengo.org shows: every language's signatures when the
  // petition has a parent [12 Nov 2026, Chris]; else the Bluebook total.
  const totalOf = (i) => {
    const st = settings.totals && i.petition_id && status[i.petition_id];
    const t = st ? Math.max(Number(st.site_total) || 0, Number(st.total) || 0) : 0;
    return t > 0 ? t : null;
  };
  // The petition's own goal on citizengo.org [12 Nov 2026, Chris, 3a]; once
  // passed (before the site raises it), the next round number.
  const goalOf = (i, t) => {
    const g = Number(i.petition_id && status[i.petition_id] && status[i.petition_id].site_goal) || 0;
    return g > t ? g : goalFor(t);
  };
  const pct = (t, g) => Math.min(100, Math.round((100 * t) / g));
  const tag = (i) => (i.won || !i.petition_id ? null : tagOf(status[i.petition_id]));
  const pic = (i) => (i.image ? `<img class="th" src="${esc(i.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="th none" aria-hidden="true">${i.won ? icon('check') : esc((i.title || '?').trim()[0] || '?')}</span>`);
  const thumb = (i) => {
    const t = tag(i);
    if (!t) return pic(i);
    return `<span class="tw">${pic(i)}<span class="tg${t.kind === 'passed' ? ' ok' : ''}">${t.kind === 'passed' ? `Passed ${shortMark(t.mark)}` : 'New'}</span></span>`;
  };
  // Picture rows [12 Nov 2026, L2a]: a square picture, the title, and under
  // it the signatures and any countdown.
  const btn = (i) => {
    const t = totalOf(i), cd = !i.won && countdownText(i, today);
    const sub = i.won ? 'Won' : [t ? `${fmt(t)} signed` : '', cd ? `<b class="soon">${esc(cd)}</b>` : ''].filter(Boolean).join(' · ');
    // A progress bar on every petition [12 Nov 2026, Chris, 2a].
    const bar = t && !i.won ? `<span class="rbar" aria-hidden="true"><i style="width:${pct(t, goalOf(i, t))}%"></i></span>` : '';
    return `<a class="b${i.featured ? ' f' : ''}${i.won ? ' w' : ''}${i.petition_id || i.image ? ' pic' : ''}" href="${esc(go(i))}" rel="nofollow">${thumb(i)}<span class="bt"><span>${esc(i.retitled ? shortTitle(i.title) : shortName(i.title))}</span>${sub ? `<small>${sub}</small>` : ''}${bar}</span></a>`;
  };
  let heroHtml = '';
  if (hero) {
    const t = totalOf(hero), g = t ? goalOf(hero, t) : null, cd = countdownText(hero, today);
    const ht = tag(hero);
    const htHtml = ht ? `<span class="tg${ht.kind === 'passed' ? ' ok' : ''}">${ht.kind === 'passed' ? `Just passed ${fmt(ht.mark)}` : 'New'}</span>` : '';
    heroHtml = `<section class="hero" aria-label="Featured petition">${hero.image ? `<div class="hi"><img src="${esc(hero.image)}" alt="" referrerpolicy="no-referrer">${cd ? `<span class="cd">${esc(cd)}</span>` : ''}${htHtml}</div>` : cd || htHtml ? `<div class="cdl">${cd ? `<span class="cd">${esc(cd)}</span> ` : ''}${htHtml}</div>` : ''}
<div class="hb"><b class="ht">${esc(hero.retitled ? shortTitle(hero.title, 110) : shortName(hero.title, 90))}</b>${t ? `<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${g}" aria-valuenow="${t}" aria-label="Signatures"><i style="width:${pct(t, g)}%"></i></div><span class="mu"><b>${fmt(t)}</b> signed · help reach ${fmt(g)}</span>` : ''}
<div class="acts"><a class="sign" href="${esc(go(hero))}" rel="nofollow">Sign the petition</a>${share(hero)}</div></div></section>`;
  }
  const rest = items.filter((i) => !hero || i.id !== hero.id);
  const order = [];
  for (const i of rest) if (!order.includes(i.section)) order.push(i.section);
  if (order.includes(WINS)) { order.splice(order.indexOf(WINS), 1); order.push(WINS); }
  // Five per section, the rest folded under "More" [L3].
  const sections = order.map((s) => {
    const its = rest.filter((i) => i.section === s);
    const more = s === WINS ? [] : its.slice(SHOW_MAX);
    const top = s === WINS ? its : its.slice(0, SHOW_MAX);
    return `<h2>${esc(s)}</h2>\n${top.map(btn).join('\n')}${more.length ? `\n<details class="more"><summary>More ${s === SECTIONS[0] || s === SECTIONS[1] ? 'petitions' : 'links'} (${more.length})</summary><div class="ml">${more.map(btn).join('\n')}</div></details>` : ''}`;
  }).join('\n');
  const involve = [settings.donate_url && `<a class="b2 d" href="${esc(settings.donate_url)}" rel="nofollow">Donate</a>`, settings.emails_url && `<a class="b2" href="${esc(settings.emails_url)}" rel="nofollow">Get our emails</a>`].filter(Boolean);
  const icons = settings.socials && socials.length ? `<div class="soc">${socials.map((s) => `<a class="ic" href="${esc(s.url)}" aria-label="${esc(LABEL[s.platform] || s.platform)}" rel="noopener">${icon(s.platform)}</a>`).join('')}</div>` : '';
  const gridHtml = settings.grid && grid.length ? `<h2>Latest on Instagram</h2><div class="grid">${grid.map((g) => `<a href="${esc(g.href)}" rel="nofollow"${g.label ? ` aria-label="${esc(g.label)}"` : ' aria-label="Instagram post"'}><img src="${esc(g.img)}" alt="" loading="lazy" referrerpolicy="no-referrer"></a>`).join('')}</div><p class="mu c">Tap a post to see it on Instagram</p>` : '';
  const empty = !hero && !rest.length ? '<p class="mu c">New campaigns are on their way.</p>' : '';
  const url = `${origin}/links/${bio.slug}`;
  // The page's own link preview [12 Nov 2026, Chris, 5b]: the top card's
  // picture and an invitation to sign it.
  const others = rest.filter((i) => i.petition_id && !i.won).length;
  const ogImg = hero && /^https:\/\//.test(hero.image || '') ? hero.image : origin + logo;
  const ogDesc = hero ? `Sign ${shortName(hero.title)}${others ? ` and ${others} more petition${others === 1 ? '' : 's'}` : ''}.` : bio.intro || 'Sign, share, pray.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(bio.title)}</title><meta name="description" content="${esc(bio.intro || bio.title)}"><meta name="robots" content="noindex">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(bio.title)}"><meta property="og:description" content="${esc(ogDesc)}"><meta property="og:url" content="${esc(url)}"><meta property="og:image" content="${esc(ogImg)}"><meta name="twitter:card" content="${ogImg === origin + logo ? 'summary' : 'summary_large_image'}">
<style>:root{--bg:#f5f7fb;--fg:#202124;--mu:#5f6673;--card:#fff;--line:#dfe4ee;--ac:#2563d9;--acf:#fff;--soft:#e6eaf2;--ok:#1d7a46;--okbg:#eef8f1;--okl:#b9dcc6;--red:#b4282e}
@media(prefers-color-scheme:dark){:root{--bg:#0f1420;--fg:#e7eaf1;--mu:#9aa4b8;--card:#171d2b;--line:#2a3347;--ac:#7ea3ff;--acf:#0f1420;--soft:#2a3347;--ok:#7ad6a0;--okbg:#16261d;--okl:#2c5a3f;--red:#e0626a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:520px;margin:0 auto;padding:32px 16px 28px;display:flex;flex-direction:column;gap:10px}
.h{display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center}.h img{width:64px;height:64px}.h h1{margin:0;font-size:21px}.h p{margin:0;color:var(--mu);font-size:15px}
.soc{display:flex;gap:8px;justify-content:center;margin-top:4px}.ic{width:36px;height:36px;border-radius:50%;border:1px solid var(--line);background:var(--card);color:var(--fg);display:flex;align-items:center;justify-content:center;flex:none}.ic.sq{width:48px;height:48px}.ic.ok{border-color:var(--ok);color:var(--ok)}
.hero{background:var(--card);border:1px solid var(--line);border-radius:16px;overflow:hidden;margin-top:6px}.hi{position:relative;background:var(--soft);min-height:150px}.hi img{display:block;width:100%;height:200px;object-fit:cover}.cdl{padding:12px 14px 0}.cd{display:inline-block;background:var(--red);color:#fff;font-size:12px;font-weight:700;border-radius:999px;padding:3px 10px}.hi .cd{position:absolute;top:10px;left:10px}
.hb{padding:12px 14px 14px;display:flex;flex-direction:column;gap:8px}.ht{font-size:18px;line-height:1.25}.bar{height:8px;background:var(--soft);border-radius:999px;overflow:hidden}.bar i{display:block;height:8px;background:var(--ac);border-radius:999px}
.mu{color:var(--mu);font-size:14px;margin:0}.mu b{color:var(--fg)}.c{text-align:center}.acts{display:flex;gap:8px}.sign{flex:1;text-align:center;background:var(--ac);color:var(--acf);text-decoration:none;font-weight:700;border-radius:999px;padding:13px;min-height:48px}
h2{margin:12px 0 0;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--mu)}
.b{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:999px;padding:6px 16px 6px 6px;font-weight:700;font-size:15px;min-height:50px}
.b:hover,.b:focus-visible,.b2:hover,.b2:focus-visible,.ic:hover,.ic:focus-visible{border-color:var(--ac);outline:none}.b.f{border-color:var(--ac);box-shadow:inset 0 0 0 1px var(--ac)}.b.w{background:var(--okbg);border-color:var(--okl)}
.b.pic{border-radius:14px;padding:6px 14px 6px 6px}.b.pic .th{width:56px;height:56px;border-radius:10px}.b.pic .th.none{font-size:20px}.bt{display:flex;flex-direction:column;gap:2px;min-width:0}.bt small{font-weight:500;color:var(--mu);font-size:13px}.bt small .soon{color:var(--red)}.tw{position:relative;flex:none;display:block}.tg{position:absolute;left:-4px;bottom:-5px;font-size:10px;font-weight:800;line-height:1.4;border-radius:999px;padding:1px 6px;background:var(--ac);color:var(--acf);white-space:nowrap}.tg.ok{background:var(--ok);color:var(--card)}.cdl .tg{position:static;display:inline-block}.hi .tg{left:auto;bottom:auto;top:10px;right:10px;font-size:12px;padding:3px 10px}.rbar{display:block;height:5px;background:var(--soft);border-radius:999px;overflow:hidden;margin-top:3px;max-width:220px}.rbar i{display:block;height:5px;background:var(--ac);border-radius:999px}
.more summary{cursor:pointer;list-style:none;text-align:center;color:var(--ac);font-weight:700;font-size:15px;padding:10px;border-radius:999px}.more summary::-webkit-details-marker{display:none}.more summary:focus-visible{outline:2px solid var(--ac)}.more[open] summary{display:none}.ml{display:flex;flex-direction:column;gap:10px}
.th{width:38px;height:38px;border-radius:50%;object-fit:cover;flex:none}.th.none{display:flex;align-items:center;justify-content:center;background:var(--soft);color:var(--mu);font-weight:800}.b.w .th.none{background:var(--ok);color:var(--card)}
.two{display:grid;grid-template-columns:1fr 1fr;gap:8px}.b2{display:flex;align-items:center;justify-content:center;text-decoration:none;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:999px;font-weight:700;min-height:50px;padding:8px}.b2.d{background:var(--fg);color:var(--bg);border-color:var(--fg)}.two .b2:only-child{grid-column:1/-1}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:4px}.grid a{display:block;aspect-ratio:1;border-radius:4px;overflow:hidden;background:var(--soft)}.grid img{width:100%;height:100%;object-fit:cover;display:block}
footer{text-align:center;color:var(--mu);font-size:13px;margin-top:16px}footer a{color:var(--mu)}</style></head>
<body><main><div class="h"><img src="${esc(logo)}" alt="CitizenGO"><h1>${esc(bio.title)}</h1>${bio.intro ? `<p>${esc(bio.intro)}</p>` : ''}${icons}</div>
${heroHtml}
${sections}
${involve.length ? `<h2>Get involved</h2><div class="two">${involve.join('')}</div>` : ''}
${gridHtml}${empty}
<footer><a href="https://citizengo.org">citizengo.org</a></footer></main><script>${COPY_JS}</script></body></html>`;
}

// The global link's picker, for visitors we can't place in a country.
// A share card for one petition [12 Nov 2026, Chris, 5a]:
// /links/<slug>/p/<petition id>. Link previews (WhatsApp, X, Facebook) read
// its picture, title and total; people are sent straight on to sign.
function cardHtml({ bio, item, status = {}, origin = '' }) {
  const st = (item.petition_id && status[item.petition_id]) || {};
  const t = Math.max(Number(st.site_total) || 0, Number(st.total) || 0);
  const g = t ? (Number(st.site_goal) > t ? Number(st.site_goal) : goalFor(t)) : 0;
  const title = shortName(item.title, 90);
  const desc = t ? `${fmt(t)} signed. Help reach ${fmt(g)}.` : 'Add your name.';
  const to = `${origin}/links/${bio.slug}/go/${encodeURIComponent(item.id)}`;
  const img = /^https:\/\//.test(item.image || '') ? item.image : `${origin}/desk/go.png`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><meta name="robots" content="noindex">
<meta property="og:type" content="website"><meta property="og:site_name" content="${esc(bio.title)}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(`${origin}/links/${bio.slug}/p/${item.petition_id}`)}"><meta property="og:image" content="${esc(img)}"><meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0;url=${esc(to)}"></head>
<body style="font:16px system-ui,sans-serif;text-align:center;margin-top:20vh"><p><a href="${esc(to)}">${esc(title)}</a></p></body></html>`;
}

function pickerHtml({ pages, other = 'https://citizengo.org', logo = '/desk/go.png' }) {
  const row = (p) => `<a class="c" href="/links/${esc(p.slug)}"><span class="cc">${esc(p.code)}</span>${esc(p.name)}</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CitizenGO</title><meta name="robots" content="noindex">
<style>:root{--bg:#f5f7fb;--fg:#202124;--mu:#5f6673;--card:#fff;--line:#dfe4ee;--ac:#2563d9}@media(prefers-color-scheme:dark){:root{--bg:#0f1420;--fg:#e7eaf1;--mu:#9aa4b8;--card:#171d2b;--line:#2a3347;--ac:#7ea3ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:520px;margin:0 auto;padding:36px 16px 28px;display:flex;flex-direction:column;gap:10px}
.h{text-align:center}.h img{width:64px;height:64px}.h h1{margin:6px 0 0;font-size:21px}b{color:var(--mu);font-size:14px;margin-top:8px}
.c{display:flex;align-items:center;gap:12px;text-decoration:none;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;font-weight:700;min-height:50px}.c:hover,.c:focus-visible{border-color:var(--ac);outline:none}
.cc{width:36px;height:26px;border-radius:4px;background:var(--line);font-size:12px;font-weight:800;display:flex;align-items:center;justify-content:center}footer{text-align:center;color:var(--mu);font-size:13px;margin-top:16px}footer a{color:var(--mu)}</style></head>
<body><main><div class="h"><img src="${esc(logo)}" alt="CitizenGO"><h1>CitizenGO</h1></div><b>Choose your country</b>
${pages.map(row).join('\n')}
<a class="c" href="${esc(other)}"><span class="cc">+</span>All other countries</a>
<footer><a href="https://citizengo.org">citizengo.org</a></footer></main></body></html>`;
}

// Where the global link sends a visitor: their country's page, else the
// global team's page, else the picker (null).
function routeCountry(country, bios) {
  const c = String(country || '').toUpperCase();
  const team = COUNTRY_TEAM[c] || c.toLowerCase();
  const own = (bios || []).find((b) => b.team_id === team && team !== 'global');
  if (own) return own.slug;
  const global = (bios || []).find((b) => b.team_id === 'global');
  return global ? global.slug : null;
}

module.exports = { titleFromText, SHOW_MAX, GRID_MAX, TITLE_MAX, pageTitle, asanaTitle, badTitle, shortTitle, shortName, SHORT_MAX, AUTO_DAYS, AUTO_MAX, ITEMS_MAX, WIN_DAYS, QUIET_DAYS, SLUG, SECTIONS, WINS, SOURCES, COPY_HASH, titleFromUrl, cleanPetitionUrl, teamMatcher, autoItems, leadFromPosts, cleanItem, cleanSettings, checkSettings, autoClosed, resolve, pickHero, heroWhy, markOf, tagOf, goalFor, countdownText, socialsFor, pageHtml, cardHtml, pickerHtml, routeCountry, esc };

// Instagram's image links carry their expiry (oe=, hex seconds); one that
// runs out within a day is left out rather than shown broken.
function freshImage(url, now = Date.now()) {
  if (!url) return false;
  const m = String(url).match(/[?&]oe=([0-9a-f]{6,10})(?:&|$)/i);
  return !m || parseInt(m[1], 16) * 1000 > now + 864e5;
}
module.exports.freshImage = freshImage;

// Loading a team's page with its recent campaigns, totals, images and the
// Instagram grid: shared by the engine_bio tool (the desk) and api/bio.js
// (the public page), so both show the same.
async function load(store, { team, bio, now = Date.now() }) {
  const T = require('./tracked');
  const since = new Date(now - AUTO_DAYS * 864e5).toISOString();
  const igAccounts = (team.accounts || []).filter((a) => a.platform === 'instagram' && (a.ig_id || a.handle));
  const [rows, posts, gridMedia] = await Promise.all([
    store.linkPostsSince({ since }).catch(() => []),
    store.enginePosts({ team_ids: [team.id], limit: 500 }).catch(() => []),
    Promise.all(igAccounts.slice(0, 2).map((a) => (store.igGridMedia ? store.igGridMedia({ ig_user_id: a.ig_id || null, username: a.ig_id ? null : a.handle, limit: 12 }).catch(() => []) : []))),
  ]);
  const titles = Object.fromEntries(Object.entries(T.petitionsFrom(posts)).filter(([, v]) => v.title && !badTitle(v.title)).map(([id, v]) => [id, v.title]));
  const lead = leadFromPosts(posts, { now });
  const auto = autoItems(rows, { accounts: team.accounts, titles, now, lead });
  const ids = [...new Set(auto.map((a) => a.petition_id).concat(((bio && bio.items) || []).map((i) => i.petition_id)).filter(Boolean).map(String))];
  const statusRows = ids.length && store.petitionStatus ? await store.petitionStatus({ ids }).catch(() => []) : [];
  const status = Object.fromEntries((statusRows || []).map((s) => [String(s.petition_id), { ...s, total: s.total == null ? null : Number(s.total), last14: s.last14 == null ? null : Number(s.last14) }]));
  // Images: the newest Instagram post of ours that linked to each petition.
  const mine = teamMatcher(team.accounts);
  const igPostOf = {}, petitionOfPost = {};
  for (const r of (rows || []).slice().sort((a, b) => String(b.posted_at).localeCompare(String(a.posted_at)))) {
    if (r.platform !== 'instagram' || !mine(r) || !r.post_id || !r.petition_id) continue;
    petitionOfPost[String(r.post_id)] = String(r.petition_id);
    if (!igPostOf[r.petition_id]) igPostOf[r.petition_id] = String(r.post_id);
  }
  const grid = [].concat(...gridMedia).sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  const media = Object.fromEntries(grid.map((m) => [String(m.media_id), m]));
  const missing = Object.values(igPostOf).filter((id) => !media[id]);
  if (missing.length && store.igMediaByIds) for (const m of await store.igMediaByIds({ ids: missing }).catch(() => [])) media[String(m.media_id)] = m;
  // Pictures [12 Nov 2026, L1/L4]: the kept copy from the petition's page
  // or our own post (api/cron/bio.js), else our Instagram post's kept copy,
  // else its Instagram link while that still works.
  const igImage = (m) => (m && (m.image_copy || (freshImage(m.thumbnail_url, now) ? m.thumbnail_url : null))) || null;
  const imageOf = (pid) => (status[pid] && status[pid].page_image) || igImage(media[igPostOf[pid]]);
  // Titles: the petition page's own, else its Asana project's, else the
  // post's (unless it's a working name), else the address's words.
  const bestTitle = (pid) => {
    const st = status[pid] || {};
    if (st.page_title && st.page_title_src !== 'post') return { title: clip(st.page_title, TITLE_MAX), src: 'page' };
    const a = asanaTitle(st.asana_project);
    if (a) return { title: a, src: 'asana' };
    if (titles[pid]) return { title: clip(titles[pid], TITLE_MAX), src: 'post' };
    if (st.page_title) return { title: clip(st.page_title, TITLE_MAX), src: 'text' };
    return null;
  };
  const cdn = (u) => /^https:\/\/[^/]*(cdninstagram\.com|fbcdn\.net)\//i.test(String(u || ''));
  for (const a of auto) {
    a.image = imageOf(a.petition_id);
    const b = bestTitle(a.petition_id);
    if (b) { a.title = b.title; a.title_src = b.src; } else a.title_src = /^Petition \d+$/.test(a.title) ? 'id' : 'url';
  }
  const withImages = { ...bio, items: ((bio && bio.items) || []).map((i) => {
    if (!i.petition_id) return i;
    const pid = String(i.petition_id), out = { ...i };
    if (!out.image || (cdn(out.image) && !freshImage(out.image, now)) || (cdn(out.image) && status[pid] && status[pid].page_image)) out.image = imageOf(pid);
    const b = !out.retitled && bestTitle(pid);
    if (b && (out.auto || badTitle(out.title)) && !(b.src === 'text' && !badTitle(out.title))) { out.title = b.title; out.title_src = b.src; }
    return out;
  }) };
  const r = resolve(withImages, auto, { now, status });
  const hero = pickHero(r.shown, status);
  const byPetition = Object.fromEntries(r.shown.filter((i) => i.petition_id).map((i) => [i.petition_id, i]));
  const tiles = grid.filter((m) => igImage(m)).slice(0, GRID_MAX).map((m) => {
    const pid = petitionOfPost[String(m.media_id)], item = pid && byPetition[pid];
    return { media_id: m.media_id, img: igImage(m), item_id: item ? item.id : null, permalink: /^https:\/\/(www\.)?instagram\.com\//.test(m.permalink || '') ? m.permalink : null, label: clip(m.caption, 80) || (item ? item.title : null) };
  });
  // Kept for the cron: what it should fetch or copy next.
  return { auto, status, hero, heroWhy: heroWhy(hero, status), tiles, grid, media, igPostOf, socials: socialsFor(team.accounts, r.settings), ...r };
}

// Where a button goes: its petition as a Copilot link marked BIO (made once,
// then cached in engine_tracked_links, because the code is dated by when the
// petition was first posted, not by today), or the link as saved. Never
// throws: on any failure the plain link goes out.
async function destination(store, item, { owner = 'CJO', call, fetchImpl } = {}) {
  if (item.tracked) return item.tracked;
  if (!item.petition_id) return item.url;
  try {
    const T = require('./tracked');
    const when = Date.parse(item.last_posted || item.starts || '') || Date.UTC(2026, 10, 2);
    const r = await T.trackLink({ store, url: item.url, platform: 'instagram', mark: 'BIO', who: owner, owner, now: when, ...(call ? { call } : {}), ...(fetchImpl ? { fetchImpl } : {}) });
    return (r && r.to) || item.url;
  } catch (e) { return item.url; }
}

module.exports.load = load;
module.exports.destination = destination;
