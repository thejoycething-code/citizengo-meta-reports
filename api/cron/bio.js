'use strict';
// Link in bio refresh (Vercel Cron, every 3 hours) [12 Nov 2026]: petition
// titles and kept pictures, kept copies of the Instagram grid, and a tidy
// saved list, for every saved page (lib/bio-refresh.js). Vercel calls it
// with "Authorization: Bearer <CRON_SECRET>".

const { supabaseStore } = require('../../lib/store');
const { refresh } = require('../../lib/bio-refresh');

module.exports = async (req, res) => {
  const send = (status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body)); };
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return send(401, { error: 'not allowed' });
  const store = supabaseStore({ url: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_KEY });
  const lines = [];
  try {
    const r = await refresh(store, { budgetMs: 100000, log: (l) => lines.push(l) });
    console.log(`bio refresh: ${JSON.stringify(r.runs)}${lines.length ? '\n' + lines.join('\n') : ''}`);
    return send(200, { ok: true, runs: r.runs });
  } catch (e) {
    console.error(`bio refresh failed: ${e.message}`);
    return send(500, { ok: false, error: e.message });
  }
};
