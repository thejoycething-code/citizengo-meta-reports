#!/usr/bin/env node
'use strict';
// Drives api/mcp.js over real HTTP, so the transport is verified rather than
// assumed — the same reason the stdio server has a test client.
//
// Checks the security posture explicitly: no token, wrong token, and the
// refuse-by-default behaviour when MCP_TOKENS is unset.

const http = require('http');
const path = require('path');
const { loadEnv } = require('../lib/graph');
loadEnv();

const PORT = 5808;
const GOOD = 'test-token-alice';
process.env.MCP_TOKENS = `${GOOD},test-token-bob`;

const handler = require(path.join(__dirname, '..', 'api', 'mcp.js'));

let pass = 0; let fail = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

async function call(body, token, method = 'POST') {
  const res = await fetch(`http://localhost:${PORT}/api/mcp`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch (e) { json = text; } }
  return { status: res.status, body: json };
}

async function main() {
  const server = http.createServer((req, res) => {
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    handler(req, res);
  });
  await new Promise((r) => server.listen(PORT, r));

  console.log('\n1. Authentication');
  const noAuth = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  check('no token is rejected', noAuth.status === 401, `HTTP ${noAuth.status}`);
  const badAuth = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'not-a-real-token');
  check('wrong token is rejected', badAuth.status === 401, `HTTP ${badAuth.status}`);

  console.log('\n2. Protocol');
  const init = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, GOOD);
  check('initialize', init.status === 200 && init.body.result.serverInfo.name === 'citizengo-meta-reports',
    init.body.result && init.body.result.protocolVersion);
  const list = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, GOOD);
  const names = list.body.result ? list.body.result.tools.map((t) => t.name) : [];
  check('tools/list returns all 7', names.length === 7, names.join(', '));

  console.log('\n3. A real tool call against live data');
  const call1 = await call({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'list_pages', arguments: {} },
  }, GOOD);
  const text = call1.body.result && call1.body.result.content[0].text;
  check('list_pages returns page data', !!text && /Pages currently collected/.test(text),
    text ? text.split('\n')[0] : 'no text');

  console.log('\n4. Notifications and batches');
  const notif = await call({ jsonrpc: '2.0', method: 'notifications/initialized' }, GOOD);
  check('notification gets 202 and no body', notif.status === 202, `HTTP ${notif.status}`);
  const batch = await call([
    { jsonrpc: '2.0', id: 10, method: 'ping' },
    { jsonrpc: '2.0', id: 11, method: 'ping' },
  ], GOOD);
  check('batch returns an array of replies', Array.isArray(batch.body) && batch.body.length === 2,
    Array.isArray(batch.body) ? `${batch.body.length} replies` : typeof batch.body);

  console.log('\n5. Refuses by default when unconfigured');
  const saved = process.env.MCP_TOKENS;
  process.env.MCP_TOKENS = '';
  const unset = await call({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, GOOD);
  check('no MCP_TOKENS set means everything is refused', unset.status === 401,
    `HTTP ${unset.status} — must never default to open`);
  process.env.MCP_TOKENS = saved;

  console.log('\n6. Unknown tool');
  const bad = await call({
    jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope', arguments: {} },
  }, GOOD);
  check('unknown tool returns a JSON-RPC error', !!(bad.body.error && bad.body.error.code === -32602),
    bad.body.error && bad.body.error.message);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
