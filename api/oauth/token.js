'use strict';
// Token endpoint. MUST accept application/x-www-form-urlencoded — Claude sends
// both the initial exchange and refreshes that way, and a JSON-only parser
// returns 415 and breaks the flow.
const { sign, verify, verifyPkce } = require('../../lib/oauth');

const ACCESS_TTL = 60 * 60;             // 1 hour
const REFRESH_TTL = 60 * 60 * 24 * 30;  // 30 days

function fail(res, code, description, status = 400) {
  res.status(status).json({ error: code, error_description: description });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { fail(res, 'invalid_request', 'POST required', 405); return; }

  let body = req.body;
  if (!body || typeof body !== 'object' || typeof body === 'string') {
    let raw = '';
    await new Promise((r) => { req.on('data', (c) => { raw += c; }); req.on('end', r); req.on('error', r); });
    body = Object.fromEntries(new URLSearchParams(raw));
  }

  const issue = () => {
    res.status(200).json({
      access_token: sign({ typ: 'access', scope: 'mcp' }, ACCESS_TTL),
      token_type: 'Bearer',
      expires_in: ACCESS_TTL,
      // Rotated on every refresh, as OAuth 2.1 requires for public clients.
      refresh_token: sign({ typ: 'refresh', scope: 'mcp' }, REFRESH_TTL),
      scope: 'mcp',
    });
  };

  if (body.grant_type === 'authorization_code') {
    const claims = verify(body.code, 'code');
    // invalid_grant specifically — Claude keys its retry behaviour on the code.
    if (!claims) { fail(res, 'invalid_grant', 'Authorization code is invalid or expired'); return; }
    if (body.redirect_uri && body.redirect_uri !== claims.redirect_uri) {
      fail(res, 'invalid_grant', 'redirect_uri does not match the authorization request'); return;
    }
    if (!verifyPkce(body.code_verifier, claims.code_challenge)) {
      fail(res, 'invalid_grant', 'PKCE verification failed'); return;
    }
    issue();
    return;
  }

  if (body.grant_type === 'refresh_token') {
    const claims = verify(body.refresh_token, 'refresh');
    if (!claims) { fail(res, 'invalid_grant', 'Refresh token is invalid or expired'); return; }
    issue();
    return;
  }

  fail(res, 'unsupported_grant_type', `grant_type "${body.grant_type || ''}" is not supported`);
};
