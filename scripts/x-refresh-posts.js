#!/usr/bin/env node
'use strict';
// One-off re-read of stored X posts, to fill the post-level fields added on
// 2 Oct 2026 (full text of long posts, topics, tags, video files...) on posts
// the nightly schedule will never read again (past their day-85 checkpoint).
//
//   node scripts/x-refresh-posts.js [--accounts CitizenGO,CitizenGO_GB] [--min-chars 220] [--max-usd 25] [--dry-run]
//
// Candidates are posts not yet re-read (is_long_post is null) whose text looks
// cut: at least --min-chars characters once links are removed, and ending in a
// t.co link, which is how X ends the 280-character cut of a long post (all six
// long posts in fixtures/x-2026-10-02-fields-probe.json end that way).
//
// It writes x_posts ONLY. A fresh read of a post older than ~89 days comes back
// without private metrics; written as a snapshot it would become the post's
// latest and blank the link clicks we hold. So no x_post_metrics row is
// written, and the run is logged in x_collection_runs so the spend counts
// against the monthly cap.

const { loadEnv } = require('../lib/graph');
loadEnv();
const xapi = require('../lib/xapi');
const sched = require('../lib/xschedule');
const { supabaseSink } = require('../collector/lib/sinks');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf('--' + k); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const ONLY = arg('accounts', '') ? arg('accounts', '').split(',').map((s) => s.trim().toLowerCase()) : null;
const MIN_CHARS = Number(arg('min-chars', 220));
const MAX_USD = Number(arg('max-usd', 25));
const DRY = args.includes('--dry-run');
const OWNER = String(process.env.X_APP_OWNER_ID || '').trim();

const url = process.env.SUPABASE_URL; const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) { console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required'); process.exit(2); }
const H = { apikey: key, Authorization: `Bearer ${key}` };

const looksCut = (t) => {
  const s = String(t || '');
  return /https:\/\/t\.co\/\S+\s*$/.test(s) && s.replace(/https:\/\/t\.co\/\S+/g, '').trim().length >= MIN_CHARS;
};

async function candidates(accountId) {
  const out = [];
  for (let off = 0; ; off += 1000) {
    const r = await fetch(`${url}/rest/v1/x_posts?select=post_id,text&account_id=eq.${accountId}&is_long_post=is.null&order=post_id.asc&limit=1000&offset=${off}`, { headers: H });
    if (!r.ok) throw new Error(`x_posts read failed: HTTP ${r.status}`);
    const rows = await r.json();
    for (const p of rows) if (looksCut(p.text)) out.push(p.post_id);
    if (rows.length < 1000) return out;
  }
}

async function main() {
  const { loadAccounts, accessTokenFor, toRows } = require('../collector/x');
  const accounts = (await loadAccounts()).filter((a) => !a.inline && a.is_active !== false)
    .filter((a) => !ONLY || ONLY.includes(String(a.username).toLowerCase()) || ONLY.includes(String(a.label || '').toLowerCase()));
  const sink = supabaseSink({ url, serviceKey: key });
  const runId = `xrefresh-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`;
  let spent = 0;

  // Plan first, so the cost is known before anything is read.
  const plan = [];
  for (const a of accounts) {
    const ids = await candidates(a.account_id);
    const owned = Boolean(OWNER) && String(a.account_id) === OWNER;
    plan.push({ a, ids, owned, est: sched.estimateCost({ postReads: ids.length, userReads: 0, owned }) });
  }
  const total = plan.reduce((t, x) => t + x.est, 0);
  for (const x of plan) console.log(`  @${x.a.username}: ${x.ids.length} posts, est $${x.est.toFixed(2)}`);
  console.log(`Plan: ${plan.reduce((t, x) => t + x.ids.length, 0)} posts, est $${total.toFixed(2)} (cap for this run $${MAX_USD})`);
  if (DRY) return;
  if (total > MAX_USD) { console.error(`Estimated $${total.toFixed(2)} is over --max-usd ${MAX_USD}; nothing read.`); process.exit(1); }

  for (const { a, ids, owned } of plan) {
    if (!ids.length) continue;
    const started = new Date().toISOString();
    const cred = await accessTokenFor(a, () => {});
    if (cred.error) { console.log(`  @${a.username}: token failed: ${cred.error}`); continue; }
    const client = xapi.makeClient({ token: cred.token });
    let written = 0; let missing = 0; let failed = 0;
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const res = await client.postsByIds(chunk, { privateWindow: false });
      if (!res.ok) { failed += chunk.length; console.log(`  @${a.username}: HTTP ${res.status} ${res.detail || res.title || ''}`); continue; }
      const data = (res.body && res.body.data) || [];
      missing += chunk.length - data.length;   // deleted or protected since: left as stored
      const rows = data.map((post) => toRows(post, { account: a, username: a.username, includes: res.body.includes,
        errors: res.errors, privateWindow: false, now: new Date() }).post);
      if (rows.length) { await sink.upsert('x_posts', rows); written += rows.length; }
    }
    const cost = sched.estimateCost({ postReads: client.tally.postReads, userReads: client.tally.userReads, owned });
    spent += cost;
    await sink.upsert('x_collection_runs', [{
      run_id: runId, account_id: a.account_id, started_at: started, finished_at: new Date().toISOString(),
      status: failed ? 'partial' : 'ok', posts_seen: written, metrics_written: 0, api_calls: client.tally.calls,
      post_reads: client.tally.postReads, user_reads: client.tally.userReads, est_cost_usd: Number(cost.toFixed(4)),
      error_code: null, error_message: failed ? `${failed} posts in failed requests` : null,
    }]);
    console.log(`  @${a.username}: ${written} posts updated, ${missing} no longer on X, ${failed} failed · $${cost.toFixed(2)}`);
  }
  console.log(`Done: est $${spent.toFixed(2)} (run ${runId}; no metric snapshots written).`);
}

main().catch((e) => { console.error(e.stack); process.exit(1); });
