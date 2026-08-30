'use strict';
// Brute-force protection and credential strength checks, shared by every
// endpoint that accepts the team token.
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

const failures = new Map();

// Vercel sets x-vercel-forwarded-for itself and it cannot be spoofed by the
// client; x-forwarded-for can be, so it is only a fallback for other hosts.
// Verified 30 Aug 2026: Vercel also overwrites a client-supplied
// x-forwarded-host, and a spoofed Host header never reaches the function.
function clientIp(req) {
  const h = req.headers || {};
  const raw = h['x-vercel-forwarded-for'] || h['x-real-ip'] || h['x-forwarded-for'] || '';
  return String(raw).split(',')[0].trim() || 'unknown';
}

function failureLimited(key) {
  const now = Date.now();
  const seen = (failures.get(key) || []).filter((t) => now - t < FAIL_WINDOW_MS);
  failures.set(key, seen);
  return seen.length >= FAIL_LIMIT;
}

function recordFailure(key) {
  const now = Date.now();
  const seen = (failures.get(key) || []).filter((t) => now - t < FAIL_WINDOW_MS);
  seen.push(now);
  failures.set(key, seen);
  // Evict cold sources so the map cannot grow without bound.
  if (failures.size > 1000) {
    for (const [k, v] of failures) {
      if (!v.length || now - v[v.length - 1] > FAIL_WINDOW_MS) failures.delete(k);
    }
  }
}

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

// A weak token does not authenticate. Enforced at the point of use rather than
// at startup because a serverless function has no startup to fail at - and
// refusing every request because of a misconfiguration would take the tool down
// rather than securing it.
function usableTokens(raw) {
  const configured = String(raw || '').split(',').map((t) => t.trim()).filter(Boolean);
  const usable = [];
  for (const t of configured) {
    const why = tokenWeakness(t);
    if (why) {
      // Fingerprint, never the token itself.
      console.error(`REJECTED a configured token (${fingerprint(t)}): ${why}. `
        + 'It will not authenticate. Replace it with: '
        + "node -e \"console.log('cgo_'+require('crypto').randomBytes(24).toString('base64url'))\"");
      continue;
    }
    usable.push(t);
  }
  return usable;
}

const fingerprint = (t) => crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 8);

// Constant-time comparison over digests, so neither the contents nor the length
// of the expected token leaks through timing.
function matchesAny(supplied, candidates) {
  if (!supplied || !candidates.length) return false;
  const given = crypto.createHash('sha256').update(supplied).digest();
  let ok = false;
  for (const c of candidates) {
    const expect = crypto.createHash('sha256').update(c).digest();
    if (crypto.timingSafeEqual(given, expect)) ok = true;   // no early exit
  }
  return ok;
}

module.exports = {
  clientIp, failureLimited, recordFailure,
  tokenWeakness, usableTokens, matchesAny, fingerprint,
  FAIL_LIMIT, FAIL_WINDOW_MS,
};
