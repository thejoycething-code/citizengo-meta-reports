'use strict';
// Google sign-in, step two: Google sends the browser back with a code. Exchange
// it, verify the id_token, and if the person belongs to an allowed Workspace
// domain mint OUR authorization code for the assistant - exactly what the
// consent page does after a correct team token, with the verified work email
// as the identity instead of a name from MCP_TOKENS.
const { sign, verify, claimsFor, originOf } = require('../../../lib/oauth');
const { corsFor } = require('../../../lib/origin');
const guard = require('../../../lib/guard');
const google = require('../../../lib/google');

const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(title, text) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>
:root{color-scheme:light dark}
body{font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:26rem;margin:12vh auto;padding:0 1.25rem}
h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#666;font-size:.95rem}
</style></head><body><h1>${esc(title)}</h1><p>${esc(text)}</p></body></html>`;
}

function headers(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy',
    "frame-ancestors 'none'; default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
}

module.exports = async function handler(req, res) {
  headers(res);
  if (!corsFor(req, res, { methods: 'GET, OPTIONS', headers: 'Content-Type' })) {
    res.status(403).send('origin not allowed'); return;
  }
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).send('method not allowed'); return; }
  if (!google.configured()) { res.status(404).send('Google sign-in is not enabled on this server'); return; }

  const q = req.query || {};
  const html = (status, title, text) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(status).send(page(title, text));
  };

  // The parked request must verify before anything Google sent is looked at.
  const parked = verify(q.state, 'gstate');
  if (!parked) { html(400, 'This sign-in link has expired', 'Go back to Claude and connect again.'); return; }
  if (q.error) { html(400, 'Google did not complete the sign-in', `Google reported: ${q.error}. Go back to Claude and try again.`); return; }
  if (!q.code) { html(400, 'Missing sign-in code', 'Go back to Claude and try again.'); return; }

  // Same brute-force posture as the token form: refusals count by source.
  const source = guard.clientIp(req);
  if (await guard.failureLimited(source)) {
    res.setHeader('Retry-After', '600');
    html(429, 'Too many attempts', 'Wait a few minutes and try again.'); return;
  }

  let who;
  try {
    const idToken = await google.exchangeCode({ origin: originOf(req), code: q.code });
    who = (await google.verifyIdToken(idToken, { nonce: parked.nonce })).email;
  } catch (e) {
    await guard.recordFailure(source, 'google');
    console.warn(JSON.stringify({ at: new Date().toISOString(), event: 'google_refused', reason: e.reason || e.code || e.message }));
    const domainProblem = e.code === 'GOOGLE_REFUSED' && /domain|Workspace/.test(e.reason || '');
    html(403, 'Sign-in refused', domainProblem
      ? `Only ${google.allowedDomains().join(', ')} Google accounts can use this connector. Sign in with your work account.`
      : 'The sign-in could not be verified. Go back to Claude and try again.');
    return;
  }

  console.log(JSON.stringify({ at: new Date().toISOString(), event: 'consent', via: 'google', who }));

  // Identical to the token path from here: a 60-second code carrying PKCE,
  // the redirect it may be redeemed at, the client, WHO, and this deployment.
  const code = sign({
    typ: 'code',
    code_challenge: parked.code_challenge,
    redirect_uri: parked.redirect_uri,
    client_id: parked.client_id,
    who,
    ...claimsFor(req),
  }, 60);

  const dest = new URL(parked.redirect_uri);
  dest.searchParams.set('code', code);
  if (parked.state) dest.searchParams.set('state', parked.state);
  res.writeHead(302, { Location: dest.toString() });
  res.end();
};
