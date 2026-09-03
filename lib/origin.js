'use strict';
// Origin validation and CORS for every endpoint the assistants talk to.
//
// Carlo Manuali's review, 3 Sep 2026: a POST carrying
// Origin: https://attacker.example was served, and every response said
// Access-Control-Allow-Origin: *. The MCP transport spec requires servers to
// validate Origin on incoming connections (its concern is DNS rebinding); the
// wildcard also meant any page a staff member had open could read the reporting
// data with their session.
//
// Policy:
//   - No Origin header: allowed. The real clients - claude.ai's connector
//     runtime, ChatGPT's, Claude Code, curl - are not browsers and send none.
//     "Validate" means refuse a WRONG origin, not demand one.
//   - Origin present and on the allowlist: served, and the response names that
//     exact origin (never *) with Vary: Origin so caches keep them apart.
//   - Origin present and not on the allowlist: the caller sends a 403. Not 401 -
//     the request is refused for where it came from, not for who sent it, and a
//     401 would hand a WWW-Authenticate challenge to a page that should get
//     nothing. Logged with the origin, so a real client we did not anticipate
//     shows up in the Vercel log rather than as a silent breakage.
//
// The list is the assistants' web origins, this deployment's own origin, and
// loopback for local MCP clients. MCP_ALLOWED_ORIGINS adds exact origins
// without a redeploy.

const { originOf } = require('./oauth');

const ASSISTANT_ORIGINS = ['https://claude.ai', 'https://chatgpt.com', 'https://chat.openai.com'];

function originAllowed(origin, req) {
  if (origin === undefined || origin === null || origin === '') return true;   // non-browser client
  let u;
  try { u = new URL(origin); } catch (e) { return false; }                     // includes the literal "null"
  if (u.origin !== origin) return false;                                       // a bare origin, no path
  if (ASSISTANT_ORIGINS.includes(origin)) return true;
  if (origin === originOf(req)) return true;
  if ((u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.protocol === 'http:') return true;
  const extra = String(process.env.MCP_ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return extra.includes(origin);
}

// Sets the CORS grant for an allowed origin and returns true; returns false for
// a refused one, having set only Vary so the caller's 403 is never cached
// against a different origin's request. The caller writes the response body,
// because the JSON-RPC endpoint and the OAuth endpoints speak different shapes.
function corsFor(req, res, { methods, headers }) {
  const origin = req.headers.origin;
  if (origin !== undefined) res.setHeader('Vary', 'Origin');
  if (!originAllowed(origin, req)) {
    console.warn(JSON.stringify({ at: new Date().toISOString(), event: 'origin_refused', origin }));
    return false;
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', methods);
    res.setHeader('Access-Control-Allow-Headers', headers);
  }
  return true;
}

module.exports = { originAllowed, corsFor, ASSISTANT_ORIGINS };
