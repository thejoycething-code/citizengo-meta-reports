'use strict';
// X OAuth 2.0 (Authorization Code with PKCE) and the sealing of refresh tokens.
//
// Why user-context OAuth: the metric groups that matter (url_link_clicks,
// profile clicks, the organic/promoted split) are served only to the account
// that owns the posts, so each account holder must authorise once - the same
// one-click step Meta page owners took. offline.access gives a refresh token.
//
// Why SEALED: X refresh tokens ROTATE on every refresh, so they cannot live in a
// GitHub secret. They live in Supabase (x_oauth_tokens), and the callback that
// writes them runs on Vercel, alongside the public MCP endpoint. A refresh
// token in the clear there would mean a compromise of the connector also hands
// over every account's credentials. So the callback seals each token to a
// PUBLIC key and only the collector (GitHub Actions) holds the PRIVATE key.
// Vercel can write credentials it cannot read.
//
// Sealed box: X25519 ephemeral ECDH -> HKDF-SHA256 -> AES-256-GCM. Node's own
// crypto, no dependencies. Blob layout, base64: ephemeralPub(32) | iv(12) |
// tag(16) | ciphertext. The collector re-seals a rotated refresh token with the
// public key it derives from its private key, so it never needs the public one
// configured separately.
//
// Endpoints per docs.x.com (8 Sep 2026). Overridable ONLY for the test suite;
// lib/env-guard.js refuses the override in production runtimes.

const crypto = require('crypto');

const AUTHORIZE_URL = () => process.env.X_AUTHORIZE_URL || 'https://x.com/i/oauth2/authorize';
const TOKEN_URL = () => process.env.X_TOKEN_URL || 'https://api.x.com/2/oauth2/token';
const REVOKE_URL = () => process.env.X_REVOKE_URL || 'https://api.x.com/2/oauth2/revoke';

// Read-only, plus offline.access for the refresh token. Nothing that can write.
const SCOPES = ['tweet.read', 'users.read', 'offline.access'];

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------
function pkcePair() {
  const verifier = b64url(crypto.randomBytes(48));       // 64 chars, within 43-128
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function authorizeUrl({ clientId, redirectUri, state, challenge, scopes = SCOPES }) {
  const u = new URL(AUTHORIZE_URL());
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', scopes.join(' '));
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

// Public clients send client_id in the body; confidential clients authenticate
// with Basic. X supports both; which one depends on how the app was created.
function tokenHeaders({ clientId, clientSecret }) {
  const h = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (clientSecret) h.Authorization = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  return h;
}

async function postForm(url, params, headers) {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(url, { method: 'POST', headers, body });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = { raw: text.slice(0, 300) }; }
  return { ok: res.ok, status: res.status, body: json };
}

// Returns { access_token, refresh_token, expires_in, scope } or throws with a
// message safe to log (never the code, never a token).
async function exchangeCode({ clientId, clientSecret, redirectUri, code, verifier }) {
  const params = { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier };
  if (!clientSecret) params.client_id = clientId;
  const r = await postForm(TOKEN_URL(), params, tokenHeaders({ clientId, clientSecret }));
  if (!r.ok || !r.body || !r.body.access_token) {
    const why = r.body && (r.body.error_description || r.body.error) || `HTTP ${r.status}`;
    throw Object.assign(new Error(`token exchange failed: ${why}`), { code: 'EXCHANGE_FAILED', status: r.status });
  }
  return r.body;
}

// Rotating: the response carries a NEW refresh token and the old one is dead.
// Callers must persist the new one before doing anything else with it.
async function refresh({ clientId, clientSecret, refreshToken }) {
  const params = { grant_type: 'refresh_token', refresh_token: refreshToken };
  if (!clientSecret) params.client_id = clientId;
  const r = await postForm(TOKEN_URL(), params, tokenHeaders({ clientId, clientSecret }));
  if (!r.ok || !r.body || !r.body.access_token) {
    const why = r.body && (r.body.error_description || r.body.error) || `HTTP ${r.status}`;
    // invalid_grant is X saying the refresh token is no longer valid: revoked
    // by the holder, rotated by someone else, or a password change. That is a
    // re-authorisation, not a retry.
    const fatal = r.body && r.body.error === 'invalid_grant';
    throw Object.assign(new Error(`token refresh failed: ${why}`), {
      code: fatal ? 'REAUTHORIZE' : 'REFRESH_FAILED', status: r.status,
    });
  }
  return r.body;
}

async function revoke({ clientId, clientSecret, token }) {
  const params = { token, token_type_hint: 'refresh_token' };
  if (!clientSecret) params.client_id = clientId;
  const r = await postForm(REVOKE_URL(), params, tokenHeaders({ clientId, clientSecret }));
  return r.ok;
}

// ---------------------------------------------------------------------------
// Sealed box
// ---------------------------------------------------------------------------
function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

function publicKeyOf(privatePem) {
  return crypto.createPublicKey(crypto.createPrivateKey(privatePem)).export({ type: 'spki', format: 'pem' });
}

const INFO = Buffer.from('citizengo-x-refresh-token-v1');

function deriveKey(shared, ephemeralPubRaw, recipientPubRaw) {
  // Both public keys in the salt bind the key to this exact pair, so a blob
  // cannot be re-targeted at another recipient.
  const salt = Buffer.concat([ephemeralPubRaw, recipientPubRaw]);
  return Buffer.from(crypto.hkdfSync('sha256', shared, salt, INFO, 32));
}

function rawPublic(keyObject) {
  // SPKI for X25519 is a fixed 12-byte prefix then the 32-byte key.
  return keyObject.export({ type: 'spki', format: 'der' }).subarray(-32);
}

function seal(recipientPublicPem, plaintext) {
  const recipient = crypto.createPublicKey(recipientPublicPem);
  const eph = crypto.generateKeyPairSync('x25519');
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: recipient });
  const ephRaw = rawPublic(eph.publicKey);
  const key = deriveKey(shared, ephRaw, rawPublic(recipient));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([ephRaw, iv, tag, ct]).toString('base64');
}

