#!/usr/bin/env node
'use strict';
// Signs the engine in to Campaign Copilot, once, so Vercel and the Mini can
// make tracked links in replies and DMs [gaps §6]. Run on the laptop (it opens
// the browser); the sign-in is saved to engine_copilot_auth in Supabase, which
// only the service key can read. Its own Copilot client, separate from the
// laptop's copilot_mcp.py sign-in, so neither's refresh breaks the other.
//
//   SUPABASE_URL=… SUPABASE_SERVICE_KEY="$(pbpaste)" npm run -s copilot:login -- [--owner CJO]
const crypto = require('crypto');
const http = require('http');
const { execFile } = require('child_process');
const { requireSupabaseStore } = require('../lib/store');
const C = require('../lib/copilot');

const PORT = 8765;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required.');
  const at = process.argv.indexOf('--owner');
  const owner = String(at > 0 ? process.argv[at + 1] || '' : 'CJO').toUpperCase();
  if (!/^[A-Z]{2,5}$/.test(owner)) throw new Error('--owner is the initials Copilot shows for you, e.g. CJO.');
  const store = requireSupabaseStore();
  const reg = await fetch(C.BASE + '/api/mcp/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    client_name: 'CitizenGO Content Engine (tracked reply and DM links)', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'campaigns' }) }).then((r) => r.json());
  if (!reg.client_id) throw new Error('Copilot did not register the client.');
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const url = C.BASE + '/api/mcp/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, scope: 'campaigns', state, code_challenge: challenge, code_challenge_method: 'S256', resource: C.MCP });
  const got = await new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const q = Object.fromEntries(new URL(req.url, REDIRECT).searchParams);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Signed the Content Engine in to Campaign Copilot. You can close this tab.');
      if (q.code || q.error) { srv.close(); resolve(q); }
    }).listen(PORT, '127.0.0.1');
    console.log('Opening Campaign Copilot to sign the engine in:\n' + url);
    execFile('open', [url], () => {});
  });
  if (got.state !== state || !got.code) throw new Error(`Sign-in failed: ${got.error || 'no code'}`);
  const tok = await fetch(C.TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: got.code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier, resource: C.MCP }) }).then((r) => r.json());
  if (!tok.access_token) throw new Error(`Copilot gave no token: ${tok.error_description || tok.error || 'unknown'}`);
  await store.engineSaveCopilotAuth({ client_id: reg.client_id, access_token: tok.access_token, refresh_token: tok.refresh_token || null,
    expires_at: new Date(Date.now() + (Number(tok.expires_in) || 3600) * 1000).toISOString(), owner, signed_in_by: require('os').userInfo().username, updated_at: new Date().toISOString() });
  console.log(`Signed in. Tracked links will show owner ${owner}.`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
