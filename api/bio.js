'use strict';
// Link in bio, public [Phase 3, 2 Nov 2026]: no sign-in.
//
//   GET /links/<slug>               the team's page (rewritten to /api/bio?slug=)
//   GET /links/<slug>/go/<button>   counts a click, then sends the visitor on
//                                   (rewritten to /api/bio?slug=&go=)
//
// The page shows only button titles and public petition links. A petition
// button goes out as a Campaign Copilot link marked BIO (lib/bio.js
// destination), so signatures from the bio are attributed in Looker.

const B = require('../lib/bio');
const { supabaseStore } = require('../lib/store');

let store = null;
const getStore = () => (store = store || supabaseStore({ url: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_KEY }));

function send(res, status, body, headers = {}) {
  res.statusCode = status;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(body);
}
const notFound = (res) => send(res, 404, '<!doctype html><meta charset="utf-8"><title>Not found</title><p style="font:16px system-ui;text-align:center;margin-top:20vh">This page isn\'t here. <a href="https://citizengo.org">citizengo.org</a></p>', { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60' });

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '', { Allow: 'GET, HEAD' });
  const q = new URL(req.url, 'http://x').searchParams;
  const slug = String(q.get('slug') || '').toLowerCase();
  if (!B.SLUG.test(slug)) return notFound(res);
  try {
    const s = getStore();
    const bio = await s.engineBio({ slug });
    if (!bio) return notFound(res);
    const team = ((await s.engineTeams()) || []).find((t) => t.id === bio.team_id);
    if (!team) return notFound(res);
    const L = await B.load(s, { team, bio });
    const go = q.get('go');
    if (go != null) {
      const item = L.shown.find((i) => i.id === go);
      if (!item) return send(res, 302, '', { Location: `/links/${slug}`, 'Cache-Control': 'no-store' });
      const auto = L.auto.find((a) => a.id === item.id);
      const auth = await s.engineCopilotAuth().catch(() => null);
      const [to] = await Promise.all([
        B.destination(s, { ...item, last_posted: auto && auto.last_posted }, { owner: (auth && auth.owner) || 'CJO' }),
        req.method === 'GET' ? s.engineBioClick(slug, item.id).catch(() => null) : null,
      ]);
      return send(res, 302, '', { Location: to, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer-when-downgrade' });
    }
    return send(res, 200, req.method === 'HEAD' ? '' : B.pageHtml({ bio, items: L.shown }), {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
    });
  } catch (e) {
    console.error('bio failed:', e && e.message);
    return send(res, 503, '<!doctype html><meta charset="utf-8"><title>Try again</title><p style="font:16px system-ui;text-align:center;margin-top:20vh">Please try again in a moment. <a href="https://citizengo.org">citizengo.org</a></p>', { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  }
};
module.exports._setStore = (s) => { store = s; };
