#!/usr/bin/env node
'use strict';

// Every tool response goes into a conversation. A tool that returns everything
// it found is not thorough, it is unusable: `outliers` once returned 2,225 lines
// and 439,000 characters because it listed every post more than 1.5x or under
// 0.5x the median, which on 90 days across 36 pages was over two thousand posts.
//
// That only appeared once the dataset grew - it was fine at 400 posts and broken
// at 2,700, with no code change in between. So the guard belongs in a test that
// runs against a deliberately large dataset rather than whatever happens to be
// in the database today.

const { fork } = require('child_process');
const path = require('path');

const PORT = 5741;
const ROOT = path.join(__dirname, '..');
const MAX_CHARS = 60_000;   // generous; the point is to catch runaway growth
const POSTS = 600;

(async () => {
  const mock = fork(path.join(ROOT, 'scripts/mock-postgrest.js'), ['--port', String(PORT)], { stdio: 'inherit' });
  await new Promise((r) => mock.on('message', (m) => m === 'ready' && r()));

  const H = { apikey: 'k', Authorization: 'Bearer k', 'Content-Type': 'application/json' };
  const post = (table, rows) => fetch(`http://localhost:${PORT}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });

  await post('meta_pages', [{ page_id: 'P1', name: 'Test Page', followers: 10000 }]);

  // A spread wide enough that plenty of posts land outside 0.5x-1.5x of the
  // median, which is what produced the runaway output.
  const posts = [];
  const metrics = [];
  for (let i = 0; i < POSTS; i++) {
    const id = `P1_${i}`;
    const day = String((i % 28) + 1).padStart(2, '0');
    posts.push({ post_id: id, page_id: 'P1', created_time: `2026-08-${day}T09:00:00+0000`,
      message: 'x'.repeat(400), permalink_url: 'https://facebook.com/' + id });
    metrics.push({ post_id: id, page_id: 'P1', collected_date: '2026-08-29',
      views_total: i % 7 === 0 ? 90000 : (i % 3 === 0 ? 40 : 1200),
      views_unique: 100, shares_total: i % 5, reactions_total: 10,
      comments_total: 1, engagement_rate: 0.02 });
  }
  await post('meta_posts', posts);
  await post('meta_post_metrics', metrics);

  const { supabaseStore } = require(path.join(ROOT, 'lib/store'));
  const { TOOLS, callTool } = require(path.join(ROOT, 'mcp/tools'));
  const store = supabaseStore({ url: `http://localhost:${PORT}`, serviceKey: 'k' });

  // HOSTILE arguments, not defaults. The previous version called every tool with
  // its defaults, which is exactly why it passed while outliers still accepted
  // {"limit": 100000} and rebuilt the 439,000-character response the cap existed
  // to prevent. A cap that only holds when nobody pushes on it is not a cap.
  const HOSTILE = { limit: 1e6, days: 1e6 };
  const argsFor = {
    page_summary: { page_id: 'P1', ...HOSTILE },
    search_posts: { query: 'x', ...HOSTILE },
  };
  const argsFrom = (name) => argsFor[name] || { ...HOSTILE };

  let failed = 0;
  const untested = [];
  console.log(`\n${POSTS} posts seeded. Every tool called with limit=1000000 and days=1000000.`);
  console.log(`Cap is ${MAX_CHARS.toLocaleString()} characters per response.\n`);
  for (const t of TOOLS) {
    let len = -1, note = '', skipped = false;
    try {
      const out = await callTool(store, t.name, argsFrom(t.name));
      len = (out.text || '').length;
    } catch (e) {
      // 42P01 is "relation does not exist": the mock implements the base tables
      // but not the database views, so some tools cannot run here at all. That
      // is a gap in the mock, not a fault in the tool - but it must be reported
      // as an untested tool rather than folded into a pass, or the summary line
      // would claim coverage this test does not have.
      // 42P01 "relation does not exist" and 42703 "column does not exist" both
      // mean the mock lacks a view, not that the tool is broken. Read them from
      // e.pgCode: the message no longer carries them, on purpose.
      if (e.pgCode === '42P01' || e.pgCode === '42703') { skipped = true; note = ' — needs a view the mock does not implement'; }
      else { note = ' — ' + e.message.slice(0, 60); }
    }
    if (skipped) { untested.push(t.name); }
    else {
      const bad = len > MAX_CHARS || len < 0;
      if (bad) failed++;
    }
    const label = skipped ? 'skip' : (len > MAX_CHARS || len < 0 ? 'FAIL' : 'ok  ');
    console.log(`  ${label}  ${t.name.padEnd(18)} ${len < 0 ? '' : len.toLocaleString()}${note}`.trimEnd());
  }

  const checked = TOOLS.length - untested.length;
  console.log(failed
    ? `\n${failed} tool(s) over the cap or broken.`
    : `\n${checked} of ${TOOLS.length} tools within the cap.`);
  if (untested.length) {
    console.log(`Not exercised here (mock has no views): ${untested.join(', ')}.`);
    console.log('Those are covered by the live check in the release steps.');
  }
  console.log();

  mock.kill();
  process.exit(failed ? 1 : 0);
})();
