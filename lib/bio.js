'use strict';
// Link in bio [Phase 3, chosen 2 Nov 2026]: one public page per team, for the
// Instagram and X bios, in the style of Linktree. It fills itself with the
// petitions the team's posts linked to recently, newest first; people can
// pin, feature, hide, retitle, date and add links. Every petition button goes
// out as a Campaign Copilot link marked BIO (lib/tracked.js), so signatures
// from the bio are attributed in Looker like any other link. Clicks are
// counted by the page's own redirect. Pure functions here; storage and the
// Copilot calls live in the engine_bio tool and api/bio.js.

const L = require('./links');

const AUTO_DAYS = 30;
const AUTO_MAX = 6;
const ITEMS_MAX = 20;
const TITLE_MAX = 80;
const SLUG = /^[a-z0-9][a-z0-9-]{1,30}$/;

const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// "19691-sacked-for-being--pro-life---send-anita-your-support" → "Sacked for being pro life send anita your support"
function titleFromUrl(url) {
  try {
    const m = new URL(url).pathname.match(/\/\d+-([^/?#]+)/);
    if (!m) return null;
    const t = decodeURIComponent(m[1]).replace(/-+/g, ' ').trim();
    return t ? clip(t[0].toUpperCase() + t.slice(1), TITLE_MAX) : null;
  } catch (e) { return null; }
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
// team's engine posts (better than the URL's words).
function autoItems(rows, { accounts, titles = {}, now = Date.now(), days = AUTO_DAYS, max = AUTO_MAX } = {}) {
  const mine = teamMatcher(accounts);
  const since = now - days * 864e5;
  const seen = new Map();
  for (const r of (rows || []).slice().sort((a, b) => String(b.posted_at).localeCompare(String(a.posted_at)))) {
    if (!mine(r) || Date.parse(r.posted_at) < since) continue;
    const url = cleanPetitionUrl(r.full_url || r.url);
    if (!url) continue;
    const id = String(r.petition_id || L.petitionIdOf?.(url) || url.split('/').pop());
    const prev = seen.get(id);
    if (prev) { prev.posts++; continue; }
    seen.set(id, { id: 'p' + id, petition_id: id, url, title: clip(titles[id], TITLE_MAX) || titleFromUrl(r.full_url || r.url) || `Petition ${id}`, last_posted: r.posted_at, posts: 1, auto: true });
    if (seen.size >= max) break;
  }
  return [...seen.values()];
}

// A saved item, checked: what people may set on a button.
function cleanItem(i) {
  const url = String(i.url || '').trim();
  if (!/^https:\/\//i.test(url)) return null;
  const id = String(i.id || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'l' + Math.random().toString(36).slice(2, 8);
  const day = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? String(d) : null);
  return {
    id, url: url.slice(0, 500), title: clip(i.title, TITLE_MAX) || 'Link',
    petition_id: i.petition_id ? String(i.petition_id).replace(/\D/g, '').slice(0, 12) || null : null,
    pinned: !!i.pinned, featured: !!i.featured, hidden: !!i.hidden,
    starts: day(i.starts), ends: day(i.ends), auto: !!i.auto,
    tracked: i.tracked && /^https:\/\//.test(i.tracked) ? String(i.tracked).slice(0, 500) : null,
    code: i.code ? String(i.code).slice(0, 160) : null,
  };
}

function checkSettings(s) {
  const slug = String(s.slug || '').toLowerCase();
  if (!SLUG.test(slug)) return { error: 'The page address can use lower-case letters, numbers and dashes, 2 to 31 characters.' };
  return { slug, title: clip(s.title, 60) || 'CitizenGO', intro: clip(s.intro, 160), auto: s.auto !== false };
}

// The buttons as the page shows them: pinned first, then (if auto is on)
// recent campaigns not already saved, then the other saved links; hidden
// and out-of-date ones left out. A saved item with the same petition as an
// auto one replaces it (so a retitle or hide sticks).
function resolve(bio, auto, { now = Date.now() } = {}) {
  const today = new Date(now).toISOString().slice(0, 10);
  const saved = (bio.items || []).map(cleanItem).filter(Boolean);
  const savedPet = new Set(saved.map((i) => i.petition_id).filter(Boolean));
  const fresh = bio.auto === false ? [] : (auto || []).filter((a) => !savedPet.has(a.petition_id)).map(cleanItem).filter(Boolean);
  const live = (i) => !i.hidden && (!i.starts || i.starts <= today) && (!i.ends || i.ends >= today);
  const pinned = saved.filter((i) => i.pinned);
  const savedAuto = saved.filter((i) => !i.pinned && i.auto);
  const rest = saved.filter((i) => !i.pinned && !i.auto);
  const all = pinned.concat(savedAuto, fresh, rest);
  return { shown: all.filter(live).slice(0, ITEMS_MAX), all, today };
}

// The public page. Self-contained (no scripts, inline CSS), light and dark.
function pageHtml({ bio, items, logo = '/desk/go.png', base = '' }) {
  const btn = (i) => `<a class="b${i.featured ? ' f' : ''}" href="${esc(`${base}/links/${bio.slug}/go/${encodeURIComponent(i.id)}`)}" rel="nofollow">${esc(i.title)}</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(bio.title)}</title><meta name="description" content="${esc(bio.intro || bio.title)}"><meta name="robots" content="noindex">
<style>:root{--bg:#f5f7fb;--fg:#202124;--mu:#5f6673;--card:#fff;--line:#dfe4ee;--ac:#2563d9;--acf:#fff}
@media(prefers-color-scheme:dark){:root{--bg:#0f1420;--fg:#e7eaf1;--mu:#9aa4b8;--card:#171d2b;--line:#2a3347;--ac:#7ea3ff;--acf:#0f1420}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:520px;margin:0 auto;padding:40px 16px 32px;display:flex;flex-direction:column;align-items:stretch;gap:12px}
.h{display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center;margin-bottom:8px}.h img{width:72px;height:72px}.h h1{margin:0;font-size:22px}.h p{margin:0;color:var(--mu)}
.b{display:block;text-align:center;text-decoration:none;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:999px;padding:14px 18px;font-weight:700;min-height:48px}
.b:hover,.b:focus-visible{border-color:var(--ac);outline:none}.b.f{background:var(--ac);color:var(--acf);border-color:var(--ac)}
footer{text-align:center;color:var(--mu);font-size:13px;margin-top:16px}footer a{color:var(--mu)}</style></head>
<body><main><div class="h"><img src="${esc(logo)}" alt="CitizenGO"><h1>${esc(bio.title)}</h1>${bio.intro ? `<p>${esc(bio.intro)}</p>` : ''}</div>
${items.length ? items.map(btn).join('\n') : '<p class="h">New campaigns are on their way.</p>'}
<footer><a href="https://citizengo.org">citizengo.org</a></footer></main></body></html>`;
}

module.exports = { AUTO_DAYS, AUTO_MAX, ITEMS_MAX, SLUG, titleFromUrl, cleanPetitionUrl, teamMatcher, autoItems, cleanItem, checkSettings, resolve, pageHtml, esc };

// Loading a team's page with its recent campaigns: shared by the engine_bio
// tool (the desk) and api/bio.js (the public page), so both show the same.
async function load(store, { team, bio, now = Date.now() }) {
  const T = require('./tracked');
  const since = new Date(now - AUTO_DAYS * 864e5).toISOString();
  const [rows, posts] = await Promise.all([
    store.linkPostsSince({ since }).catch(() => []),
    store.enginePosts({ team_ids: [team.id], limit: 500 }).catch(() => []),
  ]);
  const titles = Object.fromEntries(Object.entries(T.petitionsFrom(posts)).map(([id, v]) => [id, v.title]));
  const auto = autoItems(rows, { accounts: team.accounts, titles, now });
  return { auto, ...resolve(bio, auto, { now }) };
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
