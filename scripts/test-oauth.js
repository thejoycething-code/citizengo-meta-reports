#!/usr/bin/env node
'use strict';
// Walks the whole OAuth flow the way Claude does: discovery, dynamic client
// registration, consent, code exchange with PKCE, an authenticated MCP call, and
// a refresh. Also asserts the failure paths, because an auth server that only
// works on the happy path is not an auth server.

const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { loadEnv } = require('../lib/graph');
loadEnv();

const PORT = 5810;
const ORIGIN = `http://localhost:${PORT}`;
process.env.MCP_TOKENS = 'cgo_team_shared_2026';
process.env.OAUTH_SIGNING_SECRET = 'test-signing-secret-not-production';

// Asserted against the definitions, not a fixed count.
const { TOOLS } = require('../mcp/tools.js');

const routes = {
  '/api/oauth/metadata': require('../api/oauth/metadata.js'),
  '/api/oauth/register': require('../api/oauth/register.js'),
  '/api/oauth/authorize': require('../api/oauth/authorize.js'),
  '/api/oauth/token': require('../api/oauth/token.js'),
  '/api/mcp': require('../api/mcp.js'),
};

let pass = 0; let fail = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

async function main() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, ORIGIN);
    req.query = Object.fromEntries(u.searchParams);
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(o)); };
    res.send = (t) => res.end(t);
    const h = routes[u.pathname];
    if (!h) { res.statusCode = 404; return res.end('no route'); }
    h(req, res);
  });
  await new Promise((r) => server.listen(PORT, r));

  console.log('\n1. Discovery');
  const prm = await (await fetch(`${ORIGIN}/api/oauth/metadata?doc=protected-resource`)).json();
  check('protected resource metadata', prm.resource === `${ORIGIN}/api/mcp`, prm.resource);
  const asm = await (await fetch(`${ORIGIN}/api/oauth/metadata?doc=authorization-server`)).json();
  check('authorization server metadata advertises S256',
    asm.code_challenge_methods_supported.includes('S256') && asm.token_endpoint_auth_methods_supported.includes('none'),
    asm.issuer);

  console.log('\n2. The 401 points at discovery');
  const un = await fetch(`${ORIGIN}/api/mcp`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  const wa = un.headers.get('www-authenticate') || '';
  check('401 carries resource_metadata', un.status === 401 && /resource_metadata=/.test(wa), wa.slice(0, 78));

  console.log('\n3. Dynamic client registration');
  const badReg = await fetch(`${ORIGIN}/api/oauth/register`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ redirect_uris: ['https://evil.example.com/cb'] }) });
  check('rejects a redirect_uri that is not Claude', badReg.status === 400, `HTTP ${badReg.status}`);
  const reg = await (await fetch(`${ORIGIN}/api/oauth/register`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name:'Claude' }) })).json();
  check('registers a client', !!reg.client_id, `auth method: ${reg.token_endpoint_auth_method}`);

  console.log('\n4. Consent and PKCE');
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const authQ = new URLSearchParams({
    client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz',
  });
  const noPkce = await fetch(`${ORIGIN}/api/oauth/authorize?client_id=x&redirect_uri=${encodeURIComponent('https://claude.ai/api/mcp/auth_callback')}`);
  check('authorize refuses without PKCE', noPkce.status === 400, `HTTP ${noPkce.status}`);
  const consent = await fetch(`${ORIGIN}/api/oauth/authorize?${authQ}`);
  check('consent page renders', consent.status === 200 && /team access token/i.test(await consent.text()));

  const wrongTok = await fetch(`${ORIGIN}/api/oauth/authorize?${authQ}`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({ ...Object.fromEntries(authQ), team_token:'wrong' }).toString(), redirect:'manual' });
  check('wrong team token is refused', wrongTok.status === 401, `HTTP ${wrongTok.status}`);

  const ok = await fetch(`${ORIGIN}/api/oauth/authorize?${authQ}`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({ ...Object.fromEntries(authQ), team_token:'cgo_team_shared_2026' }).toString(), redirect:'manual' });
  const loc = new URL(ok.headers.get('location'));
  const code = loc.searchParams.get('code');
  check('correct token redirects with a code', ok.status === 302 && !!code && loc.searchParams.get('state')==='xyz', loc.origin + loc.pathname);

  console.log('\n5. Token exchange (form-urlencoded, as Claude sends)');
  const badVerifier = await (await fetch(`${ORIGIN}/api/oauth/token`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({ grant_type:'authorization_code', code, code_verifier:'wrong-verifier', redirect_uri:'https://claude.ai/api/mcp/auth_callback' }).toString() })).json();
  check('wrong PKCE verifier gives invalid_grant', badVerifier.error === 'invalid_grant', badVerifier.error_description);

  const tok = await (await fetch(`${ORIGIN}/api/oauth/token`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({ grant_type:'authorization_code', code, code_verifier: verifier, redirect_uri:'https://claude.ai/api/mcp/auth_callback' }).toString() })).json();
  check('code exchanges for an access token', !!tok.access_token && tok.token_type==='Bearer' && !!tok.refresh_token, `expires_in ${tok.expires_in}`);

  console.log('\n6. The token actually works on the MCP endpoint');
  const call = await (await fetch(`${ORIGIN}/api/mcp`, { method:'POST', headers:{'Content-Type':'application/json', Authorization:`Bearer ${tok.access_token}`}, body:'{"jsonrpc":"2.0","id":1,"method":"tools/list"}' })).json();
  check('OAuth token authorises tools/list', !!(call.result && call.result.tools.length === TOOLS.length), call.result ? `${call.result.tools.length} tools` : JSON.stringify(call.error));
  const stat = await (await fetch(`${ORIGIN}/api/mcp`, { method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer cgo_team_shared_2026'}, body:'{"jsonrpc":"2.0","id":1,"method":"tools/list"}' })).json();
  check('static team token still works alongside OAuth', !!(stat.result && stat.result.tools.length === TOOLS.length));

  console.log('\n7. Refresh');
  const ref = await (await fetch(`${ORIGIN}/api/oauth/token`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({ grant_type:'refresh_token', refresh_token: tok.refresh_token }).toString() })).json();
  check('refresh issues a new access token and rotates the refresh token',
    !!ref.access_token && !!ref.refresh_token && ref.refresh_token !== tok.refresh_token);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
