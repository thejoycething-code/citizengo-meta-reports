#!/usr/bin/env node
'use strict';
// MCP server over stdio, so campaigners can ask Claude directly:
//   "which of our posts did best last month?"
//   "how did CitizenGO Italia do compared to the others?"
//
// Deliberately tools rather than a database connection. The metrics table is
// append-only and uses NULL for "Meta refused this metric", so raw SQL invites
// three specific, silent errors — double-counting across daily snapshots,
// treating suppressed metrics as zeros, and averaging where the median is the
// honest statistic. See mcp/tools.js.
//
// No dependencies: JSON-RPC 2.0 over newline-delimited stdin/stdout.
// Everything diagnostic goes to stderr — stdout carries protocol only.
//
// Source: Supabase when SUPABASE_URL/SUPABASE_SERVICE_KEY are set, else the
// local NDJSON written by the collector.

const path = require('path');
const { loadEnv } = require('../lib/graph');
const { fileStore, supabaseStore } = require('../lib/store');
const { TOOLS } = require('./tools');

loadEnv();

const store = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? supabaseStore({ url: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_KEY })
  : fileStore({ dir: path.join(__dirname, '..', 'data') });

const SERVER_INFO = { name: 'citizengo-meta-reports', version: '0.1.0' };
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function result(id, value) { send({ jsonrpc: '2.0', id, result: value }); }
function failure(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;

  // Notifications have no id and must never be answered.
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      // Echo the client's protocol version — this server is simple enough to
      // speak any of them, and echoing avoids a version mismatch handshake.
      return result(id, {
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });

    case 'notifications/initialized':
    case 'initialized':
      return; // nothing to acknowledge

    case 'ping':
      return result(id, {});

    case 'tools/list':
      return result(id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });

    case 'tools/call': {
      const name = params && params.name;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return failure(id, -32602, `Unknown tool: ${name}`);
      try {
        const out = await tool.handler(store, (params && params.arguments) || {});
        return result(id, { content: [{ type: 'text', text: out.text }] });
      } catch (e) {
        log('tool error', name, e.stack || e.message);
        // Reported as a tool-level error so the model can surface it rather than
        // silently presenting an empty result as "no posts found".
        return result(id, {
          content: [{ type: 'text', text: `Tool ${name} failed: ${e.message}` }],
          isError: true,
        });
      }
    }

    default:
      if (isNotification) return;
      return failure(id, -32601, `Method not found: ${method}`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      log('bad JSON on stdin:', line.slice(0, 120));
      continue;
    }
    try {
      await handle(msg);
    } catch (e) {
      log('handler crashed:', e.stack || e.message);
      if (msg && msg.id !== undefined) failure(msg.id, -32603, 'Internal error');
    }
  }
});

process.stdin.on('end', () => process.exit(0));
log(`citizengo-meta-reports MCP ready (source=${store.name})`);