function open(recipientPrivatePem, blob) {
  const buf = Buffer.from(String(blob), 'base64');
  if (buf.length < 32 + 12 + 16 + 1) throw new Error('sealed blob too short');
  const ephRaw = buf.subarray(0, 32);
  const iv = buf.subarray(32, 44);
  const tag = buf.subarray(44, 60);
  const ct = buf.subarray(60);
  const priv = crypto.createPrivateKey(recipientPrivatePem);
  const ephPub = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), ephRaw]),
    format: 'der', type: 'spki',
  });
  const shared = crypto.diffieHellman({ privateKey: priv, publicKey: ephPub });
  const key = deriveKey(shared, ephRaw, rawPublic(crypto.createPublicKey(priv)));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Invites. The operator mints a link per account; the link carries a signed,
// expiring statement of WHICH account is being connected and as WHAT kind, so
// the authorise endpoint needs no login of its own and a stray link cannot
// enrol an arbitrary account under a chosen label.
// ---------------------------------------------------------------------------
function signInvite(secret, { label, kind = 'organisation', country = null, days = 7, by = null }) {
  const payload = {
    label, kind, country, by,
    exp: Date.now() + days * 86_400_000,
    nonce: b64url(crypto.randomBytes(8)),
  };
  const body = b64url(JSON.stringify(payload));
  const mac = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  return `${body}.${mac}`;
}

function verifyInvite(secret, token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const expect = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  const a = Buffer.from(mac); const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!payload || !payload.exp || payload.exp < Date.now()) return null;
  if (!['organisation', 'spokesperson'].includes(payload.kind)) return null;
  return payload;
}

module.exports = {
  SCOPES, AUTHORIZE_URL, TOKEN_URL,
  pkcePair, authorizeUrl, exchangeCode, refresh, revoke,
  generateKeyPair, publicKeyOf, seal, open,
  signInvite, verifyInvite,
};
