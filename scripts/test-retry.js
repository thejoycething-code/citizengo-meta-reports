#!/usr/bin/env node
'use strict';

// isConnectionError() decides which of two alarms the watchdog raises, and they
// say opposite things. Get it wrong in one direction and a laptop's dropped
// socket announces that every published figure is understated; wrong in the
// other and a real outage is waved through as "probably the network". That
// happened on 6 Sep 2026, so the classification is pinned here rather than
// left to be re-derived from the comments.
//
// The rule under test: if an HTTP response came back we reached the database,
// whatever the status said. Only a throw with no response at all counts.

const { isConnectionError } = require('../lib/retry');

let passed = 0, failed = 0;

function is(name, err, expected) {
  let actual;
  try {
    actual = isConnectionError(err);
  } catch (e) {
    console.log(`  FAIL  ${name}\n          threw: ${e.message}`);
    failed++;
    return;
  }
  if (actual === expected) { console.log(`  ok    ${name}`); passed++; return; }
  console.log(`  FAIL  ${name}\n          expected ${expected}, got ${actual}`);
  failed++;
}

// A thrown Error carrying a libuv/undici code, as fetch() surfaces it.
const withCode = (code) => Object.assign(new Error('request failed'), { code });
// fetch() wraps the real cause, so the code walks .cause. Build a chain n deep.
// The wrappers carry a message that matches NOTHING, deliberately: wrapping in
// "fetch failed" would make these pass on the outer message alone and prove
// nothing about the walk.
const nested = (depth, leaf) => {
  let e = leaf;
  for (let i = 0; i < depth; i++) e = Object.assign(new Error('wrapper'), { cause: e });
  return e;
};

console.log('\nNever reached the database (expect true):\n');

for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EPIPE', 'EPROTO', 'ECONNABORTED',
  'ERR_SOCKET_CONNECTION_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']) {
  is(`${code} on the error itself`, withCode(code), true);
}

// The shape actually seen in the logs on 6 Sep: a bare "fetch failed".
is('undici "fetch failed" with no code at all', new Error('fetch failed'), true);
is('undici "terminated" - a socket dropped mid-body', new Error('terminated'), true);
is('"socket hang up" as a substring', new Error('read ECONNRESET: socket hang up'), true);
is('"network error" as a substring', new Error('A network error occurred'), true);
is('mixed case is normalised', new Error('Fetch Failed'), true);
is('AbortError by name (our own 5s timeout firing)',
  Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }), true);
is('TimeoutError by name', Object.assign(new Error('timed out'), { name: 'TimeoutError' }), true);

is('code one cause deep', nested(1, withCode('ECONNRESET')), true);
is('code three causes deep', nested(3, withCode('EAI_AGAIN')), true);
// The walk stops at 5 to avoid a cycle. Documented, not incidental: a code
// buried deeper than that is not found, and a self-referencing cause must not
// hang the watchdog.
is('code four causes deep is still found', nested(4, withCode('ECONNRESET')), true);
// The limit itself, so a future change to it is a deliberate one.
is('five causes deep is BEYOND the walk and reads as false',
  nested(5, withCode('ECONNRESET')), false);
// Proves the wrappers really are inert - without a network leaf the same chain
// must be false, so the true cases above cannot be passing on the wrapper.
is('an inert chain with no network leaf', nested(3, new Error('boom')), false);

console.log('\nReached it and got an answer, or is not a network fault (expect false):\n');

// The exception that gives the rule its teeth. READ_FAILED is raised FROM a
// response we received, so it is never a connection error - even though its
// message is the same wording undici uses when it never connected.
is('READ_FAILED is never one, whatever it says',
  Object.assign(new Error('fetch failed'), { code: 'READ_FAILED' }), false);
is('READ_FAILED outranks a network code on the same error',
  Object.assign(new Error('boom'), { code: 'READ_FAILED', cause: withCode('ECONNRESET') }), false);

is('an HTTP status is an answer, not a failure to reach',
  new Error('Could not read meta_pages (HTTP 401).'), false);
is('PostgREST clock skew - the database replied',
  Object.assign(new Error('HTTP 401 PGRST303'), { code: 'PGRST303' }), false);
is('a plain unrelated error', new Error('boom'), false);
is('a TypeError from our own code', new TypeError('x is not a function'), false);
is('null', null, false);
is('undefined', undefined, false);
is('an error with no message and no code', new Error(''), false);
// Substring greed would be wrong here: this is a schema fault, and reporting it
// as a network blip would tell someone to re-run instead of applying the schema.
is('a message merely containing the word network',
  new Error('column meta_pages.networkid does not exist'), false);

// Must terminate rather than hang. A watchdog that never exits is worse than
// one that mislabels.
const cyclic = new Error('boom');
cyclic.cause = cyclic;
is('a self-referencing cause chain terminates', cyclic, false);

console.log(`\n${passed} passed, ${failed} failed.\n`);
process.exit(failed === 0 ? 0 : 1);
