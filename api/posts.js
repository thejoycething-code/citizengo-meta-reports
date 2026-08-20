'use strict';
// Vercel serverless function — the post league table.
// Reads Supabase server-side with the service_role key, which never leaves the
// server. Same pattern as clacton-vercel/api/stats.js.
const { requireSupabaseStore } = require('../lib/store');
const { shapeFeed } = require('../lib/shape');
const checkAuth = require('./_auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  if (!checkAuth(req, res)) return;

  const q = req.query || {};
  try {
    const store = requireSupabaseStore();
    const data = await store.loadAll();
    const out = shapeFeed(data, {
      page_id: q.page_id,
      since: q.since,
      sort: q.sort,
      limit: q.limit || 200,
      with_metrics_only: q.with_metrics_only === '1',
    });
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.status(200).json(out);
  } catch (e) {
    console.error('posts failed', e);
    res.status(e.code === 'CONFIG' ? 500 : 502).json({ error: e.code === 'CONFIG' ? 'server_misconfigured' : 'query_failed' });
  }
};
