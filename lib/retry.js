'use strict';
// Targeted retry for Supabase calls.
//
// Observed in practice: a freshly-created secret key intermittently returns
// HTTP 401 PGRST303 "JWT issued at future". Local and database clocks were
// verified in sync to within a second, so the skew is inside Supabase's own
// infrastructure — between whatever mints the internal JWT and the PostgREST
// instance validating it. Nothing we can fix, but a nightly job must not die on it.
//
// Deliberately NARROW. A generic 401 or 403 is NOT retried, because that means a
// wrong or revoked key and must fail immediately and visibly — retrying it would
// turn an obvious misconfiguration into a slow, confusing one.

const TRANSIENT_CODES = new Set(['PGRST303']);
const ATTEMPTS = 3;
const BACKOFF_MS = [250, 750];

function isTransient(status, body) {
  if (status >= 500) return true;                       // server-side blip
  if (body && TRANSIENT_CODES.has(body.code)) return true;  // clock skew
  return false;
}

// fn() must resolve to { status, ok, body } or throw for network failures.
async function withRetry(label, fn, { onRetry } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fn();
    } catch (e) {
      // Network-level failure: worth one more go.
      lastErr = e;
      if (attempt === ATTEMPTS) throw e;
      if (onRetry) onRetry(label, attempt, e.message);
      await sleep(BACKOFF_MS[attempt - 1]);
      continue;
    }
    if (res.ok) return res;
    if (!isTransient(res.status, res.body) || attempt === ATTEMPTS) return res;
    if (onRetry) onRetry(label, attempt, `HTTP ${res.status} ${res.body && res.body.code}`);
    await sleep(BACKOFF_MS[attempt - 1]);
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { withRetry, isTransient, ATTEMPTS };
