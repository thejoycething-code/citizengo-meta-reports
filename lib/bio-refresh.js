'use strict';
// Link in bio keeps itself up to date [12 Nov 2026, Chris: "have the Link in
// Bio tool auto update itself"]. Run by Vercel Cron every 3 hours
// (api/cron/bio.js) and by the desk's "Refresh now" (engine_bio action
// refresh). For every saved page it:
//
//   L1  reads each petition's public citizengo.org page for its title and
//       picture (the preview a link shows on WhatsApp), and keeps a copy of
//       the picture in desk-assets so it never expires. With no picture on
//       the page it uses the picture on our own newest Facebook post, then
//       Instagram post, about that petition. Pages are read again after
//       3 days (1 day while something is missing).
//   L4  keeps a copy of each Instagram grid picture (Instagram's own picture
//       links stop working after a while).
//   L3  takes closed, ended and old won petitions out of the saved list once
//       no recent post brings them back, so the desk list stays short.
//
// Only public pages and our own posts' pictures. Never throws for one
// petition or picture: it notes the failure and moves on. Stops when its
// time budget is spent; the next run carries on.

const B = require('./bio');
const FL = require('./fromlink');

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const RECHECK_MS = 2 * 3600e3; // totals move, so every run (3-hourly) reads them again
const RETRY_MS = 864e5;

// The petition as citizengo.org itself shows it [12 Nov 2026, Chris]: the
// site's own API, the same one the petition page uses (no sign-in). count is
// the page's figure: the larger of this language's count (plus padding) and
// the all-language total, so a petition with a parent shows every
// language's signatures.
const SITE_API = 'https://api.citizengo.org/api/v1/single_petition/?id=';
function readSite(json) {
  let v = json;
  try { if (typeof v === 'string' || Buffer.isBuffer(v)) v = JSON.parse(String(v)); } catch (e) { return null; }
  const p = Array.isArray(v) ? v[0] : v;
  if (!p || typeof p !== 'object') return null;
  const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  const own = n(p.signature_count) + n(p.padding), all = n(p.cluster_count);
  const seg = p.segment || {};
  const image = typeof p.featured_image === 'string' && /^https:\/\//.test(p.featured_image) ? p.featured_image : null;
  const title = B.pageTitle(p.title);
  const id = String(p.id || '').replace(/\D/g, '');
  const locale = /^[a-z]{2}-[a-z]{2}$/i.test(seg.code || '') ? seg.code.toLowerCase() : null;
  const list = /^[A-Z]{2}_[A-Z]{2}$/i.test(seg.listcode || '') ? seg.listcode.toUpperCase() : null;
  return { title, image, count: Math.max(own, all) || null, own: n(p.signature_count) || null, share: id && locale ? shareUrl({ id, title: p.title, locale, list }) : null };
}
// The share step a signer sees after signing (/LP2-share).
function shareUrl({ id, title, locale, list }) {
  const slug = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `https://citizengo.org/${locale}/LP2-share?m=8&nid=${encodeURIComponent(id)}&title=${encodeURIComponent(slug)}${list ? `&list=${list}` : ''}&utm_source=bio&utm_medium=linkinbio`;
}

