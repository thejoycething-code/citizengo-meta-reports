'use strict';
// Serves both discovery documents. Vercel can't route a directory literally
// named ".well-known" from the api folder, so vercel.json rewrites the two
// well-known paths here and passes ?doc= to say which one is wanted.
const { originOf } = require('../../lib/oauth');
const { corsFor } = require('../../lib/origin');

module.exports = function handler(req, res) {
  const origin = originOf(req);
  const doc = (req.query && req.query.doc) || '';

  // Discovery documents are public by design and may be cached; they still do
  // not hand a CORS grant to an origin we would refuse everywhere else.
  res.setHeader('Cache-Control', 'public, max-age=300');
  if (!corsFor(req, res, { methods: 'GET, OPTIONS', headers: 'Content-Type' })) {
    res.status(403).json({ error: 'access_denied' }); return;
  }
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  if (doc === 'protected-resource') {
    // `resource` MUST match the MCP server URL exactly as the user types it
    // into Claude, path included, or discovery fails. It is also the audience
    // every issued token carries.
    res.status(200).json({
      resource: `${origin}/api/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp'],
    });
    return;
  }

  // RFC 8414 authorization server metadata.
  res.status(200).json({
    issuer: origin,
    authorization_endpoint: `${origin}/api/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // Claude registers as a PUBLIC client, so it authenticates at the token
    // endpoint with no secret.
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['mcp'],
    // Client ID Metadata Documents (lib/cimd.js). Claude picks this over
    // dynamic registration only when it is advertised AND 'none' is listed
    // above; both are true here.
    client_id_metadata_document_supported: true,
  });
};
