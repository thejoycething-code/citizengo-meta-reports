'use strict';
// Google sign-in, step one: park the assistant's authorization request in a
// signed, short-lived state token and send the browser to Google.
//
// Reached by a plain link from the consent page - a link, not a form, so the
// Content-Security-Policy form-action rule that bit the token form on 3 Sep
// does not apply to the redirect this endpoint issues.
const crypto = require('crypto');
const { sign, redirectUriAllowed, resourceMatches, originOf } = require('../../../lib/oauth');
const { corsFor } = require('../../../lib/origin');
const google = require('../../../lib/google');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (!corsFor(req, res, { methods: 'GET, OPTIONS', headers: 'Content-Type' })) {
    res.status(403).send('origin not allowed'); return;
  }
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).send('method not allowed'); return; }
  if (!google.configured()) { res.status(404).send('Google sign-in is not enabled on this server'); return; }

  const q = req.query || {};
  // The same gates as the consent page: a code is only ever delivered to an
  // assistant we know, only with PKCE, only for this resource.
  if (!redirectUriAllowed(q.redirect_uri)) { res.status(400).send('invalid redirect_uri'); return; }
  if (q.code_challenge_method !== 'S256' || !q.code_challenge) {
    res.status(400).send('code_challenge with S256 is required'); return;
  }
  if (!resourceMatches(q.resource, req)) { res.status(400).send('resource does not match this server'); return; }

  const nonce = crypto.randomBytes(16).toString('hex');
  // Ten minutes: long enough to pick an account, short enough that a captured
  // link is worthless by lunchtime.
  const state = sign({
    typ: 'gstate',
    nonce,
    redirect_uri: q.redirect_uri,
    state: q.state || null,
    code_challenge: q.code_challenge,
    client_id: q.client_id || null,
    resource: q.resource || null,
  }, 600);

  res.writeHead(302, { Location: google.authUrl({ origin: originOf(req), state, nonce }) });
  res.end();
};
