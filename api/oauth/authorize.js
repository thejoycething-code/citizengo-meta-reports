'use strict';
// Authorization endpoint. GET renders a consent page; POST checks the team
// token and redirects back to Claude with a code.
//
// There is no user directory behind this. Consent means "prove you hold the
// shared team token", which is the same gate Claude Code uses as a bearer
// header — just wrapped in the flow Claude.ai expects.
const { sign, redirectUriAllowed, teamTokenIdentity, claimsFor, resourceMatches, REDIRECT_ORIGINS } = require('../../lib/oauth');
const { corsFor } = require('../../lib/origin');
const google = require('../../lib/google');
const cimd = require('../../lib/cimd');
const guard = require('../../lib/guard');

// The consent page collects a password, so it must not be embeddable. Without a
// framing header any site can overlay it transparently on a decoy control and
// capture the token as it is typed - and because the framed page is genuinely
// ours, its certificate and address bar survive inspection.
//
// form-action is the more valuable half: it stops the form being rewritten to
// post the token somewhere else. The page loads no scripts and no external
// assets, so a restrictive policy costs nothing here.
//
// Applied to every response this endpoint produces, including the 400s and the
// 401 that re-renders the form after a wrong token - a header set only on the
// happy path protects only the requests that were never at risk.
// form-action lists where this form may SEND the browser - and in Chromium that
// includes the 302 the browser follows after the POST. 'self' alone (a44af91)
// meant Chrome refused to follow our redirect to claude.ai after a successful
// consent: the server logged a 302, the user saw a blank page, and Claude never
// received the code. Found live on 3 Sep 2026; curl and Firefox both follow the
// redirect regardless, which is why no test caught it. So the destinations a
// code may be delivered to - exactly the redirect allowlist - are the
// destinations the form may send to, and nothing else.
function formActionSources() {
  const extras = String(process.env.OAUTH_EXTRA_REDIRECT_URIS || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((u) => { try { return new URL(u).origin; } catch (e) { return null; } })
    .filter(Boolean);
  return ["'self'", 'https://claude.ai', ...REDIRECT_ORIGINS,
    'http://localhost:*', 'http://127.0.0.1:*', ...new Set(extras)].join(' ');
}

function secureHeaders(res) {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy',
    "frame-ancestors 'none'; default-src 'none'; style-src 'unsafe-inline'; "
    + `form-action ${formActionSources()}; base-uri 'none'`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // same-origin, NOT no-referrer. Under no-referrer the Fetch standard makes a
  // browser serialise the Origin header of this page's own form POST as the
  // literal "null" - which the Origin check below then refuses. That is exactly
  // what happened on 3 Sep 2026: every consent submission was 403 "origin not
  // allowed" while curl, which sends whatever Origin it is told, passed. Same-
  // origin still sends no Referer to claude.ai on the redirect back, so the
  // state and code_challenge in this URL stay out of anyone else's logs.
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
}

const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Which of the assistant's parameters travel on to the Google link and ride
// along as hidden fields of the token form.
const PASS = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource'];

function googleHref(params) {
  const sp = new URLSearchParams();
  for (const k of PASS) if (params[k]) sp.set(k, params[k]);
  return `/api/oauth/google/start?${sp}`;
}

// Who is asking, for the consent page. A CIMD client says so in its document;
// a registered client is named from where the code will be delivered. The spec
// asks that the redirect hostname be shown clearly, so it is.
function clientLabel(params, doc) {
  let host = '';
  try { host = new URL(params.redirect_uri).hostname; } catch (e) { /* refused earlier */ }
  if (doc && doc.client_name) return { name: doc.client_name, host };
  if (/(^|\.)claude\.ai$/.test(host)) return { name: 'Claude', host };
  if (/(^|\.)(chatgpt\.com|openai\.com)$/.test(host)) return { name: 'ChatGPT', host };
  return { name: 'Your assistant', host };
}

// Validates a Client ID Metadata Document client_id when one is presented.
// Returns the document (or null for a registered client); writes the 400 and
// returns false when the document cannot be verified.
async function clientDocument(params, res) {
  if (!cimd.isClientIdUrl(params.client_id)) return null;
  try {
    return await cimd.validateClient(params.client_id, params.redirect_uri);
  } catch (e) {
    console.warn(JSON.stringify({ at: new Date().toISOString(), event: 'cimd_refused', url: e.url, reason: e.reason || e.message }));
    res.status(400).send('client metadata could not be verified');
    return false;
  }
}

function page({ params, error, client }) {
  const hidden = PASS
    .map((k) => (params[k] ? `<input type="hidden" name="${k}" value="${esc(params[k])}">` : '')).join('');
  const withGoogle = google.configured();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect CitizenGO reporting</title><style>
:root{color-scheme:light dark}
body{font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:26rem;margin:12vh auto;padding:0 1.25rem}
h1{font-size:1.25rem;margin:0 0 .25rem}
p{color:#666;font-size:.9rem}
label{display:block;font-weight:600;margin:1.25rem 0 .4rem;font-size:.9rem}
input[type=password]{width:100%;padding:.6rem .7rem;font-size:1rem;border:1px solid #ccc;border-radius:.4rem;background:transparent;color:inherit}
.btn{display:block;box-sizing:border-box;width:100%;margin-top:1rem;padding:.65rem;font-size:1rem;font-weight:600;border:0;border-radius:.4rem;background:#1d4ed8;color:#fff;text-align:center;text-decoration:none;cursor:pointer}
.btn.alt{background:transparent;color:inherit;border:1px solid #ccc;font-weight:500}
.or{margin:1.5rem 0 .25rem;text-align:center;color:#888;font-size:.8rem;text-transform:uppercase;letter-spacing:.08em}
.err{background:#fdeaea;color:#8a1c1c;border:1px solid #f3c6c6;padding:.6rem .75rem;border-radius:.4rem;font-size:.9rem}
.note{margin-top:1.5rem;font-size:.8rem;color:#888}
@media(prefers-color-scheme:dark){input[type=password],.btn.alt{border-color:#444}.err{background:#3a1d1d;color:#f3b8b8;border-color:#5a2a2a}}
</style></head><body>
<h1>Connect CitizenGO organic reporting</h1>
<p><strong>${esc(client.name)}</strong> is asking to read organic Facebook performance data for CitizenGO pages. This connection is <strong>read-only</strong>.${client.host ? ` You will be returned to <strong>${esc(client.host)}</strong>.` : ''}</p>
${error ? `<div class="err">${esc(error)}</div>` : ''}
${withGoogle ? `<a class="btn" href="${esc(googleHref(params))}">Continue with Google</a>
<p>Use your ${esc(google.allowedDomains().join(' or '))} account. Nothing to paste, nothing to remember.</p>
<div class="or">or</div>` : ''}
<form method="POST">${hidden}
<label for="t">${withGoogle ? 'Access token, if you were given one' : 'Team access token'}</label>
<input id="t" name="team_token" type="password" autocomplete="off" ${withGoogle ? '' : 'autofocus'} required>
<button type="submit" class="btn${withGoogle ? ' alt' : ''}">Allow access</button>
</form>
<p class="note">${withGoogle ? 'Either way this grants read access to post performance figures only' : 'Ask whoever set up the connector for the token. It grants read access to post performance figures only'} — it cannot post, change or delete anything.</p>
</body></html>`;
}

module.exports = async function handler(req, res) {
  secureHeaders(res);
  const q = req.query || {};

  // A consent form that any page could POST to cross-site is a form any page
  // could drive. Our own page posting to itself carries our origin; a browser
  // navigation from Claude's redirect carries none; anything else is refused.
  if (!corsFor(req, res, { methods: 'GET, POST, OPTIONS', headers: 'Content-Type' })) {
    res.status(403).send('origin not allowed'); return;
  }

  if (req.method === 'GET') {
    if (!redirectUriAllowed(q.redirect_uri)) {
      res.status(400).send('invalid redirect_uri'); return;
    }
    // PKCE is mandatory: without it a stolen code could be redeemed by anyone.
    if (q.code_challenge_method !== 'S256' || !q.code_challenge) {
      res.status(400).send('code_challenge with S256 is required'); return;
    }
    // RFC 8707: a client naming a resource must name this one.
    if (!resourceMatches(q.resource, req)) {
      res.status(400).send('resource does not match this server'); return;
    }
    const doc = await clientDocument(q, res);
    if (doc === false) return;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(page({ params: q, error: null, client: clientLabel(q, doc) }));
    return;
  }

  if (req.method !== 'POST') { res.status(405).send('method not allowed'); return; }

  let body = req.body;
  if (!body || typeof body !== 'object') {
    let raw = '';
    await new Promise((r) => { req.on('data', (c) => { raw += c; }); req.on('end', r); req.on('error', r); });
    body = Object.fromEntries(new URLSearchParams(raw));
  }

  const p = { ...q, ...body };
  if (!redirectUriAllowed(p.redirect_uri)) { res.status(400).send('invalid redirect_uri'); return; }

  // Re-checked on POST, not only on GET. A direct POST could otherwise mint a
  // code carrying no challenge. Such a code was never redeemable - verifyPkce
  // rejects an empty challenge - but refusing it here is the honest place.
  if (p.code_challenge_method !== 'S256' || !p.code_challenge) {
    res.status(400).send('code_challenge with S256 is required'); return;
  }
  if (!resourceMatches(p.resource, req)) {
    res.status(400).send('resource does not match this server'); return;
  }
  const doc = await clientDocument(p, res);
  if (doc === false) return;
  const client = clientLabel(p, doc);

  // This consent form had no throttling whatsoever, so the team token could be
  // guessed at full speed. Failures are counted by source, which a guesser
  // cannot vary by changing the token they submit.
  const source = guard.clientIp(req);
  if (await guard.failureLimited(source)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Retry-After', '600');
    res.status(429).send(page({
      params: p, client,
      error: 'Too many incorrect attempts. Wait a few minutes and try again.',
    }));
    return;
  }

  // Trimmed: a token pasted with a trailing space or newline is the token.
  const who = await teamTokenIdentity(String(p.team_token || '').trim());
  if (!who) {
    await guard.recordFailure(source, 'authorize');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(401).send(page({ params: p, client, error: 'That token was not recognised. Check it with whoever set up the connector.' }));
    return;
  }

  // Short-lived, single-use in practice because it expires in 60s. Carries the
  // PKCE challenge so /token can prove the redeemer started the flow.
  const code = sign({
    typ: 'code',
    code_challenge: p.code_challenge,
    redirect_uri: p.redirect_uri,
    // Carried so /token can refuse a code redeemed by a different client.
    client_id: p.client_id || null,
    // WHO consented. Carried through to the access and refresh tokens so a
    // claude.ai session is attributable to a person, and so deleting that
    // person's MCP_TOKENS entry revokes it on their next request. Without this
    // an OAuth session outlived the credential that authorised it.
    who,
    // Bound to this deployment: /token refuses a code minted elsewhere, and the
    // access and refresh tokens it issues carry the same issuer and audience.
    ...claimsFor(req),
  }, 60);

  const dest = new URL(p.redirect_uri);
  dest.searchParams.set('code', code);
  if (p.state) dest.searchParams.set('state', p.state);
  res.writeHead(302, { Location: dest.toString() });
  res.end();
};
