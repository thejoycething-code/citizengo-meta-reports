'use strict';
// Campaign Copilot MCP client for the engine (https://campaigns.citizengo.org/api/mcp).
// The engine's own Copilot sign-in (made once with `npm run copilot:login`)
// lives in engine_copilot_auth, readable only with the service key, so both
// Vercel and the Mini can make tracked links. Refresh tokens may rotate on
// use: a refresh only saves if nobody else refreshed first; otherwise the
// other writer's fresh token is used.

const BASE = 'https://campaigns.citizengo.org';
const MCP = BASE + '/api/mcp';
const TOKEN_URL = BASE + '/api/mcp/oauth/token';

async function postForm(url, data, fetchImpl, timeoutMs) {
  const r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(data), signal: AbortSignal.timeout(timeoutMs) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Copilot sign-in: ${j.error_description || j.error || 'HTTP ' + r.status}`);
  return j;
}

async function accessToken(store, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const s = await store.engineCopilotAuth();
  if (!s || !s.access_token) throw Object.assign(new Error('The engine is not signed in to Campaign Copilot: run npm run copilot:login'), { code: 'COPILOT_SIGNED_OUT' });
  if (s.expires_at && Date.parse(s.expires_at) > Date.now() + 60e3) return s.access_token;
  if (!s.refresh_token) throw Object.assign(new Error('Copilot sign-in expired: run npm run copilot:login'), { code: 'COPILOT_SIGNED_OUT' });
  const tok = await postForm(TOKEN_URL, { grant_type: 'refresh_token', refresh_token: s.refresh_token, client_id: s.client_id, resource: MCP }, fetchImpl, timeoutMs).catch(async (e) => {
    // Someone else may have refreshed with the same token a moment ago.
    const again = await store.engineCopilotAuth();
    if (again && again.access_token !== s.access_token && Date.parse(again.expires_at) > Date.now()) return { reuse: again.access_token };
    throw e;
  });
  if (tok.reuse) return tok.reuse;
  await store.engineSaveCopilotAuth({ access_token: tok.access_token, refresh_token: tok.refresh_token || s.refresh_token, expires_at: new Date(Date.now() + (Number(tok.expires_in) || 3600) * 1000).toISOString(), updated_at: new Date().toISOString() }, { ifRefresh: s.refresh_token });
  return tok.access_token;
}

async function call(store, name, args, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const token = await accessToken(store, { fetchImpl, timeoutMs });
  const r = await fetchImpl(MCP, {
    method: 'POST', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + token, 'MCP-Protocol-Version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  let raw = await r.text();
  if (!r.ok) throw new Error(`Copilot HTTP ${r.status}`);
  if ((r.headers.get('content-type') || '').includes('text/event-stream')) raw = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
  const res = JSON.parse(raw.trim().split('\n').pop());
  if (res.error) throw new Error(`Copilot ${name}: ${res.error.message || JSON.stringify(res.error)}`);
  const out = res.result || {};
  if (out.isError) throw new Error(`Copilot ${name}: ${JSON.stringify(out.content).slice(0, 300)}`);
  if (out.structuredContent) return out.structuredContent;
  const text = ((out.content || []).find((c) => c.type === 'text') || {}).text || '';
  try { return JSON.parse(text); } catch (e) { return text; }
}

module.exports = { BASE, MCP, TOKEN_URL, accessToken, call };
