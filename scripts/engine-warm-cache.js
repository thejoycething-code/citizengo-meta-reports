#!/usr/bin/env node
'use strict';
// Nightly on the Mini, after the Looker signatures pull (scripts/link-signatures-mini.sh):
// works out the Analytics and Listening views the desk opens, from the data
// already collected, and keeps them in engine_cache, so nobody waits for them.
// Each call is exactly what the desk sends, so the keys match.
//
//   node scripts/engine-warm-cache.js            (reads .env in this checkout)
const { loadEnv } = require('../lib/graph');
const { supabaseStore } = require('../lib/store');

async function main() {
  loadEnv();
  // A maintainer identity for this job only: it sees every team, writes nothing but the cache.
  process.env.ENGINE_ADMINS = [process.env.ENGINE_ADMINS, 'engine-warm'].filter(Boolean).join(',');
  const { ENGINE_TOOLS } = require('../mcp/engine-tools');
  const store = supabaseStore({ url: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_KEY });
  const tool = (name) => ENGINE_TOOLS.find((t) => t.name === name).handler;
  const teams = (await store.engineTeams()).map((t) => t.id);
  const jobs = [];
  for (const days of [7, 30, 90]) {
    for (const scope of ['citizengo', 'hazteoir']) jobs.push(['engine_analytics', { scope, days }]);
    for (const team of teams) jobs.push(['engine_analytics', { scope: 'team', team, days }]);
  }
  for (const team of teams) {
    jobs.push(['engine_listening', { tab: 'citizengo', team }]); // Listening tab and Topics
    jobs.push(['engine_listening', { tab: 'citizengo', team, days: 7, min_multiple: 10 }]); // Digest
  }
  jobs.push(['engine_listening', { tab: 'allies', team: teams[0], country: 'UK' }]); // Listening tab
  jobs.push(['engine_listening', { tab: 'allies', team: teams[0] }]); // Topics
  jobs.push(['engine_listening', { tab: 'allies', days: 10, min_multiple: 3 }]); // Digest
  jobs.push(['engine_listening', { tab: 'opponents', team: teams[0] }]);
  jobs.push(['engine_listening', { tab: 'opponents', days: 7, min_multiple: 5 }]);
  let ok = 0; const failed = [];
  const t0 = Date.now();
  for (const [name, args] of jobs) {
    try { await tool(name)(store, { ...args, fresh: true }, { who: 'engine-warm' }); ok++; }
    catch (e) { failed.push(`${name} ${JSON.stringify(args)}: ${e.message}`); }
  }
  console.log(`${new Date().toISOString()} cache warmed: ${ok} of ${jobs.length} views in ${Math.round((Date.now() - t0) / 1000)} s${failed.length ? `; failed: ${failed.join(' | ')}` : ''}`);
  if (failed.length) process.exitCode = 1;
}
main().catch((e) => { console.error(e.message); process.exit(1); });
