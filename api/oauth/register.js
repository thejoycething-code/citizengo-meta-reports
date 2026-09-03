'use strict';
// Dynamic Client Registration (RFC 7591).
//
// Every client gets a signed client_id rather than a stored record. There is
// nothing to look up later: the client is public, PKCE proves possession of the
// authorization request, and the consent step proves the person held the team
// token. Storing a registration table would add a database write per connection
// and protect nothing extra.
const { sign, redirectUriAllowed } = require('../../lib/oauth');
const { corsFor } = require('../../lib/origin');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!corsFor(req, res, { methods: 'POST, OPTIONS', headers: 'Content-Type' })) {
    res.status(403).json({ error: 'access_denied', error_description: 'origin not allowed' }); return;
  }
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'invalid_request' }); return; }

  // RFC 7591 registration is application/json, unlike the token endpoint.
  let body = req.body;
  if (!body || typeof body !== 'object') {
    let raw = '';
    await new Promise((r) => { req.on('data', (c) => { raw += c; }); req.on('end', r); req.on('error', r); });
    try { body = JSON.parse(raw || '{}'); } catch (e) { body = {}; }
  }

  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (!redirectUris.length || !redirectUris.every(redirectUriAllowed)) {
    res.status(400).json({
      error: 'invalid_redirect_uri',
      error_description: 'redirect_uris must be an assistant callback we recognise (claude.ai, chatgpt.com) or an http loopback address',
    });
    return;
  }

  const clientId = sign({ typ: 'client', redirect_uris: redirectUris }, 60 * 60 * 24 * 365);

  res.status(201).json({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_name: body.client_name || 'MCP client',
  });
};
