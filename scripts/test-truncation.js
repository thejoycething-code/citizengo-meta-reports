#!/usr/bin/env node
'use strict';
// Regression test for the silent-truncation bug.
//
// PostgREST caps responses at db-max-rows (1000 on Supabase), ignores a larger
// limit in the query string, and says nothing. Every aggregate this project
// produced was once computed on 1000 of 2237 posts because of it, and it was
// found by accident rather than by a test.
//
// The mock reproduces that behaviour with --cap, so this proves the watchdog's
// completeness check would catch it rather than assuming so.
const { fork } = require('child_process');
const path = require('path');
const PORT = 5733;
const ROOT = path.join(__dirname, '..');

(async () => {
  const mock = fork(path.join(ROOT, 'scripts/mock-postgrest.js'), ['--port', String(PORT), '--cap', '3'], { stdio: 'inherit' });
  await new Promise((r) => mock.on('message', (m) => m === 'ready' && r()));

  const H = { apikey: 'k', Authorization: 'Bearer k', 'Content-Type': 'application/json' };
  // Seed 10 posts; the cap will only ever return 3.
  const posts = Array.from({ length: 10 }, (_, i) => ({ post_id: 'P' + i, page_id: 'X', created_time: '2026-08-01T00:00:00+0000' }));
  await fetch(`http://localhost:${PORT}/rest/v1/meta_posts?on_conflict=post_id`, {
    method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(posts),
  });

  const { supabaseStore } = require(path.join(ROOT, 'lib/store'));
  const store = supabaseStore({ url: `http://localhost:${PORT}`, serviceKey: 'k' });

  const exact = await store.counts();
  const loaded = await store.loadAll();
  console.log(`  exact count says:  ${exact.meta_posts} posts`);
  console.log(`  loadAll returned:  ${loaded.posts.length} posts`);

  const caught = exact.meta_posts !== loaded.posts.length;
  console.log(caught
    ? `  PASS — the mismatch the completeness check looks for is present (${loaded.posts.length}/${exact.meta_posts})`
    : '  FAIL — truncation was not detectable');

  mock.kill();
  process.exit(caught ? 0 : 1);
})();