// Title and picture from a petition page's HTML.
function readPage(html, base) {
  const s = String(html || '').slice(0, 400000);
  const metas = s.match(/<meta\b[^>]*>/gi) || [];
  const meta = (want) => {
    for (const m of metas) {
      const key = (m.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
      const val = (m.match(/\bcontent\s*=\s*["']([^"']*)["']/i) || [])[1];
      if (key && val && key.toLowerCase() === want) return val;
    }
    return null;
  };
  const tag = (s.match(/<title[^>]*>([^<]{2,300})<\/title>/i) || [])[1];
  const title = B.pageTitle(meta('og:title') || meta('twitter:title') || tag);
  return { title, image: FL.ogImage(s, base) };
}

// Is a petition's page due another look?
function due(st, now) {
  if (!st || !st.page_checked_at) return true;
  const age = now - Date.parse(st.page_checked_at);
  return age > RECHECK_MS || ((!st.page_title || !st.page_image) && age > RETRY_MS);
}

// What to drop from the saved list: closed, ended or old won petitions no
// recent post brings back, unless pinned or removed on purpose (Remove must
// stick, so it stays saved).
function staleSaved(bio, L) {
  const autoIds = new Set((L.auto || []).map((a) => a.id));
  const why = Object.fromEntries((L.all || []).map((i) => [i.id, i.why]));
  return ((bio && bio.items) || []).filter((i) => !i.pinned && !i.hidden && !autoIds.has(String(i.id)) && ['closed', 'asana', 'quiet', 'ended', 'won_old'].includes(why[String(i.id)])).map((i) => String(i.id));
}

async function copyPicture(store, url, objectPath, opts) {
  const res = await FL.get(url, opts);
  const type = FL.sniff(res.buf);
  if (!type) throw new Error('not a picture');
  const at = await store.publicAssetPut(`${objectPath}.${EXT[type]}`, res.buf, type);
  return `${at}?v=${Date.now().toString(36)}`;
}

async function refreshTeam(store, { team, bio, now = Date.now(), deadline = Infinity, force = false, fetchImpl, lookup, log = () => {} }) {
  const opts = { ...(fetchImpl ? { fetchImpl } : {}), ...(lookup ? { lookup } : {}) };
  const out = { team: team.id, pages: 0, titles: 0, pictures: 0, grid: 0, removed: 0, failed: 0 };
  const L = await B.load(store, { team, bio, now });
  const left = () => Date.now() < deadline;

  // L1: petitions on the page or in the list (not removed ones).
  const items = (L.all || []).filter((i) => i.petition_id && i.why !== 'removed');
  const byPid = new Map();
  for (const i of items) if (!byPid.has(String(i.petition_id))) byPid.set(String(i.petition_id), i);
  const todo = [...byPid.values()].filter((i) => force || due(L.status[String(i.petition_id)], now));
  const fb = todo.length && store.fbPicturesForPetitions ? await store.fbPicturesForPetitions({ ids: todo.map((i) => i.petition_id) }).catch(() => []) : [];
  for (const i of todo) {
    if (!left()) break;
    const pid = String(i.petition_id), st = L.status[pid] || {};
    const row = { petition_id: pid, page_checked_at: new Date(now).toISOString() };
    let page = { title: null, image: null };
    if (/^\d+$/.test(pid)) {
      try {
        const r = await FL.get(SITE_API + pid, opts);
        const site = readSite(r.buf.toString('utf8'));
        if (site) {
          page = site; out.pages++;
          if (site.count) row.site_total = site.count;
          if (site.own) row.site_count = site.own;
          if (site.share) row.share_url = site.share;
        }
      } catch (e) { out.failed++; log(`site ${pid}: ${e.message}`); }
    }
    if (page.title) { row.page_title = page.title; row.page_title_src = 'page'; if (page.title !== st.page_title) out.titles++; }
    else if (!st.page_title || st.page_title_src === 'post') {
      // No title on the page: the first line of our newest post about it,
      // which the desk shows as one to check.
      const ig = L.media && L.igPostOf && L.media[L.igPostOf[pid]];
      const t = (fb.filter((f) => f.petition_id === pid && f.message && !(f.petitions > 1)).map((f) => B.titleFromText(f.message)).find(Boolean)) || (ig && B.titleFromText(ig.caption));
      if (t) { row.page_title = t; row.page_title_src = 'post'; if (t !== st.page_title) out.titles++; }
      else if (st.page_title) { row.page_title = null; row.page_title_src = null; }
    }
    // The picture: the page's, else our newest Facebook post's, else our
    // Instagram post's. Copied again only when its source changes or after
    // a week.
    const fbPic = fb.find((f) => f.petition_id === pid && f.picture && B.freshImage(f.picture, now));
    const ig = L.media && L.igPostOf && L.media[L.igPostOf[pid]];
    const cands = [page.image && { src: 'page', url: page.image }, fbPic && { src: 'fb', url: fbPic.picture }, ig && B.freshImage(ig.thumbnail_url, now) && { src: 'ig', url: ig.thumbnail_url }].filter(Boolean);
    // Copied again only when the picture itself changes.
    const stale = !st.page_image || !cands.length || st.page_image_from !== cands[0].url;
    if (stale) {
      for (const c of cands) {
        if (st.page_image && st.page_image_from === c.url) break;
        try { row.page_image = await copyPicture(store, c.url, `bio/petitions/${pid}`, opts); row.page_image_src = c.src; row.page_image_from = c.url; out.pictures++; break; }
        catch (e) { out.failed++; log(`picture ${pid} (${c.src}): ${e.message}`); }
      }
    }
    try { await store.petitionPagesSet([row]); } catch (e) { out.failed++; log(`save ${pid}: ${e.message}`); }
  }

  // L4: kept copies of the grid pictures (and the Instagram posts the
  // petitions' pictures may come from).
  const want = new Map();
  for (const m of (L.grid || []).slice(0, B.GRID_MAX)) want.set(String(m.media_id), m);
  for (const id of Object.values(L.igPostOf || {})) if (L.media && L.media[id]) want.set(String(id), L.media[id]);
  for (const m of want.values()) {
    if (!left()) break;
    if (m.image_copy || !B.freshImage(m.thumbnail_url, now)) continue;
    try { await store.igImageCopySet(m.media_id, await copyPicture(store, m.thumbnail_url, `bio/ig/${m.media_id}`, opts)); out.grid++; }
    catch (e) { out.failed++; log(`grid ${m.media_id}: ${e.message}`); }
  }

  // L3: tidy the saved list.
  const drop = new Set(staleSaved(bio, L));
  if (drop.size && store.engineSaveBio) {
    const items2 = bio.items.filter((i) => !drop.has(String(i.id)));
    try {
      await store.engineSaveBio({ team_id: team.id, slug: bio.slug, title: bio.title, intro: bio.intro || '', auto: bio.auto !== false, settings: bio.settings || {}, items: items2, updated_at: bio.updated_at || new Date(now).toISOString(), updated_by: bio.updated_by || 'auto' });
      out.removed = drop.size;
    } catch (e) { out.failed++; log(`tidy: ${e.message}`); }
  }
  return out;
}

// Every saved page, or one team's.
async function refresh(store, { team: only = null, now = Date.now(), budgetMs = 240000, force = false, fetchImpl, lookup, log = () => {} } = {}) {
  const deadline = Date.now() + budgetMs;
  const teams = (await store.engineTeams()) || [];
  const bios = (await store.engineBios()) || [];
  const runs = [];
  for (const b of bios) {
    if (only && b.team_id !== only) continue;
    if (Date.now() >= deadline) break;
    const team = teams.find((t) => t.id === b.team_id);
    const bio = team && await store.engineBio({ team_id: team.id });
    if (!bio) continue;
    try { runs.push(await refreshTeam(store, { team, bio, now, deadline, force, fetchImpl, lookup, log })); }
    catch (e) { log(`${b.team_id}: ${e.message}`); runs.push({ team: b.team_id, error: e.message }); }
  }
  const summary = { at: new Date().toISOString(), runs };
  // The desk shows when each page last refreshed and what it found.
  if (store.engineCacheSet) for (const r of runs) await store.engineCacheSet(`bio:refresh:${r.team}`, { at: summary.at, ...r }).catch(() => null);
  return summary;
}

module.exports = { refresh, refreshTeam, readPage, readSite, shareUrl, due, staleSaved, SITE_API };
