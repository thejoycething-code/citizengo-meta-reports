#!/usr/bin/env node
'use strict';
// Regression tests for the controls added after the 30 Aug 2026 security review.
//
// Every case here maps to a finding. They exist because the suite that already
// passed had no security cases at all: it verified that the tools answered, not
// that the door was shut. All three findings fixed here were live in production
// while every test was green.

const http = require('http');
const path = require('path');

const PORT = 5811;
const ROOT = path.join(__dirname, '..');

// A token that satisfies the strength rule: 24+ chars, three character classes,
// plenty of distinct characters.
const STRONG = 'cgo_Kd8vQ2mXpL7nRt4wYzB6hJ3s';
// The shape that was live in production until this review: twenty characters,
// one character class, dictionary words.
const WEAK = 'cgo_team_shared_2026';

process.env.MCP_TOKENS = STRONG;
process.env.SUPABASE_URL = 'http://localhost:1';       // never reached; auth fails first
process.env.SUPABASE_SERVICE_KEY = 'unused';
process.env.AUTH_FAIL_LIMIT = '5';
process.env.MCP_MAX_BATCH = '20';

const handler = require(path.join(ROOT, 'api', 'mcp.js'));
const guard = require(path.join(ROOT, 'lib', 'guard.js'));

let pass = 0; let fail = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

// Each request declares its own source, so the failure limiter can be exercised
// from "different" clients without needing real network interfaces.
async function call(body, token, source = '203.0.113.1') {
  const res = await fetch(`http://localhost:${PORT}/api/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-vercel-forwarded-for': source,
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };

(async () => {
  const server = http.createServer((req, res) => {
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    res.send = (t) => res.end(t);
    handler(req, res);
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  console.log('\nCredential strength (F1)\n');

  check('a 20-char single-class token is judged weak',
    guard.tokenWeakness(WEAK) !== null, guard.tokenWeakness(WEAK) || 'accepted');
  check('a random 24+ char token is judged strong',
    guard.tokenWeakness(STRONG) === null, guard.tokenWeakness(STRONG));
  check('the token that was live in production would no longer authenticate',
    !guard.matchesAny(WEAK, guard.usableTokens(WEAK)));
  check('a strong token authenticates',
    guard.matchesAny(STRONG, guard.usableTokens(STRONG)));
  check('a weak token is dropped even when configured alongside a strong one',
    guard.usableTokens(`${WEAK},${STRONG}`).length === 1);

  console.log('\nBrute force (F1)\n');

  {
    const r = await call(ping, STRONG, '198.51.100.9');
    check('valid token still works', r.status === 200, `HTTP ${r.status}`);
  }
  {
    // Five distinct wrong tokens: the old limiter was keyed on the credential,
    // so each of these opened its own bucket and none of them ever counted.
    const src = '198.51.100.20';
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await call(ping, `wrong-guess-${i}`, src)).status);
    const sixth = await call(ping, 'wrong-guess-6', src);
    check('five failures from one source are 401', codes.every((c) => c === 401), codes.join(','));
    check('the sixth is refused with 429 despite a different token each time',
      sixth.status === 429, `HTTP ${sixth.status}`);
  }
  {
    const other = await call(ping, STRONG, '198.51.100.77');
    check('a different source is unaffected by another source being throttled',
      other.status === 200, `HTTP ${other.status}`);
  }
  {
    // The limiter must be checked before the credential, so a throttled source
    // cannot use response codes to tell a right guess from a wrong one.
    const r = await call(ping, STRONG, '198.51.100.20');
    check('a throttled source is refused even when it finally sends the right token',
      r.status === 429, `HTTP ${r.status}`);
  }

  console.log('\nBatch amplification (F2)\n');

  {
    const big = Array.from({ length: 21 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' }));
    const r = await call(big, STRONG, '203.0.113.50');
    check('a batch over the cap is rejected', r.status === 400, `HTTP ${r.status}`);
    check('the rejection says what the cap is', /maximum 20/.test(r.text), r.text.slice(0, 80));
  }
  {
    const ok = Array.from({ length: 5 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' }));
    const r = await call(ok, STRONG, '203.0.113.51');
    check('a batch within the cap still works', r.status === 200, `HTTP ${r.status}`);
  }
  {
    // 60 calls/minute: thirteen five-message batches is 65 messages. Under the
    // old per-request accounting this was thirteen requests and well within
    // quota, which is exactly how a batch bought unlimited work.
    const src = '203.0.113.60';
    const batch = Array.from({ length: 5 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' }));
    let throttled = false;
    for (let i = 0; i < 13 && !throttled; i++) {
      if ((await call(batch, STRONG, src)).status === 429) throttled = true;
    }
    check('the quota is charged per message, so batching cannot buy extra work', throttled);
  }

  console.log('\nFail closed (F1)\n');

  {
    const saved = process.env.MCP_TOKENS;
    process.env.MCP_TOKENS = '';
    const r = await call(ping, STRONG, '203.0.113.90');
    process.env.MCP_TOKENS = saved;
    check('with no tokens configured every request is refused',
      r.status === 401, `HTTP ${r.status}`);
  }

  server.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
