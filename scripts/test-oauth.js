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
// This suite deliberately submits a wrong team token. Without opting out of the
// durable failure log it wrote those failures to the production table and then
// throttled itself on the next run - the third test broken this way, because a
// shared mutable store and test isolation are fundamentally at odds.
process.env.GUARD_DURABLE = 'off';
process.env.TOKEN_STORE = 'off';                       // MCP_TOKENS only; the table has its own tests
process.env.MCP_TOKENS = 'cgo_TESTFIXTURE_9Wq4Xz7Rm2LtV5nB';
process.env.OAUTH_SIGNING_SECRET = 'test-signing-secret-not-production';

// Asserted against the definitions, not a fixed count.
const { TOOLS } = require('../mcp/tools.js');

// Google sign-in is exercised against a MOCK Google on its own port: a token
// endpoint that mints id_tokens with whatever claims the test asks for, signed
// by a keypair generated here, and a JWKS endpoint publishing the public half.
const GPORT = 5812;
const GORIGIN = `http://localhost:${GPORT}`;
process.env.GOOGLE_CLIENT_ID = 'test-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
process.env.GOOGLE_AUTH_URL = `${GORIGIN}/auth`;
process.env.GOOGLE_TOKEN_URL = `${GORIGIN}/token`;
process.env.GOOGLE_JWKS_URL = `${GORIGIN}/certs`;
process.env.GOOGLE_ISSUERS = 'https://accounts.google.com';
process.env.ALLOWED_GOOGLE_DOMAINS = 'citizengo.net';
const { publicKey: GPUB, privateKey: GPRIV } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: OTHERPRIV } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const GJWK = { ...GPUB.export({ format: 'jwk' }), kid: 'test-kid', alg: 'RS256', use: 'sig' };
let expectedNonce = null;
// The mock reads the code to decide who is signing in; each code is one scenario.
function mintIdToken(code) {
  const now = Math.floor(Date.now() / 1000);
  const base = { iss: 'https://accounts.google.com', aud: 'test-client', sub: '1001', iat: now, exp: now + 300,
    email: 'alice@citizengo.net', email_verified: true, hd: 'citizengo.net', nonce: expectedNonce };
  const variants = {
    ok: {},
    gmail: { email: 'alice@gmail.com', hd: undefined },
    alias: { email: 'alice@citizengo.net', hd: undefined },          // consumer account with a work alias
    other: { email: 'bob@other.example', hd: 'other.example' },
    unverified: { email_verified: false },
    badnonce: { nonce: 'not-the-nonce' },
    wrongaud: { aud: 'someone-else' },
    expired: { exp: now - 10 },
  };
  const claims = { ...base, ...(variants[code] || {}) };
  for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
  const key = code === 'badsig' ? OTHERPRIV : GPRIV;
  const h = b64url(JSON.stringify({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' }));
  const c = b64url(JSON.stringify(claims));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${c}`), key);
  return `${h}.${c}.${b64url(sig)}`;
}
const gmock = http.createServer(async (req, res) => {
  const url = new URL(req.url, GORIGIN);
  if (url.pathname === '/certs') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ keys: [GJWK] })); }
  if (url.pathname === '/token' && req.method === 'POST') {
    let raw = ''; for await (const ch of req) raw += ch;
    const body = Object.fromEntries(new URLSearchParams(raw));
    res.setHeader('Content-Type', 'application/json');
    if (body.client_secret !== 'test-secret' || body.grant_type !== 'authorization_code') { res.statusCode = 401; return res.end(JSON.stringify({ error: 'invalid_client' })); }
    if (body.code === 'exchangefail') { res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_grant' })); }
    return res.end(JSON.stringify({ id_token: mintIdToken(body.code), access_token: 'x', token_type: 'Bearer' }));
  }
  res.statusCode = 404; res.end('mock: no route');
});

const routes = {
  '/api/oauth/google/start': require('../api/oauth/google/start.js'),
  '/api/oauth/google/callback': require('../api/oauth/google/callback.js'),
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
  await new Promise((r) => gmock.listen(GPORT, r));

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
  const xreg = await fetch(`${ORIGIN}/api/oauth/register`, { method:'POST', headers:{'Content-Type':'application/json', Origin:'https://attacker.example'}, body: JSON.stringify({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }) });
  check('registration from an untrusted origin is refused', xreg.status === 403, `HTTP ${xreg.status}`);
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
  check('consent page renders', consent.status === 200 && /access token/i.test(await consent.text()));

  const wrongTok = await fetch(`${ORIGIN}/api/oauth/authorize?${authQ}`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({ ...Object.fromEntries(authQ), team_token:'wrong' }).toString(), redirect:'manual' });
  check('wrong team token is refused', wrongTok.status === 401, `HTTP ${wrongTok.status}`);

  const ok = await fetch(`${ORIGIN}/api/oauth/authorize?${authQ}`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({ ...Object.fromEntries(authQ), team_token:'cgo_TESTFIXTURE_9Wq4Xz7Rm2LtV5nB' }).toString(), redirect:'manual' });
  const loc = new URL(ok.headers.get('location'));
  const code = loc.searchParams.get('code');
  check('correct token redirects with a code', ok.status === 302 && !!code && loc.searchParams.get('state')==='xyz', loc.origin + loc.pathname);

  console.log('\n5. Token exchange (form-urlencoded, as Claude sends)');
  const badVerifier = await (await fetch(`${ORIGIN}/api/oauth/token`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({ grant_type:'authorization_code', code, code_verifier:'wrong-verifier', redirect_uri:'https://claude.ai/api/mcp/auth_callback' }).toString() })).json();
  check('wrong PKCE verifier gives invalid_grant', badVerifier.error === 'invalid_grant', badVerifier.error_description);

  const wrongRes = await (await fetch(`${ORIGIN}/api/oauth/token`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({ grant_type:'authorization_code', code, code_verifier: verifier, redirect_uri:'https://claude.ai/api/mcp/auth_callback', resource:'https://other.example/api/mcp' }).toString() })).json();
  check('a token request naming another resource is refused', wrongRes.error === 'invalid_target', wrongRes.error);

  const tok = await (await fetch(`${ORIGIN}/api/oauth/token`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({ grant_type:'authorization_code', code, code_verifier: verifier, redirect_uri:'https://claude.ai/api/mcp/auth_callback' }).toString() })).json();
  check('code exchanges for an access token', !!tok.access_token && tok.token_type==='Bearer' && !!tok.refresh_token, `expires_in ${tok.expires_in}`);
  const claims = JSON.parse(Buffer.from(tok.access_token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('utf8'));
  check('the access token is bound to this issuer, resource and scope',
    claims.iss === ORIGIN && claims.aud === `${ORIGIN}/api/mcp` && claims.scope === 'mcp' && !!claims.who, `${claims.iss} ${claims.aud} ${claims.scope} ${claims.who}`);

  console.log('\n6. The token actually works on the MCP endpoint');
  const call = await (await fetch(`${ORIGIN}/api/mcp`, { method:'POST', headers:{'Content-Type':'application/json', Authorization:`Bearer ${tok.access_token}`}, body:'{"jsonrpc":"2.0","id":1,"method":"tools/list"}' })).json();
  check('OAuth token authorises tools/list', !!(call.result && call.result.tools.length === TOOLS.length), call.result ? `${call.result.tools.length} tools` : JSON.stringify(call.error));
  const stat = await (await fetch(`${ORIGIN}/api/mcp`, { method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer cgo_TESTFIXTURE_9Wq4Xz7Rm2LtV5nB'}, body:'{"jsonrpc":"2.0","id":1,"method":"tools/list"}' })).json();
  check('static team token still works alongside OAuth', !!(stat.result && stat.result.tools.length === TOOLS.length));

  console.log('\n7. Refresh');
  const ref = await (await fetch(`${ORIGIN}/api/oauth/token`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({ grant_type:'refresh_token', refresh_token: tok.refresh_token }).toString() })).json();
  check('refresh issues a new access token and rotates the refresh token',
    !!ref.access_token && !!ref.refresh_token && ref.refresh_token !== tok.refresh_token);

  console.log('\n8. Google sign-in (against a mock Google)');
  {
    const gq = new URLSearchParams({
      client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256', state: 'gstate-xyz',
      resource: `${ORIGIN}/api/mcp`,
    });
    const consentG = await (await fetch(`${ORIGIN}/api/oauth/authorize?${authQ}`)).text();
    check('consent page offers Continue with Google when configured', /Continue with Google/.test(consentG) && /google\/start/.test(consentG));

    const badStart = await fetch(`${ORIGIN}/api/oauth/google/start?redirect_uri=${encodeURIComponent('https://evil.example/cb')}&code_challenge=${challenge}&code_challenge_method=S256`, { redirect: 'manual' });
    check('start refuses a redirect_uri off the allowlist', badStart.status === 400, `HTTP ${badStart.status}`);

    const start = await fetch(`${ORIGIN}/api/oauth/google/start?${gq}`, { redirect: 'manual' });
    const gloc = new URL(start.headers.get('location'));
    check('start sends the browser to Google with hd, nonce and a signed state',
      start.status === 302 && gloc.origin === GORIGIN && gloc.searchParams.get('hd') === 'citizengo.net'
      && !!gloc.searchParams.get('nonce') && !!gloc.searchParams.get('state')
      && gloc.searchParams.get('redirect_uri') === `${ORIGIN}/api/oauth/google/callback`, gloc.origin + gloc.pathname);
    const gstate = gloc.searchParams.get('state');
    expectedNonce = gloc.searchParams.get('nonce');

    let srcN = 0;
    const cb = (code, state = gstate) => fetch(`${ORIGIN}/api/oauth/google/callback?code=${code}&state=${encodeURIComponent(state)}`,
      { redirect: 'manual', headers: { 'x-vercel-forwarded-for': `198.18.5.${++srcN}` } });
    const MCPH = { 'Content-Type': 'application/json', 'x-vercel-forwarded-for': '198.18.9.1' };

    const good = await cb('ok');
    const back = good.status === 302 ? new URL(good.headers.get('location')) : null;
    check('a verified citizengo.net Workspace account is redirected back to Claude with a code',
      !!back && back.origin === 'https://claude.ai' && !!back.searchParams.get('code') && back.searchParams.get('state') === 'gstate-xyz',
      `HTTP ${good.status}`);

    for (const [code, why] of [['gmail', 'a gmail.com account'], ['alias', 'a consumer account carrying a work alias (no hd)'],
      ['other', 'another Workspace domain'], ['unverified', 'an unverified email'], ['badnonce', 'a nonce mismatch'],
      ['wrongaud', 'an id_token for another client'], ['expired', 'an expired id_token'], ['badsig', 'a forged signature'],
      ['exchangefail', 'a failed code exchange']]) {
      const r = await cb(code);
      check(`refuses ${why}`, r.status === 403, `HTTP ${r.status}`);
    }
    const tampered = await cb('ok', gstate.slice(0, -2) + 'xx');
    check('a tampered state is refused before Google is contacted', tampered.status === 400, `HTTP ${tampered.status}`);

    const gtok = await (await fetch(`${ORIGIN}/api/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code'), code_verifier: verifier,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback', client_id: reg.client_id }).toString() })).json();
    const gclaims = JSON.parse(Buffer.from((gtok.access_token || '..').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    check('the access token names the verified work email', gclaims.who === 'alice@citizengo.net', gclaims.who);
    const gcall = await (await fetch(`${ORIGIN}/api/mcp`, { method: 'POST', headers: { ...MCPH, Authorization: `Bearer ${gtok.access_token}` }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' })).json();
    check('a Google-identity token authorises tools/list', !!(gcall.result && gcall.result.tools.length === TOOLS.length));
    const gref = await (await fetch(`${ORIGIN}/api/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: gtok.refresh_token }).toString() })).json();
    check('and refreshes', !!gref.access_token);

    process.env.MCP_REVOKED_EMAILS = 'Alice@CitizenGO.net';
    const revoked = await fetch(`${ORIGIN}/api/mcp`, { method: 'POST', headers: { ...MCPH, Authorization: `Bearer ${gtok.access_token}` }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
    check('adding the email to MCP_REVOKED_EMAILS ends the session on the next call (case-insensitive)', revoked.status === 401, `HTTP ${revoked.status}`);
    const revokedRef = await (await fetch(`${ORIGIN}/api/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: gref.refresh_token }).toString() })).json();
    check('and its refresh token can no longer be renewed', revokedRef.error === 'invalid_grant', revokedRef.error);
    delete process.env.MCP_REVOKED_EMAILS;

    const saved = process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_ID;
    const off = await fetch(`${ORIGIN}/api/mcp`, { method: 'POST', headers: { ...MCPH, Authorization: `Bearer ${gtok.access_token}` }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
    check('turning Google sign-in off ends every Google session', off.status === 401, `HTTP ${off.status}`);
    const offStart = await fetch(`${ORIGIN}/api/oauth/google/start?${gq}`, { redirect: 'manual' });
    check('and the start endpoint says so', offStart.status === 404, `HTTP ${offStart.status}`);
    process.env.GOOGLE_CLIENT_ID = saved;
    const stillStatic = await (await fetch(`${ORIGIN}/api/mcp`, { method: 'POST', headers: { ...MCPH, Authorization: 'Bearer cgo_TESTFIXTURE_9Wq4Xz7Rm2LtV5nB' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' })).json();
    check('team tokens are unaffected by any of it', !!stillStatic.result);
  }

  server.close(); gmock.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
