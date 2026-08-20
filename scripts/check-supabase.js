#!/usr/bin/env node
'use strict';
// Preflight for a real Supabase project. Run this ONCE after applying
// sql/schema.sql and setting credentials — it turns "wire up Supabase" into a
// verified two-minute task instead of debugging a failed nightly run.
//
// Checks, in order of what actually goes wrong:
//   1. Credentials present and well-formed
//   2. Connectivity
//   3. Every table exists          -> catches "forgot to run schema.sql"
//   4. Every column exists         -> catches schema drift vs what we write
//   5. RLS actually locks the anon key  -> catches an exposed database
//   6. Write round-trip            -> catches a read-only or wrong key
//   7. Current row counts
//
// Usage:
//   node scripts/check-supabase.js            # all checks, incl. write round-trip
//   node scripts/check-supabase.js --no-write # read-only checks
//
// Set SUPABASE_ANON_KEY too if you want the RLS check to be meaningful.

const { loadEnv } = require('../lib/graph');
loadEnv();

const NO_WRITE = process.argv.includes('--no-write');
const URL_RAW = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
const ANON = process.env.SUPABASE_ANON_KEY;

let pass = 0; let fail = 0; let warn = 0;
const ok = (n, d) => { console.log(`  PASS  ${n}${d ? ' — ' + d : ''}`); pass++; };
const no = (n, d) => { console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); fail++; };
const wa = (n, d) => { console.log(`  WARN  ${n}${d ? ' — ' + d : ''}`); warn++; };

if (!URL_RAW || !KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set (in .env or the environment).');
  process.exit(2);
}
const BASE = URL_RAW.trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');

// Columns the collector actually writes. If the schema drifts from this list the
// nightly run fails on the first insert, so it is worth checking up front.
const EXPECTED = {
  meta_pages: ['page_id', 'name', 'platform', 'business_id', 'business_name', 'country',
    'ig_user_id', 'followers_count', 'is_active', 'first_seen_at', 'last_seen_at'],
  meta_posts: ['post_id', 'page_id', 'created_time', 'message', 'permalink_url',
    'status_type', 'media_type', 'full_picture', 'is_published', 'first_seen_at'],
  meta_post_metrics: ['post_id', 'page_id', 'collected_date', 'collected_at',
    'views_total', 'views_unique', 'views_organic', 'views_paid', 'views_from_followers',
    'views_from_nonfollowers', 'reactions_total', 'reactions_like', 'reactions_love',
    'reactions_wow', 'reactions_haha', 'reactions_sorry', 'reactions_anger',
    'shares_total', 'clicks_total', 'clicks_by_type', 'activity_by_type', 'video_views',
    'comments_total', 'errors'],
  meta_collection_runs: ['run_id', 'page_id', 'started_at', 'finished_at', 'status',
    'posts_seen', 'metrics_written', 'api_calls', 'error_code', 'error_message'],
  meta_page_tokens: ['page_id', 'token', 'token_source', 'system_user_id',
    'last_verified_at', 'last_error'],
};

const hdrs = (key) => ({ apikey: key, Authorization: 'Bearer ' + key });

async function req(method, pathAndQuery, { key = KEY, body, prefer } = {}) {
  const headers = hdrs(key);
  if (body) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}/rest/v1/${pathAndQuery}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  const text = await res.text();
  if (text) { try { parsed = JSON.parse(text); } catch (e) { parsed = text; } }
  return { status: res.status, ok: res.ok, body: parsed };
}

async function main() {
  console.log(`Supabase preflight · ${BASE}\n`);

  console.log('1. Credentials');
  // service_role and anon keys are JWTs; a publishable/anon key in the
  // service slot is a common and confusing mistake.
  ok('SUPABASE_URL set', BASE);
  if (/^eyJ/.test(KEY)) {
    try {
      const role = JSON.parse(Buffer.from(KEY.split('.')[1], 'base64').toString()).role;
      role === 'service_role'
        ? ok('service key has the service_role claim')
        : no(`service key role is "${role}", expected service_role`, 'writes and RLS bypass will fail');
    } catch (e) { wa('could not decode the service key claim', 'continuing'); }
  } else {
    wa('service key is not a JWT', 'newer Supabase keys may differ; continuing');
  }

  console.log('\n2. Connectivity and tables');
  const missing = [];
  for (const table of Object.keys(EXPECTED)) {
    const r = await req('GET', `${table}?select=*&limit=1`);
    if (r.ok) { ok(`${table} reachable`); continue; }
    if (r.status === 404 || (r.body && r.body.code === '42P01')) { missing.push(table); no(`${table} does not exist`); }
    else no(`${table} unreadable`, `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 90)}`);
  }
  if (missing.length) {
    console.log(`\n  -> Apply sql/schema.sql in the Supabase SQL editor. Missing: ${missing.join(', ')}`);
    console.log(`\n${pass} passed, ${fail} failed, ${warn} warnings`);
    process.exit(1);
  }

  console.log('\n3. Columns match what the collector writes');
  for (const [table, cols] of Object.entries(EXPECTED)) {
    // PostgREST 400s on an unknown column, naming it — so this pinpoints drift.
    const r = await req('GET', `${table}?select=${cols.join(',')}&limit=0`);
    if (r.ok) ok(`${table}: all ${cols.length} columns present`);
    else no(`${table} column mismatch`, JSON.stringify(r.body).slice(0, 130));
  }

  console.log('\n4. Row-level security');
  if (!ANON) {
    wa('SUPABASE_ANON_KEY not set', 'cannot verify the database is locked — set it and re-run');
  } else {
    let exposed = 0;
    for (const table of Object.keys(EXPECTED)) {
      const r = await req('GET', `${table}?select=*&limit=1`, { key: ANON });
      if (r.ok && Array.isArray(r.body) && r.body.length > 0) { no(`${table} is READABLE with the anon key`, 'RLS is not protecting it'); exposed++; }
    }
    if (!exposed) ok('anon key cannot read any table', 'RLS is doing its job');
  }

  console.log('\n5. Write round-trip');
  if (NO_WRITE) {
    wa('skipped (--no-write)', 'the collector needs write access; verify this before relying on it');
  } else {
    const canary = '__preflight_canary__';
    const w = await req('POST', 'meta_pages?on_conflict=page_id', {
      body: [{ page_id: canary, name: 'preflight canary (safe to delete)', platform: 'facebook', is_active: false }],
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
    if (!w.ok) {
      no('insert failed', `HTTP ${w.status} ${JSON.stringify(w.body).slice(0, 120)}`);
    } else {
      ok('insert accepted');
      const r = await req('GET', `meta_pages?select=page_id,name&page_id=eq.${canary}`);
      (r.ok && Array.isArray(r.body) && r.body.length === 1)
        ? ok('read back the row just written')
        : no('could not read back the canary row', JSON.stringify(r.body).slice(0, 90));
      const d = await req('DELETE', `meta_pages?page_id=eq.${canary}`, { prefer: 'return=minimal' });
      d.ok ? ok('canary cleaned up')
           : wa(`canary row left behind (page_id = ${canary})`, 'delete it manually');
    }
  }

  console.log('\n6. Current contents');
  for (const table of Object.keys(EXPECTED)) {
    const r = await req('GET', `${table}?select=*&limit=100000`);
    if (r.ok && Array.isArray(r.body)) console.log(`  ${table.padEnd(22)} ${r.body.length} rows`);
  }

  console.log(`\n${pass} passed, ${fail} failed, ${warn} warnings`);
  if (!fail) console.log('\nReady. Run: npm run collect');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('\npreflight crashed:', e.message); process.exit(1); });
