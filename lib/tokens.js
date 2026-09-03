'use strict';
// Per-person access tokens, held as HASHES in Postgres.
//
// Replaces MCP_TOKENS as the day-to-day source of credentials (3 Sep 2026).
// That variable is write-only in Vercel, so adding one person meant re-entering
// everyone's token and redeploying. Now a token is a row: `npm run tokens -- add
// <name>` inserts a hash and prints the token once; `revoke` stamps revoked_at;
// nothing redeploys.
//
// The token itself is never stored. The hash is SHA-256 of 24 random bytes -
// not reversible, not guessable - so a leak of the table leaks nothing usable.
//
// MCP_TOKENS still works and is checked FIRST: it is the break-glass path when
// the database is unreachable, and how the suites run without one. The table
// is never the only thing standing between a fault and an outage.

const crypto = require('crypto');
const guard = require('./guard');
const { assertTokenStoreSafe } = require('./env-guard');

// Thirty seconds per warm instance: a revocation bites within that window.
const CACHE_MS = Number(process.env.TOKEN_CACHE_MS || 30_000);
let cache = { rows: null, at: 0, pending: null };

function sb() {
  assertTokenStoreSafe();
  if (String(process.env.TOKEN_STORE || '').toLowerCase() === 'off') return null;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_MCP_KEY;
  if (!url || !key) return null;
  return {
    base: url.trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, ''),
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  };
}

const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

// Active rows as { name, token_hash }. Concurrent cache misses share one fetch.
async function activeRows() {
  const now = Date.now();
  if (cache.rows && now - cache.at < CACHE_MS) return cache.rows;
  if (cache.pending) return cache.pending;
  const s = sb();
  if (!s) return cache.rows || [];
  cache.pending = (async () => {
    try {
      const res = await fetch(
        `${s.base}/rest/v1/meta_access_tokens?select=name,token_hash&revoked_at=is.null&limit=1000`,
        { headers: s.headers },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = await res.json();
      cache = { rows: Array.isArray(rows) ? rows : [], at: Date.now(), pending: null };
      return cache.rows;
    } catch (e) {
      // Availability beats strictness: the last good list stays in force and
      // MCP_TOKENS still applies. Logged so a dead table is never silent.
      console.error(`token store unreachable: ${e.message}`);
      cache.pending = null;
      return cache.rows || [];
    }
  })();
  return cache.pending;
}

// Constant time over digests with no early exit - the same discipline as
// guard.identify, applied to stored hashes.
async function identifyStored(supplied) {
  if (!supplied) return null;
  const given = Buffer.from(hash(supplied), 'hex');
  let matched = null;
  for (const r of await activeRows()) {
    const expect = Buffer.from(String(r.token_hash || ''), 'hex');
    if (expect.length === given.length && crypto.timingSafeEqual(given, expect)) matched = r.name;
  }
  if (matched) touch(matched);
  return matched;
}

// last_used_at - at most once per token per fifteen minutes per instance, so
// the request path stays read-only in practice and `list` can still answer
// "does anyone use this?".
const touched = new Map();
function touch(name) {
  const now = Date.now();
  if (now - (touched.get(name) || 0) < 15 * 60_000) return;
  touched.set(name, now);
  const s = sb();
  if (!s) return;
  fetch(`${s.base}/rest/v1/meta_access_tokens?name=eq.${encodeURIComponent(name)}&revoked_at=is.null`, {
    method: 'PATCH',
    headers: { ...s.headers, Prefer: 'return=minimal' },
    body: JSON.stringify({ last_used_at: new Date().toISOString() }),
  }).catch(() => {});
}

// Either source. The env is checked first: it needs no network and it is what
// keeps the door open if the table is down.
async function identify(supplied) {
  const fromEnv = guard.identify(supplied, guard.usableTokens(process.env.MCP_TOKENS));
  if (fromEnv) return fromEnv;
  return identifyStored(supplied);
}

// Is this NAME still permitted? Consulted on every request that presents an
// OAuth token, so revoking a row ends that person's assistant session too.
async function nameActive(name) {
  if (guard.usableTokens(process.env.MCP_TOKENS).some((e) => e.name === name)) return true;
  return (await activeRows()).some((r) => r.name === name);
}

function resetCache() { cache = { rows: null, at: 0, pending: null }; touched.clear(); }

module.exports = { identify, identifyStored, nameActive, activeRows, hash, resetCache, CACHE_MS };
