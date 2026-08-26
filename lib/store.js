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
    if (!res.ok) throw new Error(`${table} read failed: HTTP ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  }
  return {
    name: 'supabase',
    async loadAll() {
      const [pages, posts, metrics] = await Promise.all(TABLES.map((t) => read(t)));
      return { pages, posts, metrics };
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
