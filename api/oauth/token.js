'use strict';
// Token endpoint. MUST accept application/x-www-form-urlencoded — Claude sends
// both the initial exchange and refreshes that way, and a JSON-only parser
// returns 415 and breaks the flow.
const { sign, verify, verifyPkce } = require('../../lib/oauth');

const ACCESS_TTL = 60 * 60;            // 1 hour
// Seven days, not thirty.
//
// These are stateless signed JWTs, so there is no list to revoke from: a leaked
// refresh token is valid until it expires, and the only way to invalidate one is
// to rotate OAUTH_SIGNING_SECRET, which signs everybody out. Thirty days of that
// exposure buys very little - re-consent costs a user one password field - so
// the window is shortened instead.
//
// REVOCATION, written down because it is not obvious: rotate
// OAUTH_SIGNING_SECRET in Vercel and redeploy. Every outstanding access and
// refresh token stops working immediately. There is no way to revoke one person
// without revoking all of them; per-person MCP_TOKENS entries are the mechanism
// for that.
// Thirty days, not seven.
//
// Seven was chosen during the security review on the reasoning that a leaked
// refresh token cannot be revoked. That reasoning no longer holds: tokens now
// carry WHO consented, and the endpoint re-checks that name against MCP_TOKENS
// on every request, so deleting one entry ends that person's session on their
// next call. Revocation is immediate rather than a wait for expiry.
//
// Shortening it was also poorly matched to how the tool is used. This is a
// reporting connector people open after a campaign, not daily; a seven-day
// window means someone who checks in fortnightly re-consents every time, which
// is how a tool stops being used.
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

  // `who` rides along on both tokens, so every request can be attributed and
  // re-authorised against the current MCP_TOKENS.
  const issue = (who) => {
    res.status(200).json({
      access_token: sign({ typ: 'access', scope: 'mcp', who }, ACCESS_TTL),
      token_type: 'Bearer',
      expires_in: ACCESS_TTL,
      // Rotated on every refresh, as OAuth 2.1 requires for public clients.
      refresh_token: sign({ typ: 'refresh', scope: 'mcp', who }, REFRESH_TTL),
      scope: 'mcp',
    });
  };

  if (body.grant_type === 'authorization_code') {
    const claims = verify(body.code, 'code');
    // invalid_grant specifically — Claude keys its retry behaviour on the code.
    if (!claims) { fail(res, 'invalid_grant', 'Authorization code is invalid or expired'); return; }
    // Required, not merely checked when present. RFC 6749 §4.1.3 requires it
    // whenever it was in the authorization request, and it always is here -
    // making the check conditional meant omitting the parameter skipped it.
    if (!body.redirect_uri || body.redirect_uri !== claims.redirect_uri) {
      fail(res, 'invalid_grant', 'redirect_uri is required and must match the authorization request'); return;
    }
    // Bind the code to the client that requested it, so a code issued to one
    // registration cannot be redeemed by another.
    if (claims.client_id && body.client_id && body.client_id !== claims.client_id) {
      fail(res, 'invalid_grant', 'code was issued to a different client'); return;
    }
    if (!verifyPkce(body.code_verifier, claims.code_challenge)) {
      fail(res, 'invalid_grant', 'PKCE verification failed'); return;
    }
    issue(claims.who || null);
    return;
  }

  if (body.grant_type === 'refresh_token') {
    const claims = verify(body.refresh_token, 'refresh');
    if (!claims) { fail(res, 'invalid_grant', 'Refresh token is invalid or expired'); return; }
    issue(claims.who || null);
    return;
  }

  fail(res, 'unsupported_grant_type', `grant_type "${body.grant_type || ''}" is not supported`);
};
