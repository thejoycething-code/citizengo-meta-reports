'use strict';
// Authorization endpoint. GET renders a consent page; POST checks the team
// token and redirects back to Claude with a code.
//
// There is no user directory behind this. Consent means "prove you hold the
// shared team token", which is the same gate Claude Code uses as a bearer
// header — just wrapped in the flow Claude.ai expects.
const { sign, verify, redirectUriAllowed, teamTokenValid } = require('../../lib/oauth');

const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page({ params, error }) {
  const hidden = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource']
    .map((k) => (params[k] ? `<input type="hidden" name="${k}" value="${esc(params[k])}">` : '')).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect CitizenGO reporting</title><style>
:root{color-scheme:light dark}
body{font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:26rem;margin:12vh auto;padding:0 1.25rem}
h1{font-size:1.25rem;margin:0 0 .25rem}
p{color:#666;font-size:.9rem}
label{display:block;font-weight:600;margin:1.5rem 0 .4rem;font-size:.9rem}
input[type=password]{width:100%;padding:.6rem .7rem;font-size:1rem;border:1px solid #ccc;border-radius:.4rem;background:transparent;color:inherit}
button{margin-top:1rem;width:100%;padding:.65rem;font-size:1rem;font-weight:600;border:0;border-radius:.4rem;background:#1d4ed8;color:#fff;cursor:pointer}
.err{background:#fdeaea;color:#8a1c1c;border:1px solid #f3c6c6;padding:.6rem .75rem;border-radius:.4rem;font-size:.9rem}
.note{margin-top:1.5rem;font-size:.8rem;color:#888}
@media(prefers-color-scheme:dark){input[type=password]{border-color:#444}.err{background:#3a1d1d;color:#f3b8b8;border-color:#5a2a2a}}
</style></head><body>
<h1>Connect CitizenGO organic reporting</h1>
<p>Claude is asking to read organic Facebook performance data for CitizenGO pages. This connection is <strong>read-only</strong>.</p>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<form method="POST">${hidden}
<label for="t">Team access token</label>
<input id="t" name="team_token" type="password" autocomplete="off" autofocus required placeholder="cgo_…">
<button type="submit">Allow access</button>
</form>
<p class="note">Ask whoever set up the connector for the token. It grants read access to post performance figures only — it cannot post, change or delete anything.</p>
</body></html>`;
}

module.exports = async function handler(req, res) {
  const q = req.query || {};

  if (req.method === 'GET') {
    if (!redirectUriAllowed(q.redirect_uri)) {
      res.status(400).send('invalid redirect_uri'); return;
    }
    // PKCE is mandatory: without it a stolen code could be redeemed by anyone.
    if (q.code_challenge_method !== 'S256' || !q.code_challenge) {
      res.status(400).send('code_challenge with S256 is required'); return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(page({ params: q, error: null }));
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

  if (!teamTokenValid(p.team_token)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(401).send(page({ params: p, error: 'That token was not recognised. Check it with whoever set up the connector.' }));
    return;
  }

  // Short-lived, single-use in practice because it expires in 60s. Carries the
  // PKCE challenge so /token can prove the redeemer started the flow.
  const code = sign({
    typ: 'code',
    code_challenge: p.code_challenge,
    redirect_uri: p.redirect_uri,
  }, 60);

  const dest = new URL(p.redirect_uri);
  dest.searchParams.set('code', code);
  if (p.state) dest.searchParams.set('state', p.state);
  res.writeHead(302, { Location: dest.toString() });
  res.end();
};
