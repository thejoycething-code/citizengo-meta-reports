'use strict';
// MCP over HTTP, so the tools can be shared rather than run locally by each
// person with a copy of the database credentials.
//
// The seven tools in mcp/tools.js are transport-agnostic — pure functions over a
// store — so nothing about them changes here. This file is only the plumbing
// that mcp/server.js does for stdio.
//
// Auth: a bearer token per user, from MCP_TOKENS (comma-separated). Per-user
// rather than one shared secret so a single person can be revoked without
// re-issuing to everyone. There is NO anonymous access: unset MCP_TOKENS and the
// endpoint refuses everything rather than defaulting to open.
//
// Credentials: prefers SUPABASE_MCP_KEY, a key for the meta_readonly role, which
// can read the reporting tables and nothing else. Falls back to the service key
// only if that is absent — see sql/readonly-role.sql.

const { supabaseStore } = require('../lib/store');
const { verify, originOf } = require('../lib/oauth');
const { TOOLS, callTool } = require('../mcp/tools');
const guard = require('../lib/guard');

const SERVER_INFO = { name: 'citizengo-meta-reports', version: '1.0.0' };

// Sliding window per credential. PER WARM INSTANCE, not global - serverless
// gives no shared memory, and a shared store would be a database write on every
// request. Enough to stop one client hammering the database; not a hard quota.
const RATE_LIMIT = Number(process.env.MCP_RATE_LIMIT || 60);   // calls
const RATE_WINDOW_MS = 60_000;                                  // per minute
const hits = new Map();

function rateLimited(key, cost = 1) {
  const now = Date.now();
  const seen = (hits.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  for (let i = 0; i < cost; i++) seen.push(now);
  hits.set(key, seen);
  // Unbounded growth is the obvious failure here, so evict cold keys.
  if (hits.size > 500) {
    for (const [k, v] of hits) {
      if (!v.length || now - v[v.length - 1] > RATE_WINDOW_MS) hits.delete(k);
    }
  }
  return seen.length > RATE_LIMIT;
}

function tokenIsValid(supplied) {
  if (!supplied) return false;

  // 1. A static team token, as used by Claude Code and by claude.ai's
  //    static_headers option.
  // usableTokens drops any configured token too weak to be a credential and
  // says so in the log. matchesAny compares SHA-256 digests with
  // timingSafeEqual, so neither contents nor length leak through timing.
  if (guard.matchesAny(supplied, guard.usableTokens(process.env.MCP_TOKENS))) return true;

  // 2. An OAuth access token this server issued. claude.ai cannot send a fixed
  //    header on a personal account, so it goes through the OAuth flow instead.
  try {
    return !!verify(supplied, 'access');
  } catch (e) {
    // OAUTH_SIGNING_SECRET unset - OAuth simply unavailable, static still works.
    return false;
  }
}

function getStore() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_MCP_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    const e = new Error('server_misconfigured');
    e.code = 'CONFIG';
    throw e;
  }
  return supabaseStore({ url, serviceKey: key });
}

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

async function handleRpc(msg, store) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });

    case 'ping':
      return rpcResult(id, {});

    case 'tools/list':
      return rpcResult(id, {
        tools: TOOLS.map((t) => ({
          name: t.name, description: t.description, inputSchema: t.inputSchema,
        })),
      });

    case 'tools/call': {
      const name = params && params.name;
      try {
        const out = await callTool(store, name, (params && params.arguments) || {});
        return rpcResult(id, { content: [{ type: 'text', text: out.text }] });
      } catch (e) {
        if (e.code === 'UNKNOWN_TOOL') return rpcError(id, -32602, e.message);
        // Reported as a tool error, not a protocol error, so the model can
        // surface it rather than the call appearing to vanish.
        return rpcResult(id, {
          content: [{ type: 'text', text: `Tool ${name} failed: ${e.message}` }],
          isError: true,
        });
      }
    }

    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (e) { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') {
    res.status(405).json(rpcError(null, -32600, 'Use POST for MCP requests'));
    return;
  }

  const auth = req.headers.authorization || '';
  const supplied = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const source = guard.clientIp(req);

  // Checked BEFORE the credential is examined, so a source that has been
  // guessing gets nothing back that varies with the token it sent.
  if (guard.failureLimited(source)) {
    res.setHeader('Retry-After', '600');
    res.status(429).json(rpcError(null, -32002,
      'Too many failed authentication attempts. Try again later.'));
    return;
  }

  if (!tokenIsValid(supplied)) {
    guard.recordFailure(source);
    // 401 with WWW-Authenticate is what MCP clients expect for an auth failure.
    const origin = originOf(req);
    res.setHeader('WWW-Authenticate',
      `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`);
    res.status(401).json(rpcError(null, -32001, 'Unauthorized'));
    return;
  }

  const body = await readBody(req);
  if (!body) { res.status(400).json(rpcError(null, -32700, 'Parse error')); return; }

  let store;
  try {
    store = getStore();
  } catch (e) {
    res.status(500).json(rpcError(null, -32603, 'Server misconfigured'));
    return;
  }

  // Batches are permitted by JSON-RPC; handle them rather than silently taking
  // only the first message. But an uncapped batch is one request that does
  // arbitrary work: the limiter counted requests, so a 5,000-entry batch spent
  // one of sixty allowed calls and ran loadAll() five thousand times.
  const MAX_BATCH = Number(process.env.MCP_MAX_BATCH || 20);
  if (Array.isArray(body) && body.length > MAX_BATCH) {
    res.status(400).json(rpcError(null, -32600,
      `Batch too large: ${body.length} messages, maximum ${MAX_BATCH}.`));
    return;
  }
  const messages = Array.isArray(body) ? body : [body];

  // Keyed on the credential rather than IP: every request from Claude arrives
  // from Anthropic's egress range, so IP would throttle all users together.
  // Charged per MESSAGE, so a batch cannot buy extra work for one request.
  if (rateLimited(supplied.slice(0, 24), messages.length)) {
    res.setHeader('Retry-After', '60');
    res.status(429).json(rpcError(null, -32002,
      `Rate limit exceeded: more than ${RATE_LIMIT} calls in a minute. Try again shortly.`));
    return;
  }

  const replies = [];
  for (const msg of messages) {
    // Notifications carry no id and MUST NOT be answered.
    if (msg && msg.id === undefined) continue;
    replies.push(await handleRpc(msg, store));
  }

  if (!replies.length) { res.status(202).end(); return; }
  res.status(200).json(Array.isArray(body) ? replies : replies[0]);
};
