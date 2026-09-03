'use strict';
// Google Workspace sign-in for the consent step.
//
// Requested 3 Sep 2026: staff should not need a token handed to them. Anyone
// with an account in an allowed Google Workspace domain (citizengo.net) can
// authorise; anyone else cannot; and someone who leaves the organisation loses
// access when their Google account does. Identity is the verified work email,
// which is what every tool call is then logged under.
//
// Standard OpenID Connect authorization-code flow, verified LOCALLY: the
// id_token's RS256 signature is checked against Google's published keys, then
// issuer, audience, expiry, nonce, email_verified and the hosted-domain claim.
// No library - Node's crypto imports a JWK directly.
//
// GOOGLE_AUTH_URL / GOOGLE_TOKEN_URL / GOOGLE_JWKS_URL / GOOGLE_ISSUERS exist so
// the suite can point at a mock Google. env-guard refuses them in production:
// any one of them redirects sign-in or accepts forged identities.

const crypto = require('crypto');
const { assertGoogleEndpointsSafe } = require('./env-guard');

const seams = () => { assertGoogleEndpointsSafe(); return process.env; };
const AUTH_URL = () => seams().GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = () => seams().GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const JWKS_URL = () => seams().GOOGLE_JWKS_URL || 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = () => String(seams().GOOGLE_ISSUERS || 'https://accounts.google.com,accounts.google.com')
  .split(',').map((s) => s.trim()).filter(Boolean);

function configured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function allowedDomains() {
  return String(process.env.ALLOWED_GOOGLE_DOMAINS || 'citizengo.net')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function callbackUrl(origin) { return `${origin}/api/oauth/google/callback`; }

function authUrl({ origin, state, nonce }) {
  const u = new URL(AUTH_URL());
  u.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID);
  u.searchParams.set('redirect_uri', callbackUrl(origin));
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'openid email');
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  // A hint to Google's account picker only. The hd CLAIM is what gets verified.
  const doms = allowedDomains();
  if (doms.length === 1) u.searchParams.set('hd', doms[0]);
  u.searchParams.set('prompt', 'select_account');
  return u.toString();
}

async function exchangeCode({ origin, code }) {
  const res = await fetch(TOKEN_URL(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: callbackUrl(origin),
      grant_type: 'authorization_code',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.id_token) {
    const e = new Error(`Google token exchange failed: ${body.error || res.status}`);
    e.code = 'GOOGLE_EXCHANGE';
    throw e;
  }
  return body.id_token;
}

// Google's signing keys, cached for an hour. Keys rotate every few days; an
// unknown kid triggers one forced refetch before it is treated as unknown.
let jwks = { keys: [], at: 0 };
async function keyFor(kid, force) {
  if (force || !jwks.keys.length || Date.now() - jwks.at > 60 * 60_000) {
    const res = await fetch(JWKS_URL());
    if (!res.ok) { const e = new Error('JWKS fetch failed'); e.code = 'GOOGLE_JWKS'; throw e; }
    jwks = { keys: (await res.json()).keys || [], at: Date.now() };
  }
  return jwks.keys.find((k) => k.kid === kid) || null;
}

function refused(reason) {
  const e = new Error(`Google sign-in refused: ${reason}`);
  e.code = 'GOOGLE_REFUSED';
  e.reason = reason;
  return e;
}

// Returns { email, sub } or throws. One check per line, so the reason that
// reaches the log says exactly which gate refused.
async function verifyIdToken(idToken, { nonce }) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw refused('malformed');
  let header; let claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (e) { throw refused('malformed'); }
  if (header.alg !== 'RS256') throw refused('alg');

  let jwk = await keyFor(header.kid);
  if (!jwk) jwk = await keyFor(header.kid, true);
  if (!jwk) throw refused('unknown key');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key,
    Buffer.from(parts[2], 'base64url'));
  if (!ok) throw refused('signature');

  const now = Math.floor(Date.now() / 1000);
  if (!ISSUERS().includes(claims.iss)) throw refused('issuer');
  if (claims.aud !== process.env.GOOGLE_CLIENT_ID) throw refused('audience');
  if (!claims.exp || claims.exp < now) throw refused('expired');
  if (!nonce || claims.nonce !== nonce) throw refused('nonce');
  if (claims.email_verified !== true) throw refused('email not verified');

  const email = String(claims.email || '').toLowerCase();
  const domain = email.split('@')[1] || '';
  if (!allowedDomains().includes(domain)) throw refused(`domain ${domain || '(none)'} not allowed`);
  // hd is Google's own statement of which Workspace the account belongs to. A
  // consumer account carrying a citizengo.net alias passes the email check and
  // carries no hd; it must not get in.
  if (String(claims.hd || '').toLowerCase() !== domain) throw refused('not a Workspace account for that domain');

  return { email, sub: claims.sub };
}

module.exports = { configured, allowedDomains, authUrl, exchangeCode, verifyIdToken, callbackUrl };
