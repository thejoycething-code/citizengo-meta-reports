#!/usr/bin/env node
'use strict';
// A PostgREST test double: just enough of the API surface that the Supabase code
// paths can be exercised without credentials or a database.
//
// This exists because supabaseSink and supabaseStore were written and never run.
// Untested write paths are where silent data loss lives — a wrong header or a
// mishandled on_conflict would look fine until the first real nightly run.
//
// It deliberately enforces auth headers and mimics PostgREST error bodies, so a
// missing apikey or a bad table name fails here the way it would in production.
//
// Usage: node scripts/mock-postgrest.js [--port 5555] [--fail-table X]

const http = require('http');

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1]; };
const PORT = Number(argVal('port', 5555));
const FAIL_TABLE = argVal('fail-table', null);
let transientLeft = Number(argVal('transient-fails', 0));

// Mirrors the unique indexes in sql/schema.sql, so upsert semantics are tested
// rather than assumed.
const CONFLICT_KEYS = {
  meta_pages: ['page_id'],
  meta_posts: ['post_id'],
  meta_post_metrics: ['post_id', 'collected_date'],
  meta_page_tokens: ['page_id'],
  meta_page_metrics: ['page_id', 'metric_date'],
  meta_ig_media: ['media_id'],
  meta_ig_media_metrics: ['media_id', 'collected_date'],
  meta_post_ad_spend: ['ad_id', 'date_start', 'date_stop'],
};
const KNOWN = new Set([...Object.keys(CONFLICT_KEYS), 'meta_collection_runs',
  'meta_page_metrics', 'meta_ig_media', 'meta_ig_media_metrics', 'meta_post_ad_spend']);

// Mirrors sql/schema.sql. Without this the mock accepts any select= list and the
// preflight's column check passes without proving anything.
const COLUMNS = {
  meta_pages: ['page_id', 'name', 'platform', 'business_id', 'business_name', 'country',
    'ig_user_id', 'followers_count', 'is_active', 'first_seen_at', 'last_seen_at'],
  meta_posts: ['post_id', 'page_id', 'created_time', 'message', 'permalink_url',
    'status_type', 'media_type', 'full_picture', 'is_published', 'first_seen_at'],
  meta_post_metrics: ['id', 'post_id', 'page_id', 'collected_date', 'collected_at',
    'views_total', 'views_unique', 'views_organic', 'views_paid', 'views_from_followers',
    'views_from_nonfollowers', 'reactions_total', 'reactions_like', 'reactions_love',
    'reactions_wow', 'reactions_haha', 'reactions_sorry', 'reactions_anger',
    'shares_total', 'clicks_total', 'clicks_by_type', 'activity_by_type', 'video_views',
    'comments_total', 'errors'],
  meta_collection_runs: ['id', 'run_id', 'page_id', 'started_at', 'finished_at', 'status',
    'posts_seen', 'metrics_written', 'api_calls', 'error_code', 'error_message'],
  meta_page_tokens: ['page_id', 'token', 'token_source', 'system_user_id',
    'last_verified_at', 'last_error'],
};

// PostgREST filters we use: ?col=eq.value
function applyFilters(rows, params) {
  let out = rows;
  for (const [k, v] of params) {
    if (['select', 'limit', 'offset', 'order', 'on_conflict'].includes(k)) continue;
    if (v.startsWith('eq.')) {
      const want = v.slice(3);
      out = out.filter((r) => String(r[k]) === want);
    }
  }
  return out;
}

const db = new Map(); // table -> Map(key -> row)
const log = [];       // request audit, so tests can assert on what was sent

function keyFor(table, row, conflictCols) {
  const cols = conflictCols || CONFLICT_KEYS[table];
  if (!cols) return `#${(db.get(table) || new Map()).size}`;
  return cols.map((c) => row[c]).join('|');
}

