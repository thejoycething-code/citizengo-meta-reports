#!/usr/bin/env node
'use strict';
// Writes STATUS.md: a git-tracked record of pipeline health.
//
// Its second job is to be the monthly heartbeat commit. GitHub disables
// scheduled workflows after 60 days of repository inactivity, which would
// silently stop both the collector and the digest on a parked project.
//
// Two properties matter for that job:
//   1. It ALWAYS writes a file, even when Supabase is unreachable — a failed
//      read must still produce a commit, or the heartbeat stops exactly when the
//      pipeline is broken and you most need the signal.
//   2. The content always changes (timestamp), so there is always a real diff.
//
// Usage: node scripts/status.js [--out STATUS.md]

const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../lib/graph');
const { supabaseStore } = require('../lib/store');
const { shapeFeed, shapePages, pageBaseline } = require('../lib/shape');

loadEnv();

const args = process.argv.slice(2);
const i = args.indexOf('--out');
const OUT = i !== -1 && args[i + 1] ? args[i + 1] : path.join(__dirname, '..', 'STATUS.md');

const n = (v) => (v === null || v === undefined ? '—' : Math.round(v).toLocaleString('en-GB'));
const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);

function warn(lines, msg) {
  lines.push('');
  lines.push(`> **Attention:** ${msg}`);
}

async function main() {
  const L = ['# Pipeline status', '', `_Checked ${stamp} UTC. Written automatically; do not edit._`, ''];

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    L.push('**Could not check:** Supabase credentials were not available to this run.');
    warn(L, 'This file is also the heartbeat that stops GitHub disabling the scheduled workflows, so it is written even when the check fails.');
    fs.writeFileSync(OUT, L.join('\n') + '\n');
    console.log('STATUS.md written (no credentials)');
    return;
  }

  try {
    const store = supabaseStore({ url: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_KEY });
    const data = await store.loadAll();
    const pages = shapePages(data);
    const feed = shapeFeed(data, {});
    const base = pageBaseline(feed.rows);

    const runs = (data.metrics || []).map((m) => m.collected_date).filter(Boolean).sort();
    const lastCollected = runs.length ? runs[runs.length - 1] : null;
    const daysStale = lastCollected
      ? Math.floor((Date.now() - new Date(lastCollected + 'T00:00:00Z').getTime()) / 86400000)
      : null;

    L.push(`- Pages collected: **${pages.length}**`);
    L.push(`- Posts: **${feed.total}**`);
    L.push(`- Metric rows: **${(data.metrics || []).length}**`);
    L.push(`- Most recent collection: **${lastCollected || 'never'}**${daysStale !== null ? ` (${daysStale} day${daysStale === 1 ? '' : 's'} ago)` : ''}`);
    if (base.reliable) L.push(`- Baseline: median **${n(base.median_views)} views**, ${n(base.median_shares)} shares`);
    L.push('');

    L.push('| Page | Posts | With metrics | Total views |');
    L.push('| --- | --- | --- | --- |');
    for (const p of pages) {
      L.push(`| ${p.name} | ${n(p.posts)} | ${n(p.posts_with_metrics)} | ${n(p.views_total)} |`);
    }

    // The check that actually matters: is collection still happening?
    if (daysStale === null) {
      warn(L, 'No collection has ever run.');
    } else if (daysStale > 2) {
      warn(L, `Collection is ${daysStale} days stale. The nightly workflow may be failing, or GitHub may have disabled it for repository inactivity.`);
    }
    if (pages.length <= 1) {
      L.push('');
      L.push('_Coverage is limited to one page pending Business Portfolio access. Absent pages are an access gap, not inactive pages._');
    }
  } catch (e) {
    L.push(`**Check failed:** ${e.message.slice(0, 200)}`);
    warn(L, 'The database could not be read. Written anyway so the heartbeat commit still happens.');
  }

  fs.writeFileSync(OUT, L.join('\n') + '\n');
  console.log(`STATUS.md written (${fs.statSync(OUT).size} bytes)`);
}

main().catch((e) => {
  // Last resort: still write something, so the heartbeat never depends on this
  // script succeeding.
  fs.writeFileSync(OUT, `# Pipeline status\n\n_Checked ${stamp} UTC._\n\n**Status script crashed:** ${String(e.message).slice(0, 200)}\n`);
  console.error('status script crashed, wrote fallback');
});
