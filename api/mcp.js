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
const { TOOLS } = require('../mcp/tools');

const SERVER_INFO = { name: 'citizengo-meta-reports', version: '1.0.0' };

function tokenIsValid(supplied) {
  const configured = String(process.env.MCP_TOKENS || '')
    .split(',').map((t) => t.trim()).filter(Boolean);
  if (!configured.length) return false;      // never default to open
  if (!supplied) return false;
  // Constant-time-ish: compare against all, do not early-exit on first mismatch.
  return configured.reduce((ok, t) => (t === supplied ? true : ok), false);
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
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
      try {
        const out = await tool.handler(store, (params && params.arguments) || {});
        return rpcResult(id, { content: [{ type: 'text', text: out.text }] });
      } catch (e) {
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
  if (!tokenIsValid(supplied)) {
    // 401 with WWW-Authenticate is what MCP clients expect for an auth failure.
    res.setHeader('WWW-Authenticate', 'Bearer');
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
  // only the first message.
  const messages = Array.isArray(body) ? body : [body];
  const replies = [];
  for (const msg of messages) {
    // Notifications carry no id and MUST NOT be answered.
    if (msg && msg.id === undefined) continue;
    replies.push(await handleRpc(msg, store));
  }

  if (!replies.length) { res.status(202).end(); return; }
  res.status(200).json(Array.isArray(body) ? replies : replies[0]);
};
