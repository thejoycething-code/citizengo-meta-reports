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
const { verify, originOf, claimsFor } = require('../lib/oauth');
const { TOOLS, callTool } = require('../mcp/tools');
const guard = require('../lib/guard');
const { corsFor } = require('../lib/origin');
const { onVercelProduction } = require('../lib/env-guard');
const { identityStillValid } = require('../lib/identity');

const SERVER_INFO = { name: 'citizengo-meta-reports', version: '1.0.0' };

// OPEN ACCESS - withdrawn.
//
// MCP_PUBLIC=true served every request without a credential. It was set on
// 30 Aug 2026 on the reasoning that the connector is read-only and the URL
// unpublished. Carlo Manuali's review of 3 Sep 2026 declined to accept that for
// production: the server advertises OAuth, so an unauthenticated 200 is a
// protocol violation as well as a policy choice, and it left the tool schemas
// and the reporting data readable by anyone holding the address.
//
// The flag still exists - the test suite needs an open server to prove that the
// closed one is a decision rather than an accident - but it is IGNORED on Vercel
// production. Setting it there changes nothing except a line in the log.
// Absence of configuration still fails closed: no tokens and no flag refuses
// everything.
//
// Read per request, not once at module load: a value captured at load time is
// untestable without reloading the module, and it hid three failures the first
// time this was written.
let warnedPublicIgnored = false;
const publicAccess = () => {
  const wanted = String(process.env.MCP_PUBLIC || '').toLowerCase() === 'true';
  if (wanted && onVercelProduction()) {
    if (!warnedPublicIgnored) {
      console.error('MCP_PUBLIC=true is set but IGNORED in production: open access was withdrawn on 3 Sep 2026. Remove the variable.');
      warnedPublicIgnored = true;
    }
    return false;
  }
  return wanted;
};

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

// Returns the name of whoever's token this is, or null. Naming the holder is
// what makes "who read what" answerable at all: previously every request was
// indistinguishable from every other.
function tokenIdentity(supplied, expect) {
  if (!supplied) return null;

  // 1. A per-person or team token from MCP_TOKENS. usableTokens drops any entry
  //    too weak to be a credential and says so in the log; identify compares
  //    SHA-256 digests with timingSafeEqual and returns the matching name.
  const name = guard.identify(supplied, guard.usableTokens(process.env.MCP_TOKENS));
  if (name) return name;

  // 2. An OAuth access token this server issued. claude.ai cannot send a fixed
  //    header on a personal account, so it goes through the OAuth flow instead.
  try {
    // Signature, expiry, type, ISSUER and AUDIENCE. A token minted for another
    // deployment that shares the signing secret is refused here.
    const claims = verify(supplied, 'access', expect);
    if (!claims) return null;
    if (!String(claims.scope || '').split(/\s+/).includes('mcp')) return null;
    // Every token this server has minted since identity binding names who
    // consented. One that does not is not ours, whatever its signature says.
    if (!claims.who) return null;
    // An OAuth session is only as alive as the identity that authorised it.
    // Re-checked on EVERY request - a name against the current MCP_TOKENS, an
    // email against the allowed Google domains and the revocation list - so
    // revoking a person ends their session on the next call rather than when
    // the refresh token happens to expire.
    return identityStillValid(claims.who) ? claims.who : null;
  } catch (e) {
    // OAUTH_SIGNING_SECRET unset - OAuth simply unavailable, static still works.
    return null;
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
  // Reporting data read by a named person must never land in a shared cache.
  // Left unset, Vercel applies "public, max-age=0, must-revalidate" - which is
  // what Carlo Manuali's review saw on every response.
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Origin is checked before anything else, the method included: a page on a
  // host we do not trust gets a 403 and no CORS grant, whatever it asked for.
  if (!corsFor(req, res, {
    methods: 'POST, OPTIONS',
    headers: 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version',
  })) {
    res.status(403).json(rpcError(null, -32000, 'Origin not allowed'));
    return;
  }

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
  if (!publicAccess() && await guard.failureLimited(source)) {
    res.setHeader('Retry-After', '600');
    res.status(429).json(rpcError(null, -32002,
      'Too many failed authentication attempts. Try again later.'));
    return;
  }

  // A credential that was SENT and is wrong is refused whatever the flag says:
  // a revoked person must find out, not be silently downgraded to anonymous.
  // Only the complete absence of a credential is served under open access.
  const identity = tokenIdentity(supplied, claimsFor(req));
  if (!identity && (supplied || !publicAccess())) {
    await guard.recordFailure(source, 'mcp');
    // 401 with WWW-Authenticate is what MCP clients expect. RFC 6750: a request
    // that sent a credential and was refused is told so with error=invalid_token;
    // one that sent none gets the bare challenge pointing at discovery.
    const challenge = [`Bearer resource_metadata="${originOf(req)}/.well-known/oauth-protected-resource"`];
    if (supplied) challenge.push('error="invalid_token"');
    res.setHeader('WWW-Authenticate', challenge.join(', '));
    res.status(401).json(rpcError(null, -32001, 'Unauthorized'));
    return;
  }
  const who = identity || 'anonymous';

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
  // Keyed on the credential when there is one - all of Claude's traffic shares
  // an egress range, so an IP key would throttle every user together - and on the
  // source when there is not. Without this, anonymous callers would share a
  // single bucket and throttle each other.
  const quotaKey = supplied ? supplied.slice(0, 24) : `anon:${source}`;
  if (rateLimited(quotaKey, messages.length)) {
    res.setHeader('Retry-After', '60');
    res.status(429).json(rpcError(null, -32002,
      `Rate limit exceeded: more than ${RATE_LIMIT} calls in a minute. Try again shortly.`));
    return;
  }

  // A request log with identity, so "who read what" is answerable. Deliberately
  // to the platform log rather than a table: this endpoint is otherwise
  // read-only, and adding a database write per request would cost latency on
  // every call to answer a question that is asked rarely.
  //
  // Records WHICH TOOL, never the arguments or the result - a search query can
  // itself be sensitive, and the point is accountability, not surveillance.
  for (const msg of messages) {
    if (msg && msg.method === 'tools/call') {
      const tool = msg.params && msg.params.name;
      console.log(JSON.stringify({
        at: new Date().toISOString(), who, tool, event: 'tools/call',
      }));
    }
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

// Exposed so the suite can prove the production override without a redeploy.
module.exports.publicAccess = publicAccess;
