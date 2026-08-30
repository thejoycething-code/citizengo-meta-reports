#!/usr/bin/env node
'use strict';
// Watchdog. Answers one question: is the data still arriving?
//
// This exists SEPARATELY from the collector for a reason learned the hard way -
// on 27 and 28 August 2026 the nightly run did not happen at all, and nothing
// said so. An alert built into the collector cannot fire when the collector is
// what failed to run. So this reads only the database and knows nothing about
// Meta, tokens or GitHub.
//
// Exits non-zero when data is stale, so CI fails loudly, and posts to
// ALERT_WEBHOOK_URL if one is configured.
//
// Usage: node scripts/check-freshness.js [--max-age-days 2]

const { loadEnv } = require('../lib/graph');
const { supabaseStore } = require('../lib/store');

loadEnv();

const args = process.argv.slice(2);
const i = args.indexOf('--max-age-days');
const MAX_AGE = i !== -1 && args[i + 1] ? Number(args[i + 1]) : 2;
// Sends a test message and exits. Without this the only way to prove the
// alerting works is to wait for a real outage - and an untested alert is
// indistinguishable from no alert.
const TEST_ONLY = args.includes('--test-alert');

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_MCP_KEY;

async function alert(text) {
  const hook = process.env.ALERT_WEBHOOK_URL;
  if (!hook) return;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    await fetch(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // No figures in the message - only whether collection is running. It may
      // go to a channel wider than the people who should see performance data.
      body: JSON.stringify({ text }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
  } catch (e) {
    console.error('alert webhook failed:', e.message);
  }
}

async function main() {
  if (TEST_ONLY) {
    if (!process.env.ALERT_WEBHOOK_URL) {
      console.error('ALERT_WEBHOOK_URL is not set, so there is nothing to test.');
      process.exit(2);
    }
    const msg = 'CitizenGO organic reporting: this is a TEST alert. '
      + 'Alerting is wired up correctly. Real alerts only fire when collection stops.';
    await alert(msg);
    console.log('Test alert sent. If it did not arrive, the webhook URL is wrong or the channel is not accepting posts.');
    return;
  }

  if (!URL_ || !KEY) {
    console.error('SUPABASE_URL and a Supabase key are required.');
    process.exit(2);
  }
  const store = supabaseStore({ url: URL_, serviceKey: KEY });

  const f = await store.freshness();
  const now = new Date();

  if (!f.latest) {
    const msg = 'CitizenGO organic reporting: no data has ever been collected.';
    console.error(msg);
    await alert(msg);
    process.exit(1);
  }

  const ageDays = Math.floor((now.getTime() - new Date(f.latest + 'T00:00:00Z').getTime()) / 86400000);
  console.log(`Most recent collection: ${f.latest} (${ageDays} day${ageDays === 1 ? '' : 's'} ago)`);

  // Per-page detail, so the alert can say WHICH pages went quiet rather than
  // only that something is wrong.
  const pages = await store.loadAll().then((d) => d.pages).catch(() => []);
  console.log(`Pages configured: ${pages.length}`);

  // >= not >, so the threshold means what it says. With nightly collection,
  // 1 day is normal (today's run may not have fired yet) and 2 means two
  // consecutive misses. A strict > let exactly that case pass as "fresh", and
  // disagreed with the banner the MCP tools show, which used <.
  // COMPLETENESS. Every aggregate this project produces was once computed on
  // 1000 of 2237 posts, because PostgREST silently caps responses at
  // db-max-rows and ignores a larger limit in the query string. It was found by
  // accident. This compares what the tools actually receive against an
  // independent exact count, so the same class of bug fails loudly instead.
  const mismatches = [];
  try {
    const [exact, loaded] = await Promise.all([store.counts(), store.loadAll()]);
    const got = {
      meta_pages: loaded.pages.length,
      meta_posts: loaded.posts.length,
      meta_post_metrics: loaded.metrics.length,
    };
    for (const [table, expected] of Object.entries(exact)) {
      if (expected === null) continue;              // count unavailable, not a mismatch
      if (got[table] !== expected) {
        mismatches.push(`${table}: tools see ${got[table]} of ${expected}`);
      }
    }
    console.log('Completeness: '
      + Object.entries(exact).map(([t, n]) => `${t.replace('meta_', '')} ${got[t]}/${n}`).join(', '));
  } catch (e) {
    mismatches.push(`completeness check failed: ${e.message}`);
  }

  if (mismatches.length) {
    const msg = 'CitizenGO organic reporting is reading INCOMPLETE data — '
      + mismatches.join('; ')
      + '. Every figure the tool reports is understated until this is fixed.';
    console.error(`::error::${msg}`);
    await alert(msg);
    process.exit(1);
  }

  // COVERAGE. Freshness and completeness both pass happily while the estate
  // shrinks: if a token is replaced with one granting fewer Pages, the pages it
  // still reaches keep collecting on time and in full, so nothing looks wrong.
  // On 29 Aug 2026 the token in the secret was swapped for one reaching 14 pages
  // instead of 36 and every existing check stayed green.
  //
  // Compares the most recent run against the best run in the last 30 days rather
  // than an absolute number, so it needs no hardcoded page count and survives
  // pages being legitimately added or removed.
  try {
    const runs = await store.pageCoverage ? await store.pageCoverage() : null;
    if (runs && runs.latest !== null && runs.best) {
      const dropped = runs.best - runs.latest;
      const pct = Math.round((100 * dropped) / runs.best);
      console.log(`Coverage: ${runs.latest} page(s) across the last 3 runs, best recent ${runs.best}`);
      if (pct >= 10) {
        const msg = `CitizenGO organic reporting is collecting FEWER PAGES than it was: `
          + `${runs.latest} across the last three runs against ${runs.best} recently — ${dropped} pages `
          + `(${pct}%) have stopped. The data still looks current because the remaining pages `
          + `collect normally. Most often the META_TOKENS secret was replaced with a token `
          + `granting fewer Pages.`;
        console.error(`::error::${msg}`);
        await alert(msg);
        process.exit(1);
      }
    }
  } catch (e) {
    console.log(`Coverage check skipped: ${e.message}`);
  }

  // Housekeeping, not a check: trim the brute-force audit log. Done here because
  // the watchdog is the daily job that is guaranteed to run and already holds the
  // credentials. Never allowed to fail the run - a full disk is a problem, but a
  // failed tidy-up is not a reason to report the pipeline as broken.
  if (typeof store.pruneAuthFailures === 'function') {
    try {
      const removed = await store.pruneAuthFailures(1);
      if (removed) console.log(`Pruned ${removed} expired auth-failure row(s).`);
    } catch (e) {
      console.error(`Auth-failure prune skipped: ${e.message}`);
    }
  }

  if (ageDays >= MAX_AGE) {
    const msg = `CitizenGO organic reporting has stopped. Last collection was ${f.latest}, `
      + `${ageDays} days ago. Most likely an expired Facebook token or a failed nightly run. `
      + 'Check the Actions tab.';
    console.error(`::error::${msg}`);
    await alert(msg);
    process.exit(1);
  }

  console.log(`Fresh: under the ${MAX_AGE}-day threshold. Nothing to report.`);
}

main().catch((e) => {
  console.error('freshness check failed:', e.message);
  // A watchdog that cannot run must be loud, not silent.
  alert(`CitizenGO organic reporting: the freshness check itself failed — ${e.message}`)
    .finally(() => process.exit(1));
});