function pgError(res, status, code, message, hint) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ code, message, details: null, hint: hint || null }));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const m = url.pathname.match(/^\/rest\/v1\/([A-Za-z0-9_]+)$/);

  // PostgREST requires both; if our client ever stops sending them we want to know.
  const apikey = req.headers.apikey;
  const auth = req.headers.authorization || '';
  if (!apikey || !auth.startsWith('Bearer ')) {
    log.push({ path: url.pathname, method: req.method, error: 'missing_auth' });
    return pgError(res, 401, '42501', 'No API key found in request', 'Send apikey and Authorization headers');
  }

  if (!m) return pgError(res, 404, '404', 'Not found');
  const table = m[1];

  // Reproduces the real observed failure: HTTP 401 PGRST303 from clock skew.
  if (transientLeft > 0) {
    transientLeft--;
    log.push({ method: req.method, table, injected: 'PGRST303' });
    return pgError(res, 401, 'PGRST303', 'JWT issued at future');
  }
  if (table === FAIL_TABLE) {
    return pgError(res, 500, 'XX000', `simulated failure on ${table}`);
  }
  if (!KNOWN.has(table)) {
    // Exactly how PostgREST reports an unapplied schema — the most likely real
    // first-run failure.
    return pgError(res, 404, '42P01', `relation "public.${table}" does not exist`,
      'Run sql/schema.sql in the Supabase SQL editor');
  }

  if (req.method === 'GET' || req.method === 'DELETE') {
    const select = url.searchParams.get('select');
    if (select && select !== '*') {
      const bad = select.split(',').map((c) => c.trim())
        .filter((c) => c && c !== '*' && !(COLUMNS[table] || []).includes(c));
      if (bad.length) {
        // How PostgREST reports schema drift, naming the offending column.
        return pgError(res, 400, '42703',
          `column ${table}.${bad[0]} does not exist`, 'Check sql/schema.sql was applied in full');
      }
    }

    const store = db.get(table) || new Map();
    let rows = [...store.values()];
    rows = applyFilters(rows, url.searchParams);

    if (req.method === 'DELETE') {
      let removed = 0;
      for (const [k, v] of [...store.entries()]) {
        if (rows.includes(v)) { store.delete(k); removed++; }
      }
      log.push({ method: 'DELETE', table, removed });
      res.writeHead(204);
      return res.end();
    }

    const limit = url.searchParams.get('limit');
    if (limit !== null) rows = rows.slice(0, Number(limit));
    log.push({ method: 'GET', table, returned: rows.length, query: url.search });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(rows));
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let rows;
      try {
        rows = JSON.parse(body || '[]');
      } catch (e) {
        return pgError(res, 400, '22P02', 'invalid input syntax for JSON');
      }
      if (!Array.isArray(rows)) rows = [rows];

      const prefer = req.headers.prefer || '';
      const conflictParam = url.searchParams.get('on_conflict');
      const conflictCols = conflictParam ? conflictParam.split(',') : null;
      const merging = /merge-duplicates/.test(prefer);

      if (!db.has(table)) db.set(table, new Map());
      const t = db.get(table);
      let inserted = 0; let merged = 0;

      for (const row of rows) {
        const k = keyFor(table, row, conflictCols);
        if (t.has(k)) {
          if (!merging) {
            // PostgREST's real behaviour without merge-duplicates.
            return pgError(res, 409, '23505',
              `duplicate key value violates unique constraint on ${table}`,
              'Send Prefer: resolution=merge-duplicates');
          }
          t.set(k, { ...t.get(k), ...row });
          merged++;
        } else {
          t.set(k, row);
          inserted++;
        }
      }

      log.push({ method: 'POST', table, count: rows.length, inserted, merged, prefer, on_conflict: conflictParam });
      const minimal = /return=minimal/.test(prefer);
      res.writeHead(201, minimal ? {} : { 'Content-Type': 'application/json' });
      return res.end(minimal ? '' : JSON.stringify(rows));
    });
    return;
  }

  pgError(res, 405, '405', 'Method not allowed');
});

// Introspection for the test harness only — not part of PostgREST.
process.on('SIGTERM', () => process.exit(0));
process.on('message', (msg) => {
  if (msg === 'dump' && process.send) {
    process.send({
      tables: Object.fromEntries([...db.entries()].map(([t, rows]) => [t, rows.size])),
      log,
    });
  }
});

server.listen(PORT, () => {
  process.stderr.write(`mock postgrest on http://localhost:${PORT}\n`);
  if (process.send) process.send('ready');
});
