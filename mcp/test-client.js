#!/usr/bin/env node
'use strict';
// Minimal MCP client that drives mcp/server.js over stdio, so the protocol is
// verified rather than assumed. Run: node mcp/test-client.js
const { spawn } = require('child_process');
const path = require('path');

const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

const pending = new Map();
let buf = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const resolve = pending.get(msg.id);
    if (resolve) { pending.delete(msg.id); resolve(msg); }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

const CASES = [
  ['list_pages', {}],
  ['compare_pages', { days: 30 }],
  ['top_posts', { sort: 'beyond', limit: 3, days: 30 }],
  ['page_summary', { page_id: '434058216680321', days: 30 }],
  ['data_health', {}],
  ['top_posts', { page_id: 'does-not-exist' }],
  ['no_such_tool', {}],
];

(async () => {
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0' },
  });
  console.log('initialize -> protocolVersion', init.result.protocolVersion, '| server', init.result.serverInfo.name);
  notify('notifications/initialized');

  const list = await rpc('tools/list');
  console.log('tools/list ->', list.result.tools.map((t) => t.name).join(', '));

  for (const [name, args] of CASES) {
    const res = await rpc('tools/call', { name, arguments: args });
    if (res.error) {
      console.log(`\n=== ${name} -> JSON-RPC error ${res.error.code}: ${res.error.message}`);
      continue;
    }
    const text = res.result.content[0].text;
    console.log(`\n=== ${name}${res.result.isError ? ' (isError)' : ''} ===`);
    console.log(text.split('\n').slice(0, 12).join('\n'));
    if (text.split('\n').length > 12) console.log('  … (' + text.split('\n').length + ' lines total)');
  }
  child.stdin.end();
})();
