#!/usr/bin/env node
'use strict';
// Nightly on the Mini, after the Looker signatures pull (scripts/link-signatures-mini.sh):
// works out the Analytics and Listening views the desk opens (kept in step
// with desk/index.html's calls), from the data
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
  for (const days of [7, 30, 90]) jobs.push(['engine_analytics', { scope: 'countries', days }]);
  for (const days of [7, 30, 90]) jobs.push(['engine_analytics', { scope: 'leaderboard', days }]);
  // Listening: Rising now (per team), Topics (overview + beyond our list),
  // the Allies and Other CitizenGO tabs, and Opponents (7 and 14 days).
  for (const team of teams) {
    jobs.push(['engine_listening', { tab: 'citizengo', team, days: 7, min_multiple: 3 }]);
    jobs.push(['engine_listening', { tab: 'citizengo', team }]);
  }
  jobs.push(['engine_listening', { tab: 'allies', days: 10, min_multiple: 3 }]);
  jobs.push(['engine_listening', { tab: 'opponents', days: 7, min_multiple: 3 }]);
  jobs.push(['engine_listening', { tab: 'allies', team: teams[0], country: 'UK' }]);
  jobs.push(['engine_listening', { tab: 'overview' }]);
  jobs.push(['engine_listening', { tab: 'beyond' }]);
  // Teams that read another language or news edition (México: Spanish, Google News México) have their own Topics.
  const E = require('../lib/engine');
  for (const team of teams.filter((t) => E.teamLang(t) !== 'en' || E.newsEdition(t) !== 'uk')) {
    jobs.push(['engine_listening', { tab: 'overview', team }]);
    jobs.push(['engine_listening', { tab: 'beyond', team }]);
  }
  for (const days of [7, 14]) jobs.push(['engine_listening', { tab: 'opponents_mix', days }]);
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
