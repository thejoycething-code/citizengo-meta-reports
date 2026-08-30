'use strict';
// Brute-force protection, credential strength, and per-person token identity.
// Shared by every endpoint that accepts the team token.
//
// WHY THIS IS SEPARATE FROM THE RATE LIMIT IN api/mcp.js
//
// That limiter is keyed on the credential being presented, which was a
// deliberate choice: every request from Claude arrives from Anthropic's egress
// range, so an IP key would throttle all users as one. The consequence is that
// it can only ever limit somebody who ALREADY holds a valid token. An attacker
// trying a different token each time creates a fresh bucket on every attempt,
// so the counter never reaches two.
//
// Confirmed against production on 30 Aug 2026: twelve consecutive wrong tokens
// returned twelve 401s with no throttling. /api/oauth/authorize had no limiter
// of any kind.
//
// So failures are counted separately, keyed on the SOURCE. A guesser cannot
// change their source by varying the token, which is the whole point.

const crypto = require('crypto');

const FAIL_LIMIT = Number(process.env.AUTH_FAIL_LIMIT || 10);
const FAIL_WINDOW_MS = Number(process.env.AUTH_FAIL_WINDOW_MS || 10 * 60_000);

const failures = new Map();          // source -> [timestamps]
const durableSeen = new Map();       // source -> { count, at }  (short-lived cache)
const DURABLE_CACHE_MS = 30_000;

const fingerprint = (t) => crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 8);

// Vercel sets x-vercel-forwarded-for itself and it cannot be spoofed by the
// client; x-forwarded-for can be, so it is only a fallback for other hosts.
// Verified 30 Aug 2026: Vercel also overwrites a client-supplied
// x-forwarded-host, and a spoofed Host header never reaches the function.
function clientIp(req) {
  const h = req.headers || {};
  const raw = h['x-vercel-forwarded-for'] || h['x-real-ip'] || h['x-forwarded-for'] || '';
  return String(raw).split(',')[0].trim() || 'unknown';
}

// ---------------------------------------------------------------------------
// Durable failure store
//
// The in-memory counter is per warm instance, so a recycled instance hands an
// attacker a fresh allowance. Failures are therefore also written to Postgres.
//
// The happy path pays nothing: the durable store is consulted only for a source
// this instance has not seen recently, and written only when a request actually
// fails. Legitimate traffic never touches it after the first request.
// ---------------------------------------------------------------------------

function supabase() {
  // Local test runs were writing auth failures into the production table and
  // then locking themselves out: every request in a test shares one source, the
  // deliberate "wrong token is rejected" cases accumulated across runs, and the
  // limiter eventually refused the whole suite with 429 before any assertion
  // could run. Tests set GUARD_DURABLE=off; production never does.
  if (String(process.env.GUARD_DURABLE || '').toLowerCase() === 'off') return null;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_MCP_KEY;
  if (!url || !key) return null;
  return {
    base: url.trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, ''),
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  };
}

async function durableFailureCount(source) {
  const cached = durableSeen.get(source);
  if (cached && Date.now() - cached.at < DURABLE_CACHE_MS) return cached.count;

  const sb = supabase();
  if (!sb) return 0;
  try {
    const since = new Date(Date.now() - FAIL_WINDOW_MS).toISOString();
    const res = await fetch(
      `${sb.base}/rest/v1/meta_auth_failures?select=id&source_hash=eq.${fingerprint(source)}&at=gte.${encodeURIComponent(since)}&limit=${FAIL_LIMIT + 1}`,
      { headers: sb.headers },
    );
    if (!res.ok) return 0;
    const rows = await res.json();
    const count = Array.isArray(rows) ? rows.length : 0;
    durableSeen.set(source, { count, at: Date.now() });
    return count;
  } catch (e) {
    // Availability beats strictness here: if the database is unreachable the
    // in-memory counter still applies, and refusing every request because the
    // audit table is down would be a self-inflicted outage.
    console.error(`durable failure lookup failed: ${e.message}`);
    return 0;
  }
}

