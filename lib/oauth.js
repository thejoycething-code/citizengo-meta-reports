'use strict';
// Minimal OAuth 2.1 helpers for the MCP connector.
//
// Deliberately STATELESS: authorization codes, access tokens and refresh tokens
// are all HMAC-signed JWTs carrying their own claims. Vercel functions have no
// shared memory and this avoids a database round-trip on every request — and a
// table of live credentials that would need protecting.
//
// There is no per-user identity to model here. The consent step proves the
// person holds the shared team token; after that everyone gets the same
// read-only view. So a token is essentially a signed, expiring statement of
// "someone who knew the team token asked for this".

const crypto = require('crypto');

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function secret() {
  const s = process.env.OAUTH_SIGNING_SECRET;
  if (!s) {
    const e = new Error('OAUTH_SIGNING_SECRET is not set');
    e.code = 'CONFIG';
    throw e;
  }
  return s;
}

function sign(payload, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  // jti makes each token unique. Without it, signing the same payload twice in
  // one second returns the identical string, so refresh "rotation" was a no-op.
  //
  // LIMITATION, deliberate: this server is stateless, so an old refresh token
  // stays valid until it expires - there is no revocation list to add it to.
  // True rotation-with-invalidation needs storage. Accepted here because the
  // data is read-only and issuing a token already requires the shared team
  // token; revocation in practice means changing MCP_TOKENS and redeploying.
  const body = { ...payload, jti: crypto.randomBytes(9).toString('hex'), iat: now, exp: now + ttlSeconds };
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify(body));
  const data = `${header}.${claims}`;
  const sig = b64url(crypto.createHmac('sha256', secret()).update(data).digest());
  return `${data}.${sig}`;
}

function verify(token, expectedType) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  const expected = b64url(crypto.createHmac('sha256', secret()).update(data).digest());
  // timingSafeEqual throws on length mismatch, so guard first.
  if (expected.length !== parts[2].length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[2]))) return null;

  let claims;
  try { claims = JSON.parse(unb64url(parts[1]).toString('utf8')); } catch (e) { return null; }
  if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000)) return null;
  if (expectedType && claims.typ !== expectedType) return null;
  return claims;
}

// PKCE S256, required by the MCP authorization spec.
function verifyPkce(codeVerifier, codeChallenge) {
  if (!codeVerifier || !codeChallenge) return false;
  const computed = b64url(crypto.createHash('sha256').update(codeVerifier).digest());
  if (computed.length !== codeChallenge.length) return false;
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(codeChallenge));
}

// Only Claude's own callbacks. Claude Code uses an RFC 8252 loopback redirect on
// an ephemeral port, so the port is deliberately ignored for localhost.
function redirectUriAllowed(uri) {
  if (!uri) return false;
  let u;
  try { u = new URL(uri); } catch (e) { return false; }
  if (u.origin === 'https://claude.ai' && u.pathname === '/api/mcp/auth_callback') return true;
  if ((u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.protocol === 'http:') return true;
  return false;
}

function teamTokenValid(supplied) {
  const configured = String(process.env.MCP_TOKENS || '')
    .split(',').map((t) => t.trim()).filter(Boolean);
  if (!configured.length || !supplied) return false;
  return configured.reduce((ok, t) => (t === supplied ? true : ok), false);
}

// Where this deployment lives. Derived from the request so it works on preview
// URLs and a custom domain without reconfiguration.
function originOf(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const isLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  const proto = req.headers['x-forwarded-proto'] || (isLocal ? 'http' : 'https');
  return `${proto}://${host}`;
}

module.exports = {
  sign, verify, verifyPkce, redirectUriAllowed, teamTokenValid, originOf, b64url,
};
