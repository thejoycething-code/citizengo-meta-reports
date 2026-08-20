'use strict';
// Two explicit stores, no implicit fallback.
//
// The Vercel functions construct supabaseStore ONLY and fail loudly without
// credentials. A silent fallback to local files would let a misconfigured
// deployment serve stale data that looks fine — the worst possible failure for
// a reporting tool.

const fs = require('fs');
const path = require('path');

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
  };
}

function supabaseStore({ url, serviceKey }) {
  const base = url.trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
  async function read(table, query = 'select=*&limit=100000') {
    const res = await fetch(`${base}/rest/v1/${table}?${query}`, {
      headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey },
    });
    if (!res.ok) throw new Error(`${table} read failed: HTTP ${res.status} ${await res.text()}`);
    return res.json();
  }
  return {
    name: 'supabase',
    async loadAll() {
      const [pages, posts, metrics] = await Promise.all(TABLES.map((t) => read(t)));
      return { pages, posts, metrics };
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
