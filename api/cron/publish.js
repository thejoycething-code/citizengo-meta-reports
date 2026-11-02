'use strict';
// Backup publisher (Vercel Cron, every 15 minutes). The Mac Mini publishes
// scheduled posts every 5 minutes; this only steps in for a Facebook or
// Instagram destination that is still not out 10 minutes after its time, so
// a Mini that is off, asleep or offline doesn't stop posts going out. Both
// runners claim a destination before posting, so it can't go out twice.
//
// Vercel calls it with "Authorization: Bearer <CRON_SECRET>". It needs
// ENGINE_TOKEN_PRIVATE_KEY (the key that opens sealed Page tokens) and posts
// for real only when ENGINE_PUBLISH_LIVE=1, like the Mini.

const { supabaseStore } = require('../../lib/store');
const { run } = require('../../collector/publish');

const MIN_LATE_MS = 10 * 60_000;

module.exports = async (req, res) => {
  const send = (status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body)); };
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return send(401, { error: 'not allowed' });
  const store = supabaseStore({ url: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_KEY });
  const privateKey = String(process.env.ENGINE_TOKEN_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!privateKey) {
    try { await store.engineCacheSet('publisher:cloud', { at: new Date().toISOString(), live: false, error: 'ENGINE_TOKEN_PRIVATE_KEY is not set' }); } catch (e) { /* the desk's lateness warning still works */ }
    return send(200, { ok: false, error: 'ENGINE_TOKEN_PRIVATE_KEY is not set: the backup can only watch, not publish' });
  }
  const live = process.env.ENGINE_PUBLISH_LIVE === '1';
  const lines = [];
  try {
    const tally = await run({ store, privateKey, live, runner: 'cloud', minLateMs: MIN_LATE_MS, log: (l) => lines.push(l) });
    console.log(`backup publisher, ${live ? 'LIVE' : 'dry run'}: ${JSON.stringify(tally)}\n${lines.join('\n')}`);
    return send(200, { ok: true, live, tally });
  } catch (e) {
    console.error(`backup publisher failed: ${e.message}`);
    return send(500, { ok: false, error: e.message });
  }
};
