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
    if (table === 'meta_ig_media') return row.media_id;
    if (table === 'meta_ig_media_metrics') return `${row.media_id}|${row.collected_date}`;
    if (table === 'meta_post_ad_spend') return `${row.ad_id}|${row.date_start}|${row.date_stop}`;
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
    meta_ig_media: 'media_id',
    meta_ig_media_metrics: 'media_id,collected_date',
    meta_ig_account_metrics: 'ig_user_id,metric_date',
    meta_post_ad_spend: 'ad_id,date_start,date_stop',
  };

  // Append-only by design: a surrogate id primary key and no unique constraint,
  // so every run adds a row rather than replacing one. A plain insert is
  // correct here and on_conflict would be wrong.
  const APPEND_ONLY = new Set(['meta_collection_runs']);

  // Any other table missing from CONFLICT is not a small omission: the POST
  // would go out with no on_conflict, so each run either duplicates rows or
  // trips the table's unique index. Both fail quietly enough to go unnoticed
  // for days, so refuse at the call instead of guessing.
  function conflictFor(table) {
    if (APPEND_ONLY.has(table)) return null;
    if (!CONFLICT[table]) {
      throw new Error(`no conflict key configured for ${table} — add it to CONFLICT (or APPEND_ONLY) in collector/lib/sinks.js`);
    }
    return CONFLICT[table];
  }

  // Pages collected before. Used to recover pages that /me/accounts stops
  // enumerating - see the recovery step in collect.js.
  async function knownPageIds() {
    try {
      const res = await fetch(`${base}/rest/v1/meta_pages?select=page_id&limit=1000`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      });
      if (!res.ok) {
        console.error(`  knownPageIds: HTTP ${res.status} — page recovery unavailable this run`);
        return [];
      }
      const rows = await res.json();
      return Array.isArray(rows) ? rows.map((r) => r.page_id).filter(Boolean) : [];
    } catch (e) {
      // Say so. The first version referenced an out-of-scope variable, threw,
      // and returned [] silently - so recovery reported nothing to recover and
      // looked like it had simply found nothing missing. Never fail quietly
      // here: an empty list and a broken query look identical downstream.
      console.error(`  knownPageIds failed: ${e.message} — page recovery unavailable this run`);
      return [];
    }
  }

  return {
    name: 'supabase',
    knownPageIds,
    async upsert(table, rows) {
      if (!rows.length) return { count: 0 };
      const conflict = conflictFor(table);
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
