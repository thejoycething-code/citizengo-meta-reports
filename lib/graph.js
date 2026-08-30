'use strict';
// Minimal Graph API client for the Phase 0 probe. No dependencies.
// The token travels in an Authorization header, never in a URL, so it cannot
// leak into fixtures, logs, or shell history.

const fs = require('fs');
const path = require('path');

function loadEnv() {
  const p = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const REDACTIONS = [
  [/access_token=[^&\s"']+/g, 'access_token=<redacted>'],
  [/"access_token"\s*:\s*"[^"]*"/g, '"access_token":"<redacted>"'],
];

function redact(value) {
  let out = typeof value === 'string' ? value : JSON.stringify(value);
  for (const [re, sub] of REDACTIONS) out = out.replace(re, sub);
  return typeof value === 'string' ? out : JSON.parse(out);
}

function makeClient({ token, version }) {
  // Host is overridable purely so scripts/test-multitoken.js can point at a mock.
  // GRAPH_HOST is a test seam. It is refused outright in the runtimes where it
  // would send real access tokens somewhere other than Meta - see lib/env-guard.js.
  require('./env-guard').assertGraphHostSafe();
  const host = process.env.GRAPH_HOST || 'https://graph.facebook.com';
  const base = `${host}/${version}`;

  // Never throws on a Graph error. A 400 with an "invalid metric" envelope IS
  // the result we are probing for, so it must be captured, not raised.
  // opts.token overrides the default token — page-scoped edges (published_posts,
  // /insights) reject user tokens and require a Page access token.
  async function get(pathname, params = {}, opts = {}) {
    const url = new URL(base + pathname);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const started = Date.now();
    let res;
    let body;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${opts.token || token}` } });
      body = await res.json();
    } catch (err) {
      return {
        ok: false,
        request: redact(url.toString()),
        transport_error: String(err),
        elapsed_ms: Date.now() - started,
      };
    }
    const error = body && body.error ? body.error : null;
    return {
      ok: res.ok && !error,
      status: res.status,
      request: redact(url.toString()),
      // Read this on any throttle (codes 32 / 80001) for estimated_time_to_regain_access.
      business_use_case_usage: res.headers.get('x-business-use-case-usage') || null,
      app_usage: res.headers.get('x-app-usage') || null,
      elapsed_ms: Date.now() - started,
      error: error || null,
      // Returned raw. Redaction happens at save time — sanitising here would
      // corrupt page access tokens that the caller legitimately needs in memory.
      body: error ? null : body,
    };
  }

  return { get, version };
}

module.exports = { loadEnv, makeClient, redact };
