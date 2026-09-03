'use strict';
// OAuth Client ID Metadata Documents (CIMD): the client_id IS an https URL, and
// the document at that URL says who the client is and where it may receive a
// code. Claude offers this as its recommended option ("Use Anthropic's hosted
// client metadata") and on 3 Sep 2026 Carlo Manuali's test stopped at our
// metadata because we did not advertise it. Dynamic registration remains for
// clients that prefer it (ChatGPT does).
//
// The authorization server fetches a URL supplied by an unknown party, which is
// a server-side request forgery surface. So: only https, only a hostname on the
// trust list (the assistants' own domains, plus OAUTH_CIMD_HOSTS), a short
// timeout, a size cap, redirects not followed. Loopback over http is allowed
// off production so the suite can run a mock.
//
// Validation, per the MCP authorization spec (2025-11-25):
//   - the document's client_id MUST equal the URL exactly
//   - redirect_uris MUST contain the redirect_uri presented
//   - client_id, client_name and redirect_uris MUST be present
// Our own redirect allowlist (lib/oauth.js) is checked BEFORE any of this, so a
// document can only ever narrow what is permitted, never widen it.

const { onVercelProduction } = require('./env-guard');

const TRUSTED_HOSTS = ['claude.ai', 'claude.com', 'anthropic.com', 'chatgpt.com', 'chat.openai.com', 'openai.com'];
const FETCH_TIMEOUT_MS = 5000;
const MAX_BYTES = 64 * 1024;
const cache = new Map();   // url -> { doc, exp }

const loopback = (h) => h === 'localhost' || h === '127.0.0.1';

function isClientIdUrl(id) {
  if (typeof id !== 'string' || !/^https?:\/\//i.test(id)) return false;
  let u;
  try { u = new URL(id); } catch (e) { return false; }
  if (u.hash || u.username || u.password) return false;
  if (!u.pathname || u.pathname === '/') return false;
  if (u.protocol === 'http:') return loopback(u.hostname) && !onVercelProduction();
  return u.protocol === 'https:';
}

function hostTrusted(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (loopback(h) && !onVercelProduction()) return true;
  const extra = String(process.env.OAUTH_CIMD_HOSTS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return [...TRUSTED_HOSTS, ...extra].some((t) => h === t || h.endsWith('.' + t));
}

function refused(reason, url) {
  const e = new Error(`client metadata refused: ${reason}`);
  e.code = 'CIMD_REFUSED'; e.reason = reason; e.url = url;
  return e;
}

// Honour the document's own Cache-Control, clamped to [1 minute, 24 hours].
function ttlFrom(res) {
  const m = /max-age=(\d+)/i.exec(res.headers.get('cache-control') || '');
  const seconds = m ? Number(m[1]) : 3600;
  return Math.min(Math.max(seconds, 60), 24 * 3600) * 1000;
}

async function fetchDocument(url) {
  const hit = cache.get(url);
  if (hit && Date.now() < hit.exp) return hit.doc;
  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) { throw refused(`fetch failed: ${e.name || e.message}`, url); }
  if (res.status !== 200) throw refused(`HTTP ${res.status}`, url);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw refused('document too large', url);
  let doc;
  try { doc = JSON.parse(text); } catch (e) { throw refused('not JSON', url); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw refused('not an object', url);
  if (doc.client_id !== url) throw refused('client_id does not match the URL', url);
  if (typeof doc.client_name !== 'string' || !doc.client_name.trim()) throw refused('client_name missing', url);
  if (!Array.isArray(doc.redirect_uris) || !doc.redirect_uris.length
      || !doc.redirect_uris.every((r) => typeof r === 'string')) throw refused('redirect_uris missing', url);
  cache.set(url, { doc, exp: Date.now() + ttlFrom(res) });
  return doc;
}

// RFC 8252 §7.3: a loopback redirect may use any port, because the client binds
// whatever is free. Claude Code declares http://localhost/callback and
// http://127.0.0.1/callback in its document and arrives on an ephemeral port,
// so loopback entries are compared with the port removed. Nothing else is.
function redirectListed(doc, redirectUri) {
  if (doc.redirect_uris.includes(redirectUri)) return true;
  const bare = (x) => {
    try {
      const v = new URL(x);
      if (v.protocol !== 'http:' || !loopback(v.hostname)) return null;
      v.port = '';
      return v.toString();
    } catch (e) { return null; }
  };
  const want = bare(redirectUri);
  return want !== null && doc.redirect_uris.some((r) => bare(r) === want);
}

// Returns the document, or throws CIMD_REFUSED with a reason for the log.
// Callers have already checked redirect_uri against our own allowlist.
async function validateClient(clientId, redirectUri) {
  if (!isClientIdUrl(clientId)) throw refused('client_id is not an https URL with a path', clientId);
  const u = new URL(clientId);
  if (!hostTrusted(u.hostname)) throw refused(`host ${u.hostname} not trusted`, clientId);
  const doc = await fetchDocument(clientId);
  if (!redirectListed(doc, redirectUri)) throw refused('redirect_uri not listed in the client document', clientId);
  return doc;
}

function resetCache() { cache.clear(); }

module.exports = { isClientIdUrl, hostTrusted, validateClient, fetchDocument, resetCache, TRUSTED_HOSTS };
