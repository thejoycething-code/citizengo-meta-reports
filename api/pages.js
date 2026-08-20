'use strict';
// Vercel serverless function — per-page rollup for the summary cards.
const { requireSupabaseStore } = require('../lib/store');
const { shapePages } = require('../lib/shape');
const checkAuth = require('./_auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  if (!checkAuth(req, res)) return;
  try {
    const store = requireSupabaseStore();
    const data = await store.loadAll();
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.status(200).json({ pages: shapePages(data) });
  } catch (e) {
    console.error('pages failed', e);
    res.status(e.code === 'CONFIG' ? 500 : 502).json({ error: e.code === 'CONFIG' ? 'server_misconfigured' : 'query_failed' });
  }
};
