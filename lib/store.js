'use strict';
// Two explicit stores, no implicit fallback.
//
// The Vercel functions construct supabaseStore ONLY and fail loudly without
// credentials. A silent fallback to local files would let a misconfigured
// deployment serve stale data that looks fine — the worst possible failure for
// a reporting tool.

const fs = require('fs');
const path = require('path');
const { withRetry } = require('./retry');

const TABLES = ['meta_pages', 'meta_posts', 'meta_post_metrics'];

function fileStore({ dir }) {
  function read(table) {
    const f = path.join(dir, `${table}.ndjson`);
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
  return {
    name: 'ndjson',
    async loadAll() {
      return { pages: read('meta_pages'), posts: read('meta_posts'), metrics: read('meta_post_metrics') };
    },
    // Same contract as the Supabase store so the tools cannot tell them apart.
    // All three filter server-side. At 36 pages a demographics table alone is
    // thousands of rows, and no tool needs them all in memory.
    // The local backend holds only pages, posts and post metrics — the
    // collector's NDJSON sink writes nothing else. These return empty so the
    // tools degrade to "no data yet" rather than throwing.
    // Pages per run, latest against the best of the last 30 days.
    async pageCoverage() {
      const rows = read('meta_collection_runs');
      if (!rows.length) return null;
      const byRun = new Map();
      for (const r of rows) {
        if (!byRun.has(r.run_id)) byRun.set(r.run_id, { started: r.started_at, pages: 0 });
        byRun.get(r.run_id).pages += 1;
      }
      const runs = [...byRun.values()].sort((a, b) => String(b.started).localeCompare(String(a.started)));
      return { latest: runs[0].pages, best: Math.max(...runs.slice(0, 30).map((r) => r.pages)) };
    },
    async counts() {
      return {
        meta_pages: read('meta_pages').length,
        meta_posts: read('meta_posts').length,
        meta_post_metrics: read('meta_post_metrics').length,
      };
    },
    async freshness() {
      const rows = read('meta_post_metrics');
      const dates = rows.map((r) => r.collected_date).filter(Boolean).sort();
      return { latest: dates.length ? dates[dates.length - 1] : null, recentFailures: 0 };
    },
    async pageGrowth() { return []; },
    async igMedia() { return []; },
    async adSpend() { return []; },
    async searchPosts({ q, page_id, since, limit = 25 }) {
      const { shapeFeed } = require('./shape');
      const data = {
        pages: read('meta_pages'), posts: read('meta_posts'), metrics: read('meta_post_metrics'),
      };
      let rows = shapeFeed(data, { page_id, since, sort: 'reach' }).rows;
      if (q) {
        const needle = String(q).toLowerCase();
        rows = rows.filter((r) => (r.message || '').toLowerCase().includes(needle));
      }
      return rows.slice(0, Number(limit) || 25);
    },
  };
}

function supabaseStore({ url, serviceKey }) {
  const base = url.trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
  async function read(table, query = 'select=*&limit=100000') {
    const res = await withRetry(`read ${table}`, async () => {
      const r = await fetch(`${base}/rest/v1/${table}?${query}`, {
        headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey },
      });
      const text = await r.text();
      let body = null;
      if (text) { try { body = JSON.parse(text); } catch (e) { body = text; } }
      return { status: r.status, ok: r.ok, body };
    }, { onRetry: (l, n, why) => process.stderr.write(`  retry ${n}: ${l} (${why})\n`) });
    if (!res.ok) {
      // The PostgREST body carries table names, column names and Postgres error
      // codes. It reached the caller verbatim through the MCP tool-error path,
      // handing an authenticated reader a free map of the schema. Log it where
      // an operator can see it; tell the caller only what went wrong.
      console.error(`read ${table} failed: HTTP ${res.status} ${JSON.stringify(res.body)}`);
      const e = new Error(`Could not read ${table} (HTTP ${res.status}).`);
      e.code = 'READ_FAILED';
      e.status = res.status;
      // Machine-readable, and never part of the message the caller sees.
      e.pgCode = res.body && res.body.code ? String(res.body.code) : null;
      throw e;
    }
    return res.body;
  }
  // PostgREST caps every response at db-max-rows, 1000 on Supabase by default,
  // and IGNORES a larger limit in the query string without saying so. Asking for
  // 100000 returned exactly 1000 and looked like a complete answer.
  //
  // Worse than merely losing rows: posts and metrics were truncated
  // INDEPENDENTLY, so posts whose metric rows fell outside the first 1000
  // appeared to have no metrics at all. That is where a reported "343 posts with
  // no metrics" came from when the real figure was 78.
  //
  // A stable sort key is required: offset paging without ORDER BY can repeat or
  // skip rows between requests.
  const PAGE_SIZE = 1000;
  const SORT_KEY = {
    meta_pages: 'page_id',
    meta_posts: 'post_id',
    meta_post_metrics: 'id',
  };

  async function readAll(table) {
    const order = SORT_KEY[table] || 'id';
    const out = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const batch = await read(table, `select=*&order=${order}.asc&limit=${PAGE_SIZE}&offset=${offset}`);
      if (!Array.isArray(batch) || !batch.length) break;
      out.push(...batch);
      if (batch.length < PAGE_SIZE) break;
      // Runaway guard. Loud rather than silent, because a silent cap here is the
      // very bug this function exists to fix.
      if (out.length >= 200000) {
        throw new Error(`${table}: refusing to read beyond 200000 rows — something is wrong`);
      }
    }
    return out;
  }

  // True row counts, measured INDEPENDENTLY of loadAll. PostgREST reports the
  // total in Content-Range when asked for an exact count, so this needs no rows
  // and cannot itself be truncated - which is the whole point. Comparing it
  // against what loadAll returns is how a silent cap gets caught rather than
  // discovered by accident months later.
  async function counts() {
    const out = {};
    for (const table of TABLES) {
      const res = await fetch(`${base}/rest/v1/${table}?select=*&limit=1`, {
        headers: {
          apikey: serviceKey,
          Authorization: 'Bearer ' + serviceKey,
          Prefer: 'count=exact',
        },
      });
      const range = res.headers.get('content-range') || '';
      const total = range.includes('/') ? Number(range.split('/')[1]) : null;
      out[table] = Number.isFinite(total) ? total : null;
    }
    return out;
  }

  async function pageCoverage() {
    // One row per page per run, so counting rows per run_id gives pages reached.
    const rows = await read('meta_collection_runs',
      'select=run_id,started_at&order=started_at.desc&limit=2000');
    if (!Array.isArray(rows) || !rows.length) return null;
    const byRun = new Map();
    for (const r of rows) {
      if (!byRun.has(r.run_id)) byRun.set(r.run_id, { started: r.started_at, pages: 0 });
      byRun.get(r.run_id).pages += 1;
    }
    const runs = [...byRun.values()].sort((a, b) => String(b.started).localeCompare(String(a.started)));
    // Best of the last 3 runs, not the single latest. Targeted backfills are
    // legitimate and tiny - a HazteOir-only run collects exactly 1 page - and
    // judging on the latest run alone reports every one of those as a 97%
    // collapse. A token granting fewer Pages affects EVERY subsequent run, so
    // sustained coverage is the thing to measure.
    const recent = Math.max(...runs.slice(0, 3).map((r) => r.pages));
    return { latest: recent, best: Math.max(...runs.slice(0, 30).map((r) => r.pages)) };
  }

  // Instagram coverage. Reduced to the LATEST ROW PER MEDIA, not to the latest
  // collection date - the same rule the rest of this project applies to
  // append-only tables, and for the same reason. Judging by date is wrong here:
  // a targeted single-page run creates a newer date covering one account, and
  // measuring against it reported "5 of 5" while 698 fully-collected rows sat
  // one day earlier.
  async function igCoverage() {
    const media = await read('meta_ig_media', 'select=media_id&limit=5000');
    const rows = await read('meta_ig_media_metrics',
      'select=media_id,collected_date,reach&order=collected_date.asc&limit=20000');
    if (!Array.isArray(rows) || !rows.length) {
      return { hasMedia: Array.isArray(media) && media.length > 0, latest: null, total: 0, withReach: 0 };
    }
    // Ascending order means the last write per media_id wins.
    const latestPerMedia = new Map();
    for (const r of rows) latestPerMedia.set(r.media_id, r);
    const kept = [...latestPerMedia.values()];
    return {
      hasMedia: true,
      latest: kept.reduce((a, r) => (r.collected_date > a ? r.collected_date : a), ''),
      total: kept.length,
      withReach: kept.filter((r) => r.reach !== null).length,
    };
  }

  return {
    name: 'supabase',
    counts,
    pageCoverage,
    igCoverage,
    async loadAll() {
      const [pages, posts, metrics] = await Promise.all(TABLES.map((t) => readAll(t)));
      return { pages, posts, metrics };
    },
    // Deliberately tiny: one row, newest collection date only. Called on every
    // tool invocation, so it must not cost anything meaningful.
    async freshness() {
      const rows = await read('meta_post_metrics',
        'select=collected_date&order=collected_date.desc&limit=1');
      const latest = rows && rows[0] ? rows[0].collected_date : null;
      const stalePages = await read('meta_collection_runs',
        'select=page_id,status,started_at&status=eq.failed&order=started_at.desc&limit=50');
      return { latest, recentFailures: (stalePages || []).length };
    },
    // All of these filter server-side. At 36 pages the demographics table alone
    // runs to thousands of rows and no tool needs them in memory.
    async pageGrowth({ page_id, since, limit = 400 }) {
      const parts = ['select=*'];
      if (page_id) parts.push(`page_id=eq.${encodeURIComponent(page_id)}`);
      if (since) parts.push(`metric_date=gte.${encodeURIComponent(String(since).slice(0, 10))}`);
      parts.push('order=metric_date.asc');
      parts.push(`limit=${Math.min(Number(limit) || 400, 2000)}`);
      return read('meta_page_growth', parts.join('&'));
    },
    async igMedia({ page_id, since, sort = 'reach', limit = 20 }) {
      const order = { reach: 'reach', saved: 'saved', views: 'views',
        interactions: 'total_interactions', recent: 'timestamp' }[sort] || 'reach';
      const parts = ['select=*'];
      if (page_id) parts.push(`page_id=eq.${encodeURIComponent(page_id)}`);
      if (since) parts.push(`timestamp=gte.${encodeURIComponent(since)}`);
      parts.push(`order=${order}.desc.nullslast`);
      parts.push(`limit=${Math.min(Number(limit) || 20, 200)}`);
      return read('meta_ig_latest', parts.join('&'));
    },
    async adSpend({ page_id, since, limit = 30 }) {
      const parts = ['select=*'];
      if (page_id) parts.push(`post_id=like.${encodeURIComponent(page_id)}*`);
      if (since) parts.push(`created_time=gte.${encodeURIComponent(since)}`);
      parts.push('order=total_spend.desc.nullslast');
      parts.push(`limit=${Math.min(Number(limit) || 30, 200)}`);
      return read('meta_post_paid_vs_organic', parts.join('&'));
    },
    // Filters server-side rather than pulling every post into memory. At 36
    // pages over 90 days that is thousands of rows per call, and a text search
    // has no business shipping all of them across the wire.
    async searchPosts({ q, page_id, since, limit = 25 }) {
      const parts = ['select=*'];
      if (q) {
        // ilike with wildcards; commas and parens would break PostgREST's
        // filter grammar, so they are stripped rather than escaped.
        const safe = String(q).replace(/[(),*]/g, ' ').trim();
        parts.push(`message=ilike.*${encodeURIComponent(safe)}*`);
      }
      if (page_id) parts.push(`page_id=eq.${encodeURIComponent(page_id)}`);
      if (since) parts.push(`created_time=gte.${encodeURIComponent(since)}`);
      parts.push('order=views_unique.desc.nullslast');
      parts.push(`limit=${Math.min(Number(limit) || 25, 200)}`);
      return read('meta_post_latest', parts.join('&'));
    },
  };
}

// For the serverless functions: throws rather than degrading.
function requireSupabaseStore() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    const err = new Error('server_misconfigured: SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
    err.code = 'CONFIG';
    throw err;
  }
  return supabaseStore({ url, serviceKey: key });
}

module.exports = { fileStore, supabaseStore, requireSupabaseStore };
