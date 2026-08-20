'use strict';
// Mints a short-lived Google OAuth access token from a service account key.
//
// Why this exists: Google access tokens last about an hour, so one cannot be
// stored as a CI secret for a nightly job. The service account JSON is the
// durable credential; this exchanges it for a fresh token on each run.
//
// Dependency-free — Node's crypto can sign RS256 directly.

const crypto = require('crypto');

const b64url = (input) => Buffer.from(input)
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Default scope is the narrowest that still allows writing to a Sheet the
// service account has been shared on. It grants no Drive-wide access.
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

async function accessTokenFromServiceAccount(keyJson, scope = SHEETS_SCOPE) {
  const key = typeof keyJson === 'string' ? JSON.parse(keyJson) : keyJson;
  if (!key.client_email || !key.private_key) {
    throw new Error('service account JSON is missing client_email or private_key');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: key.client_email,
    scope,
    aud: key.token_uri || 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = crypto.createSign('RSA-SHA256')
    .update(signingInput)
    .sign(key.private_key)
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const res = await fetch(claims.aud, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${signingInput}.${signature}`,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`token exchange failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body.access_token;
}

// Resolution order: an explicit token wins (handy for local one-offs), otherwise
// mint one from the service account.
async function resolveGoogleToken() {
  if (process.env.GOOGLE_ACCESS_TOKEN) return process.env.GOOGLE_ACCESS_TOKEN;
  const sa = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!sa) return null;
  return accessTokenFromServiceAccount(sa);
}

module.exports = { accessTokenFromServiceAccount, resolveGoogleToken, SHEETS_SCOPE };
