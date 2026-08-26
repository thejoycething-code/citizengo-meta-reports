'use strict';
// Two sinks behind one interface.
//
// The Supabase sink is the real target. The NDJSON sink exists so the collector
// can be run and verified end-to-end against the live Graph API before any
// database credentials exist — which is exactly the situation Phase 1 starts in.

const fs = require('fs');
const path = require('path');
const { withRetry } = require('../../lib/retry');

// ---------------------------------------------------------------------------
// NDJSON: one file per table under data/. Upserts are emulated by keying rows
// in memory on the same columns the Postgres unique indexes use, so a rerun
// produces a byte-identical file — that is how idempotency gets verified.
// ---------------------------------------------------------------------------
function jsonSink({ dir }) {
  const tables = new Map();

  function keyOf(table, row) {
    if (table === 'meta_pages') return row.page_id;
    if (table === 'meta_posts') return row.post_id;
    if (table === 'meta_post_metrics') return `${row.post_id}|${row.collected_date}`;
    if (table === 'meta_page_metrics') return `${row.page_id}|${row.metric_date}`;
    return null; // collection_runs is append-only
  }

  return {
    name: 'ndjson',
    async upsert(table, rows) {
      if (!rows.length) return { count: 0 };
      if (!tables.has(table)) tables.set(table, new Map());
      const t = tables.get(table);
      for (const row of rows) {
        const k = keyOf(table, row);
        t.set(k === null ? `#${t.size}` : k, row);
      }
      return { count: rows.length };
    },
    async flush() {
      fs.mkdirSync(dir, { recursive: true });
      const written = {};
      for (const [table, rowMap] of tables) {
        // Sorted so reruns are diffable, not just equal-in-content.
        const rows = [...rowMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map((e) => e[1]);
        const file = path.join(dir, `${table}.ndjson`);
        fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
        written[table] = rows.length;
      }
      return written;
    },
  };
}

// ---------------------------------------------------------------------------
// Supabase via PostgREST. Same auth headers and merge-duplicates Prefer header
// as api/record.js in clacton-vercel.
// ---------------------------------------------------------------------------
function supabaseSink({ url, serviceKey }) {
  // Tolerate a trailing slash or a full REST path pasted into the URL.
  const base = url.trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');

  const CONFLICT = {
    meta_pages: 'page_id',
    meta_posts: 'post_id',
    meta_post_metrics: 'post_id,collected_date',
    meta_page_metrics: 'page_id,metric_date',
  };

  return {
    name: 'supabase',
    async upsert(table, rows) {
      if (!rows.length) return { count: 0 };
      const conflict = CONFLICT[table];
      const target = base + '/rest/v1/' + table + (conflict ? `?on_conflict=${conflict}` : '');
      // Upserts are idempotent by construction (on_conflict + merge-duplicates),
      // so retrying a write cannot duplicate rows.
      const res = await withRetry(`upsert ${table}`, async () => {
        const r = await fetch(target, {
          method: 'POST',
          headers: {
            apikey: serviceKey,
            Authorization: 'Bearer ' + serviceKey,
            'Content-Type': 'application/json',
            Prefer: conflict ? 'resolution=merge-duplicates,return=minimal' : 'return=minimal',
          },
          body: JSON.stringify(rows),
        });
        const text = await r.text();
        let body = null;
        if (text) { try { body = JSON.parse(text); } catch (e) { body = text; } }
        return { status: r.status, ok: r.ok, body };
      }, { onRetry: (l, n, why) => process.stderr.write(`  retry ${n}: ${l} (${why})\n`) });
      if (!res.ok) {
        throw new Error(`${table} upsert failed: HTTP ${res.status} ${JSON.stringify(res.body)}`);
      }
      return { count: rows.length };
    },
    async flush() { return {}; },
  };
}

function makeSink({ dryRun, dir }) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!dryRun && url && key) return supabaseSink({ url, serviceKey: key });
  return jsonSink({ dir });
}

module.exports = { makeSink, jsonSink, supabaseSink };