async function recordDurableFailure(source, endpoint) {
  const sb = supabase();
  if (!sb) return;
  try {
    await fetch(`${sb.base}/rest/v1/meta_auth_failures`, {
      method: 'POST',
      headers: { ...sb.headers, Prefer: 'return=minimal' },
      body: JSON.stringify([{ source_hash: fingerprint(source), endpoint }]),
    });
    const cached = durableSeen.get(source);
    if (cached) cached.count += 1;      // keep the cache honest without a re-read
  } catch (e) {
    console.error(`durable failure write failed: ${e.message}`);
  }
}

function memoryFailures(source) {
  const now = Date.now();
  const seen = (failures.get(source) || []).filter((t) => now - t < FAIL_WINDOW_MS);
  failures.set(source, seen);
  return seen.length;
}

async function failureLimited(source) {
  if (memoryFailures(source) >= FAIL_LIMIT) return true;
  return (await durableFailureCount(source)) >= FAIL_LIMIT;
}

async function recordFailure(source, endpoint = 'unknown') {
  const now = Date.now();
  const seen = (failures.get(source) || []).filter((t) => now - t < FAIL_WINDOW_MS);
  seen.push(now);
  failures.set(source, seen);
  if (failures.size > 1000) {
    for (const [k, v] of failures) {
      if (!v.length || now - v[v.length - 1] > FAIL_WINDOW_MS) failures.delete(k);
    }
  }
  await recordDurableFailure(source, endpoint);
}

// ---------------------------------------------------------------------------
// Credential strength and identity
// ---------------------------------------------------------------------------

// Returns a reason string when the token is too weak to be an access credential,
// or null when it is acceptable.
//
// The token in production until 30 Aug 2026 was "cgo_team_shared_2026": twenty
// characters, but a fixed prefix, three dictionary words and the current year.
// The consent page displayed "cgo_..." as its input placeholder, confirming the
// prefix to anyone who loaded it. Guessing that is a wordlist, not a search.
function tokenWeakness(t) {
  if (typeof t !== 'string' || t.length < 24) return 'shorter than 24 characters';
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(t)).length;
  if (classes < 3) return 'uses fewer than three character classes';
  if (new Set(t).size < 12) return 'too few distinct characters';
  return null;
}

// MCP_TOKENS accepts either bare tokens or "name:token" pairs, so one person can
// be revoked without re-issuing to everyone:
//
//   MCP_TOKENS="alice:cgo_xxx,bob:cgo_yyy"
//
// The name is an operational label, not an authenticated identity - anyone
// holding Bob's token is Bob as far as this server knows. It exists so the logs
// say something more useful than a hash, and so removing one entry from the
// secret is an obvious, safe operation.
//
// A weak token does not authenticate. Enforced at the point of use rather than
// at startup because a serverless function has no startup to fail at - and
// refusing every request because of a misconfiguration would take the tool down
// rather than securing it.
function usableTokens(raw) {
  const out = [];
  for (const entry of String(raw || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    // Split on the FIRST colon only: base64url tokens never contain one, but a
    // future token format might.
    const idx = entry.indexOf(':');
    const name = idx > 0 ? entry.slice(0, idx).trim() : null;
    const token = idx > 0 ? entry.slice(idx + 1).trim() : entry;
    if (!token) continue;
    const why = tokenWeakness(token);
    if (why) {
      console.error(`REJECTED a configured token (${name || fingerprint(token)}): ${why}. `
        + 'It will not authenticate. Replace it with: '
        + "node -e \"console.log('cgo_'+require('crypto').randomBytes(24).toString('base64url'))\"");
      continue;
    }
    out.push({ name: name || fingerprint(token), token });
  }
  return out;
}

// Constant-time comparison over digests, so neither the contents nor the length
// of the expected token leaks through timing. Returns the matching entry's name,
// or null - the name is what makes per-person logging possible.
function identify(supplied, entries) {
  if (!supplied || !entries.length) return null;
  const given = crypto.createHash('sha256').update(supplied).digest();
  let matched = null;
  for (const e of entries) {
    const expect = crypto.createHash('sha256').update(e.token).digest();
    if (crypto.timingSafeEqual(given, expect)) matched = e.name;   // no early exit
  }
  return matched;
}

function matchesAny(supplied, entries) {
  return identify(supplied, entries) !== null;
}

module.exports = {
  clientIp, failureLimited, recordFailure,
  tokenWeakness, usableTokens, identify, matchesAny, fingerprint,
  FAIL_LIMIT, FAIL_WINDOW_MS,
};
