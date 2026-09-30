#!/usr/bin/env node
'use strict';
// Watchdog step for the X source. Three questions, and the third is the one
// Meta never needed:
//
//   1. Is X data still arriving?          (stale after --max-age-days, default 2)
//   2. Does any account need re-authorising?   (X revoked or rotated away a token)
//   3. How much of this month's budget is spent?  (warn at 80%, fail at 100%)
//
// SILENT until the source exists: when the x_* tables are absent or no account
// has authorised, it prints one line and exits 0. That is what lets it be wired
// into watchdog.yml ahead of go-live without a daily false alarm.
//
// The 30-day window makes staleness worse here than on Meta: two missed days
// on Meta are re-collected tomorrow; two missed days on X at day 28 lose that
// cohort's final private metrics for good. Hence the same 2-day threshold but
// firmer wording.

const { loadEnv } = require('../lib/graph');
const { supabaseStore } = require('../lib/store');
const sched = require('../lib/xschedule');

loadEnv();

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf('--' + n); return i !== -1 && args[i + 1] ? Number(args[i + 1]) : d; };
const MAX_AGE = argVal('max-age-days', 2);
const WARN_AT = argVal('warn-budget-pct', 80);

async function main() {
  const url = process.env.SUPABASE_URL; const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) { console.log('X health: SUPABASE_URL / SUPABASE_SERVICE_KEY not set - skipped.'); return; }
  const store = supabaseStore({ url, serviceKey: key });

  const accounts = await store.xAccounts();
  if (!accounts.length) { console.log('X health: no X accounts connected (source not live) - nothing to check.'); return; }

  const [fresh, spend] = await Promise.all([store.xFreshness(), store.xSpend()]);
  const problems = []; const warnings = [];

  console.log(`X health · ${accounts.length} account(s)\n`);

  // 1. Freshness
  if (!fresh.latest) {
    problems.push('Accounts are connected but NO X data has ever been collected.');
  } else {
    const age = Math.floor((Date.now() - new Date(fresh.latest + 'T00:00:00Z').getTime()) / 86_400_000);
    console.log(`  latest collection  ${fresh.latest}  (${age} day(s) ago)`);
    if (age > MAX_AGE) {
      problems.push(`X collection has stopped: last data is ${age} days old. Checkpoint reads catch up once it restarts, but posts that pass day ${sched.OBSERVED_PRIVATE_DAYS} meanwhile lose their final link and profile clicks for good.`);
    }
  }
  if (fresh.recentFailures) console.log(`  failed runs        ${fresh.recentFailures} in the recent ledger`);

  // 2. Credentials
  const needs = accounts.filter((a) => a.credential_status !== 'live' && a.credential_status !== 'live (last refresh errored)');
  const shaky = accounts.filter((a) => a.credential_status === 'live (last refresh errored)');
  for (const a of accounts) console.log(`  @${String(a.username).padEnd(22)} ${a.kind.padEnd(13)} ${a.credential_status}`);
  if (needs.length) {
    problems.push(`${needs.length} account(s) need re-authorisation and are not being collected: ${needs.map((a) => '@' + a.username).join(', ')}. Mint a new invite with npm run x:invite.`);
  }
  if (shaky.length) warnings.push(`${shaky.length} account(s) had a refresh error on the last run: ${shaky.map((a) => '@' + a.username).join(', ')}.`);

  // 2b. Has X tightened the private-metric window? The day-60 and day-85
  // checkpoints exist only because X served private metrics to ~89 days on
  // 30 Sep 2026, against a documented 30. If reads of posts aged 31-89 stop
  // returning them, those checkpoints are buying public metrics only, and the
  // schedule should drop them. A warning, not a failure: collection still works.
  try {
    const since = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const base = String(url).trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
    const r = await fetch(`${base}/rest/v1/x_post_metrics?select=private_window_open`
      + `&collected_at=gte.${encodeURIComponent(since)}&post_age_days=gt.${sched.PRIVATE_WINDOW_DAYS + 1}`
      + `&post_age_days=lte.${sched.OBSERVED_PRIVATE_DAYS}&limit=1000`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    const rows = r.ok ? await r.json() : [];
    const late = Array.isArray(rows) ? rows : [];
    const got = late.filter((x) => x.private_window_open).length;
    console.log(`\n  late reads (31-${sched.OBSERVED_PRIVATE_DAYS}d, last 3 days)  ${got} of ${late.length} returned private metrics`);
    if (late.length >= 3 && got === 0) {
      warnings.push(`X appears to have tightened its private-metric window: none of the last ${late.length} reads of posts aged 31-${sched.OBSERVED_PRIVATE_DAYS} days returned link or profile clicks. The day-60 and day-85 checkpoints now buy public metrics only; consider removing them from CHECKPOINTS in lib/xschedule.js.`);
    }
  } catch (e) {
    console.log(`  late-read check skipped: ${e.message}`);
  }

  // 3. Budget
  if (spend) {
    const spent = Number(spend.est_cost_usd || 0);
    const pct = spend.budget ? Math.round((spent / spend.budget) * 100) : 0;
    console.log(`\n  spend this month   $${spent.toFixed(2)} of $${spend.budget}  (${pct}%) · ${Number(spend.post_reads || 0).toLocaleString('en-GB')} post reads, ${Number(spend.user_reads || 0).toLocaleString('en-GB')} user reads`);
    if (pct >= 100) problems.push(`X budget spent: est. $${spent.toFixed(2)} of $${spend.budget}. The collector refuses to run until X_MONTHLY_BUDGET_USD is raised or the month rolls over.`);
    else if (pct >= WARN_AT) warnings.push(`X spend is at ${pct}% of the $${spend.budget} monthly budget.`);
    const projected = sched.projectMonthly({ accounts: accounts.length, postsPerDay: 5 });
    console.log(`  for reference      ~$${projected.toFixed(2)}/month at steady state, 5 posts/day/account, `
      + `${sched.READS_PER_POST} reads per post (days 0-7, ${sched.CHECKPOINTS.join(', ')})`);
  }

  if (problems.length) {
    const msg = 'CitizenGO X reporting - PROBLEM. ' + problems.join(' ');
    console.error(`\n::error::${msg}`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  if (warnings.length) {
    for (const w of warnings) console.log(`  NOTE: ${w}`);
    console.log(`::warning::${warnings.join(' ')}`);
    return;
  }
  console.log('\nX source healthy.');
}

main().catch((e) => { console.error(`X health check failed to run: ${e.message}`); process.exit(2); });
