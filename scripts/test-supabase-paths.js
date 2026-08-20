#!/usr/bin/env node
'use strict';
// Exercises every Supabase code path against the mock: the collector's write
// sink, the dashboard's read store, and the MCP tools. Verifies request shapes,
// auth headers, upsert semantics and error handling.
//
// Usage: node scripts/test-supabase-paths.js
const { fork } = require('child_process');
const path = require('path');

const PORT = 5599;
const BASE = `http://localhost:${PORT}`;
let pass = 0; let fail = 0;

function check(name, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
}

async function main() {
  const mock = fork(path.join(__dirname, 'mock-postgrest.js'), ['--port', String(PORT)], { stdio: 'inherit' });
  await new Promise((r) => mock.on('message', (m) => m === 'ready' && r()));

  process.env.SUPABASE_URL = BASE;
  process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

  // Loaded after env is set, since makeSink/store read it at construction.
  const { supabaseSink } = require('../collector/lib/sinks');
  const { supabaseStore } = require('../lib/store');
  const sink = supabaseSink({ url: BASE, serviceKey: 'test-service-key' });
  const store = supabaseStore({ url: BASE, serviceKey: 'test-service-key' });

  console.log('\n1. Write path (collector sink)');
  const pages = [{ page_id: 'P1', name: 'Test Page', platform: 'facebook', followers_count: 100, is_active: true }];
  const posts = [{ post_id: 'P1_1', page_id: 'P1', created_time: '2026-08-01T00:00:00+0000', message: 'hello' }];
  const metrics = [{
    post_id: 'P1_1', page_id: 'P1', collected_date: '2026-08-20',
    views_total: 500, views_unique: null, reactions_total: 10, errors: null,
  }];
  await sink.upsert('meta_pages', pages);
  await sink.upsert('meta_posts', posts);
  await sink.upsert('meta_post_metrics', metrics);
  check('pages, posts and metrics upserted', true);

  console.log('\n2. Idempotency (the merge-duplicates header actually works)');
  await sink.upsert('meta_post_metrics', metrics);
  const after = await store.loadAll();
  check('rerunning the same day does not duplicate', after.metrics.length === 1,
    `${after.metrics.length} metric row(s)`);

  console.log('\n3. Same post, next day appends rather than replaces');
  await sink.upsert('meta_post_metrics', [{ ...metrics[0], collected_date: '2026-08-21', views_total: 800 }]);
  const twoDays = await store.loadAll();
  check('two snapshots retained', twoDays.metrics.length === 2, `${twoDays.metrics.length} rows`);

  console.log('\n4. Read path preserves NULL (must not become 0)');
  const nullKept = twoDays.metrics.every((m) => m.views_unique === null);
  check('views_unique stays null through the round trip', nullKept);

  console.log('\n5. Shaping over Supabase data');
  const { shapeFeed, shapePages } = require('../lib/shape');
  const feed = shapeFeed(twoDays, { sort: 'views' });
  // Latest snapshot only: 800 not 500, and NOT 1300.
  check('reduces to latest snapshot per post', feed.rows.length === 1 && feed.rows[0].views_total === 800,
    `${feed.rows.length} row, views=${feed.rows[0] && feed.rows[0].views_total}`);
  const rollup = shapePages(twoDays);
  check('page rollup does not double-count snapshots', rollup[0].views_total === 800,
    `views_total=${rollup[0].views_total}`);

  console.log('\n6. MCP tools over Supabase');
  const { TOOLS } = require('../mcp/tools');
  const top = await TOOLS.find((t) => t.name === 'top_posts').handler(store, { days: 0, limit: 5 });
  check('top_posts returns data', /800/.test(top.text), 'found latest snapshot value');
  const health = await TOOLS.find((t) => t.name === 'data_health').handler(store, {});
  check('data_health reports over Supabase', /Pages collected/.test(health.text));

  console.log('\n7. Error handling');
  let authErr = null;
  try {
    const noAuth = supabaseStore({ url: BASE, serviceKey: '' });
    await noAuth.loadAll();
  } catch (e) { authErr = e.message; }
  check('missing key surfaces an error rather than empty data', !!authErr,
    authErr ? authErr.slice(0, 60) : 'NO ERROR RAISED');

  let missingTable = null;
  try {
    await sink.upsert('meta_not_a_table', [{ x: 1 }]);
  } catch (e) { missingTable = e.message; }
  check('unapplied schema reports relation-does-not-exist',
    !!missingTable && /does not exist/.test(missingTable),
    missingTable ? missingTable.slice(0, 70) : 'NO ERROR RAISED');

  console.log('\n8. Request audit (what we actually sent)');
  mock.send('dump');
  const dump = await new Promise((r) => mock.on('message', (m) => typeof m === 'object' && r(m)));
  const metricWrites = dump.log.filter((l) => l.table === 'meta_post_metrics' && l.method === 'POST');
  check('on_conflict targets post_id,collected_date',
    metricWrites.every((w) => w.on_conflict === 'post_id,collected_date'),
    metricWrites[0] && metricWrites[0].on_conflict);
  check('Prefer header sets merge-duplicates and return=minimal',
    metricWrites.every((w) => /merge-duplicates/.test(w.prefer) && /return=minimal/.test(w.prefer)),
    metricWrites[0] && metricWrites[0].prefer);
  // Was written with a trailing "|| true", which made it unfailable. A test that
  // cannot fail is worse than no test: it reports confidence it never earned.
  const authRejections = dump.log.filter((l) => l.error === 'missing_auth').length;
  check('every authenticated call carried both headers',
    // Three, not one: loadAll() fans out to the three tables in parallel, so the
    // single deliberate bad-key probe in step 7 produces three rejected requests.
    // Tightening this assertion is what revealed that.
    authRejections === 3,
    `${authRejections} rejection(s), all from the deliberate probe's 3-table fan-out`);

  mock.kill();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
