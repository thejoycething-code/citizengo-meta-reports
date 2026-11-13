'use strict';
// Link in bio, public [Phase 3, 2 Nov 2026]: no sign-in.
//
//   GET /links                      the global link: sends a visitor to their
//                                   country's page (Vercel's country header),
//                                   else the global page, else a picker
//                                   (?pick=1 always shows the picker)
//   GET /links/<slug>               the team's page; ?s=ig|x|fb|tt|qr|wa says
//                                   where the visitor came from (counted, no
//                                   cookies)
//   GET /links/<slug>/go/<button>   counts a click, then sends the visitor on
//   GET /links/<slug>/p/<petition> one petition's share card (link preview)
//   GET /links/<slug>/qr.svg        the page's QR code (address with ?s=qr)
//
// On go.citizengo.org (once CitizenGO IT points it here), / and /<slug> do
// the same (vercel.json). The page shows only button titles, public petition
// links, our own Instagram images and petition totals. A petition button
// goes out as a Campaign Copilot link marked BIO (lib/bio.js destination),
// so signatures from the bio are attributed in Looker.

const B = require('../lib/bio');
const R = require('../lib/bio-refresh');
const QR = require('../lib/qr');
const { supabaseStore } = require('../lib/store');

let store = null;
let live = {}; // tests swap in a fake web
const getStore = () => (store = store || supabaseStore({ url: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_KEY }));

function send(res, status, body, headers = {}) {
  res.statusCode = status;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(body);
}
const notFound = (res) => send(res, 404, '<!doctype html><meta charset="utf-8"><title>Not found</title><p style="font:16px system-ui;text-align:center;margin-top:20vh">This page isn\'t here. <a href="https://citizengo.org">citizengo.org</a></p>', { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60' });
const HTML = { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' };
const CSP = `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https:; script-src '${B.COPY_HASH}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
// Link previewers and crawlers load the page too; they are not visitors.
const BOT = /bot|crawl|spider|preview|facebookexternalhit|whatsapp|telegram|slack|discord|embedly|vercel|headless|curl|wget|python|node-fetch/i;

function originOf(req) {
  const host = String((req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '').split(',')[0].trim();
  return /^[a-z0-9.-]+(:\d+)?$/i.test(host) ? `https://${host}` : '';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '', { Allow: 'GET, HEAD' });
  const q = new URL(req.url, 'http://x').searchParams;
  const src = B.SOURCES[q.get('s')] ? q.get('s') : null;
  const slug = String(q.get('slug') || '').toLowerCase();
  const headers = req.headers || {};
  const human = req.method === 'GET' && !BOT.test(String(headers['user-agent'] || ''));
  try {
    const s = getStore();
    if (!slug) {
      const bios = await s.engineBios().catch(() => []);
      const to = q.get('pick') ? null : B.routeCountry(headers['x-vercel-ip-country'], bios);
      if (to) return send(res, 302, '', { Location: `/links/${to}${src ? `?s=${src}` : ''}`, 'Cache-Control': 'private, no-store', Vary: 'X-Vercel-IP-Country' });
      const teams = (await s.engineTeams()) || [];
      const pages = bios.filter((b) => b.team_id !== 'global').map((b) => { const t = teams.find((x) => x.id === b.team_id) || {}; return { slug: b.slug, name: t.name || b.title, code: String(b.team_id).toUpperCase().slice(0, 3) }; });
      return send(res, 200, req.method === 'HEAD' ? '' : B.pickerHtml({ pages }), { ...HTML, 'Cache-Control': 'public, max-age=300', 'Content-Security-Policy': CSP });
    }
    if (!B.SLUG.test(slug)) return notFound(res);
    const bio = await s.engineBio({ slug });
    if (!bio) return notFound(res);
    const origin = originOf(req);
    if (q.get('qr')) {
      const svg = QR.svg(`${origin}/links/${slug}?s=qr`);
      return send(res, 200, req.method === 'HEAD' ? '' : svg, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600', 'Content-Disposition': `inline; filename="link-in-bio-${slug}.svg"`, 'X-Content-Type-Options': 'nosniff' });
    }
    const team = ((await s.engineTeams()) || []).find((t) => t.id === bio.team_id);
    if (!team) return notFound(res);
    const L = await B.load(s, { team, bio });
    // Up-to-date totals for what this view shows [13 Nov 2026]: a quick look
    // at citizengo.org when a total is over 10 minutes old.
    if (q.get('go') == null && !(q.get('p') != null && human)) {
      const ids = q.get('p') != null ? [q.get('p')] : L.shown.filter((i) => i.petition_id && !i.won).map((i) => i.petition_id);
      await R.liveTotals(s, L.status, ids, live).catch(() => null);
    }
    // A petition's share card [5a]: previews get its picture and total,
    // people go straight on to sign (counted as a click).
    const card = q.get('p');
    if (card != null) {
      const item = /^\d{1,9}$/.test(card) ? L.shown.find((i) => String(i.petition_id) === card) : null;
      if (!item) return send(res, 302, '', { Location: `/links/${slug}`, 'Cache-Control': 'no-store' });
      if (human) return send(res, 302, '', { Location: `/links/${slug}/go/${encodeURIComponent(item.id)}`, 'Cache-Control': 'no-store' });
      return send(res, 200, req.method === 'HEAD' ? '' : B.cardHtml({ bio, item, status: L.status, logo: B.logoOf(bio), origin }), { ...HTML, 'Cache-Control': 'public, max-age=600', 'Content-Security-Policy': CSP });
    }
    const go = q.get('go');
    if (go != null) {
      const item = L.shown.find((i) => i.id === go);
      if (!item) return send(res, 302, '', { Location: `/links/${slug}`, 'Cache-Control': 'no-store' });
      const auto = L.auto.find((a) => a.id === item.id);
      const auth = await s.engineCopilotAuth().catch(() => null);
      const [to] = await Promise.all([
        B.destination(s, { ...item, last_posted: auto && auto.last_posted }, { owner: (auth && auth.owner) || 'CJO' }),
        human ? s.engineBioClick(slug, item.id).catch(() => null) : null,
      ]);
      return send(res, 302, '', { Location: to, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer-when-downgrade' });
    }
    // Awaited: a serverless function may stop once the page is sent.
    if (human) await s.engineBioClick(slug, src ? `_v:${src}` : '_v').catch(() => null);
    const qs = src ? `?s=${src}` : '';
    // Every grid picture opens its post on Instagram [12 Nov 2026, Chris].
    const grid = L.tiles.map((t) => ({ img: t.img, label: t.label, href: t.permalink || (t.item_id ? `${origin}/links/${slug}/go/${encodeURIComponent(t.item_id)}${qs}` : null) })).filter((t) => t.href);
    const html = B.pageHtml({ bio, items: L.shown, hero: L.hero, heroWhy: L.heroWhy, grid, socials: L.socials, status: L.status, logo: B.logoOf(bio), origin, src, today: L.today });
    return send(res, 200, req.method === 'HEAD' ? '' : html, {
      ...HTML,
      // Views are counted on the server, so the page itself is not cached
      // by the CDN; the data behind it is light.
      'Cache-Control': 'private, max-age=60',
      'Content-Security-Policy': CSP,
    });
  } catch (e) {
    console.error('bio failed:', e && e.message);
    return send(res, 503, '<!doctype html><meta charset="utf-8"><title>Try again</title><p style="font:16px system-ui;text-align:center;margin-top:20vh">Please try again in a moment. <a href="https://citizengo.org">citizengo.org</a></p>', { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  }
};
module.exports._setStore = (s) => { store = s; };
module.exports._setLive = (o) => { live = o || {}; };
