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

// `expect` binds a token to this deployment: { iss, aud } as produced by
// claimsFor(req). When given, a token naming a different issuer or audience -
// or none at all - is refused. Added 3 Sep 2026 after Carlo Manuali's review
// asked that issuer, audience, expiry and scope all be validated: until then
// only the signature and expiry were, so a token minted for a preview
// deployment sharing the secret would have been accepted by production.
function verify(token, expectedType, expect) {
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
  if (expect) {
    if (claims.iss !== expect.iss) return null;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(expect.aud)) return null;
  }
  return claims;
}

// PKCE S256, required by the MCP authorization spec.
function verifyPkce(codeVerifier, codeChallenge) {
  if (!codeVerifier || !codeChallenge) return false;
  const computed = b64url(crypto.createHash('sha256').update(codeVerifier).digest());
  if (computed.length !== codeChallenge.length) return false;
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(codeChallenge));
}

// An allowlist of the assistants allowed to receive an authorization code.
//
// Staff use claude.ai and ChatGPT, not Claude Code, so both must be here.
// ChatGPT's documented callback is
// https://chatgpt.com/connector_platform_oauth_redirect, but OpenAI has moved
// to generating a callback per connection, so its origins are trusted for ANY
// path rather than one exact URL - pinning a path that changes would present as
// "the connector just stops working" with nothing to point at.
//
// Origin-locked either way: a code can only ever be delivered to an assistant
// vendor's own domain, and PKCE still binds it to the request that started the
// flow. Claude's callback is stable, so it stays pinned to its exact path.
const REDIRECT_ORIGINS = ['https://chatgpt.com', 'https://chat.openai.com'];

function redirectUriAllowed(uri) {
  if (!uri) return false;
  let u;
  try { u = new URL(uri); } catch (e) { return false; }

  if (u.origin === 'https://claude.ai' && u.pathname === '/api/mcp/auth_callback') return true;
  if (REDIRECT_ORIGINS.includes(u.origin)) return true;

  // RFC 8252 loopback, for local MCP clients on an ephemeral port.
  if ((u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.protocol === 'http:') return true;

  // Exact additions without a redeploy, for an assistant we have not met yet.
  // Exact match only - this is an escape hatch, not a second allowlist.
  const extra = String(process.env.OAUTH_EXTRA_REDIRECT_URIS || '')
    .split(',').map((x) => x.trim()).filter(Boolean);
  if (extra.includes(uri)) return true;

  return false;
}

// Returns the NAME of whoever's team token this is, or null. The name is what
// gets carried through the OAuth flow, so a claude.ai session is attributable to
// a person and can be revoked by deleting one MCP_TOKENS entry.
async function teamTokenIdentity(supplied) {
  // MCP_TOKENS first, then the hashed rows in meta_access_tokens. Weak env
  // tokens are dropped and never authenticate; every comparison is over digests
  // with timingSafeEqual. See lib/guard.js and lib/tokens.js.
  return require('./tokens').identify(supplied);
}

async function teamTokenValid(supplied) {
  return (await teamTokenIdentity(supplied)) !== null;
}

// Where this deployment lives. Derived from the request so it works on preview
// URLs and a custom domain without reconfiguration.
function originOf(req) {
  // PUBLIC_ORIGIN removes the question entirely where it is set. Vercel was
  // confirmed on 30 Aug 2026 to overwrite a client-supplied x-forwarded-host
  // (a spoofed value did not reach the discovery document, and a spoofed Host
  // never reaches the function at all), so the header path below is safe on
  // this platform - but it is only safe because of the platform.
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN.replace(/\/+$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const isLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  const proto = req.headers['x-forwarded-proto'] || (isLocal ? 'http' : 'https');
  return `${proto}://${host}`;
}

// The MCP resource this deployment protects, exactly as the discovery document
// publishes it - and therefore exactly as clients send it in `resource`.
function resourceOf(req) { return `${originOf(req)}/api/mcp`; }

// Issuer and audience for every token this server mints or accepts.
function claimsFor(req) { return { iss: originOf(req), aud: resourceOf(req) }; }

// RFC 8707: a client may say which resource it wants a token for. If it does,
// it had better be this one. A trailing slash is tolerated; nothing else is.
function resourceMatches(requested, req) {
  if (requested === undefined || requested === null || requested === '') return true;
  return String(requested).replace(/\/+$/, '') === resourceOf(req);
}

module.exports = {
  sign, verify, verifyPkce, redirectUriAllowed, teamTokenValid, teamTokenIdentity, originOf, b64url,
  resourceOf, claimsFor, resourceMatches, REDIRECT_ORIGINS,
};
