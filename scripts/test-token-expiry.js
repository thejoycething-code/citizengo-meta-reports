#!/usr/bin/env node
'use strict';

// The token check cannot be exercised against a real token from a laptop - the
// token lives only in GitHub secrets - and it is the kind of code that runs
// unattended for weeks and then matters once. So the thresholds are tested
// against a stubbed Graph API instead.
//
// Each case runs the real script in a child process with fetch intercepted, and
// asserts on the exit code and output, because the exit code is what decides
// whether anyone is told.

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SCRIPT = path.join(__dirname, 'check-token-expiry.js');
const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);

const FULL_SCOPES = ['pages_show_list', 'pages_read_engagement', 'read_insights',
  'pages_read_user_content', 'instagram_basic'];

// A tiny preload that replaces fetch with a canned debug_token response.
function preloadFor(payload) {
  const file = path.join(os.tmpdir(), `stub-graph-${Math.abs(hash(JSON.stringify(payload)))}.js`);
  fs.writeFileSync(file, `
    const payload = ${JSON.stringify(payload)};
    global.fetch = async () => ({ json: async () => payload, ok: true, status: 200 });
  `);
  return file;
}
function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }

function run(name, payload, expectExit, expectText) {
  const preload = preloadFor(payload);
  const res = spawnSync(process.execPath, ['--require', preload, SCRIPT], {
    env: { ...process.env, META_TOKENS: 'stub-token-value' },
    encoding: 'utf8',
  });
  const out = (res.stdout || '') + (res.stderr || '');

  const exitOk = res.status === expectExit;
  const textOk = !expectText || out.includes(expectText);
  const leaked = out.includes('stub-token-value');

  const ok = exitOk && textOk && !leaked;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!exitOk) console.log(`          expected exit ${expectExit}, got ${res.status}`);
  if (!textOk) console.log(`          expected output to contain ${JSON.stringify(expectText)}`);
  if (leaked) console.log('          THE TOKEN APPEARED IN THE OUTPUT');
  fs.unlinkSync(preload);
  return ok;
}

console.log('\nToken expiry thresholds (warn at 21 days, fail at 7):\n');

let passed = 0, total = 0;
const check = (...a) => { total++; if (run(...a)) passed++; };
const check2 = (...a) => { total++; if (runReach(...a)) passed++; };

check('healthy token, 45 days left → exit 0',
  { data: { is_valid: true, app_id: '111', type: 'USER', scopes: FULL_SCOPES,
    expires_at: now() + 45 * DAY, data_access_expires_at: now() + 80 * DAY } },
  0, 'All tokens valid');

check('15 days left → warns, but does NOT fail the job',
  { data: { is_valid: true, app_id: '111', type: 'USER', scopes: FULL_SCOPES,
    expires_at: now() + 15 * DAY, data_access_expires_at: now() + 80 * DAY } },
  0, 'expires in 15 days');

check('3 days left → fails so somebody is told',
  { data: { is_valid: true, app_id: '111', type: 'USER', scopes: FULL_SCOPES,
    expires_at: now() + 3 * DAY, data_access_expires_at: now() + 80 * DAY } },
  1, 'TOKEN PROBLEM');

check('data access expires first → the EARLIER date wins',
  { data: { is_valid: true, app_id: '111', type: 'USER', scopes: FULL_SCOPES,
    expires_at: now() + 50 * DAY, data_access_expires_at: now() + 4 * DAY } },
  1, 'TOKEN PROBLEM');

check('already invalid → fails',
  { data: { is_valid: false, app_id: '111', type: 'USER', scopes: FULL_SCOPES } },
  1, 'no longer valid');

check('missing read_insights → fails even though it is valid and long-lived',
  { data: { is_valid: true, app_id: '111', type: 'USER',
    scopes: ['pages_show_list', 'pages_read_engagement'],
    expires_at: now() + 55 * DAY, data_access_expires_at: now() + 80 * DAY } },
  1, 'read_insights');

check('System User token, never expires → exit 0',
  { data: { is_valid: true, app_id: '111', type: 'SYSTEM_USER', scopes: FULL_SCOPES } },
  0, 'no expiry');

check('Graph returns an error → exit 1, not a false all-clear',
  { error: { message: 'Malformed access token' } },
  1, 'could not be inspected');

// ---------------------------------------------------------------------------
// Page reach: enumeration plus portfolio recovery.
//
// These exist because "reaches 14 page(s)" was printed daily, truthfully, while
// the collector reached 36 - /me/accounts lists only DIRECT-role pages. The
// number was correct and the signal was useless, so the SPLIT is what is under
// test here, not the total.
//
// Needs a stub that routes by URL rather than one canned payload, because the
// whole point is that the two discovery stages answer differently.

const DEBUG_OK = { data: { is_valid: true, app_id: '111', type: 'SYSTEM_USER', scopes: FULL_SCOPES } };

// Built by concatenation, not a template literal: the stub itself contains
// regexes and quotes, and nesting it inside a template literal is how the first
// attempt at this file broke.
function routedPreload(cfg) {
  const conf = JSON.stringify({
    enumerated: cfg.enumerated,
    knownIds: cfg.knownIds,
    reachableById: cfg.reachableById,
    pagesHttpOk: cfg.pagesHttpOk !== false,
    debug: DEBUG_OK,
  });
  const body = [
    'const cfg = ' + conf + ';',
    'global.fetch = async (input) => {',
    '  const url = String(input && input.href ? input.href : input);',
    '  const reply = (b, ok) => ({ ok: ok !== false, status: ok === false ? 500 : 200, json: async () => b });',
    '  if (url.indexOf("/debug_token") !== -1) return reply(cfg.debug);',
    '  if (url.indexOf("/me?fields=name") !== -1) return reply({ name: "Test Holder" });',
    '  if (url.indexOf("/me/accounts") !== -1) {',
    '    return reply({ data: cfg.enumerated.map((id) => ({ id: id })), paging: {} });',
    '  }',
    '  if (url.indexOf("/rest/v1/meta_pages") !== -1) {',
    '    if (!cfg.pagesHttpOk) return reply({ message: "boom" }, false);',
    '    return reply(cfg.knownIds.map((p) => ({ page_id: p })));',
    '  }',
    '  const m = url.match(/facebook\\.com\\/v23\\.0\\/(\\d+)\\?/);',
    '  if (m) {',
    '    const id = m[1];',
    '    return cfg.reachableById.indexOf(id) !== -1',
    '      ? reply({ id: id, access_token: "page-token-" + id })',
    '      : reply({ error: { message: "Unsupported get request", code: 100 } });',
    '  }',
    '  return reply({ error: { message: "not mocked: " + url } });',
    '};',
  ].join('\n');
  const file = path.join(os.tmpdir(), 'stub-routed-' + Math.abs(hash(conf)) + '.js');
  fs.writeFileSync(file, body);
  return file;
}

function runReach(name, cfg, expectExit, expectTexts, forbidTexts) {
  const preload = routedPreload(cfg);
  const noDb = cfg.knownIds === null;
  const res = spawnSync(process.execPath, ['--require', preload, SCRIPT], {
    env: {
      ...process.env,
      META_TOKENS: 'stub-token-value',
      SUPABASE_URL: noDb ? '' : 'https://stub.supabase.co',
      SUPABASE_SERVICE_KEY: noDb ? '' : 'stub-key',
      SUPABASE_MCP_KEY: '',
    },
    encoding: 'utf8',
  });
  const out = (res.stdout || '') + (res.stderr || '');

  const exitOk = res.status === expectExit;
  const missing = (expectTexts || []).filter((t) => !out.includes(t));
  const present = (forbidTexts || []).filter((t) => out.includes(t));
  // A page token is as much a secret as the user token.
  const leaked = out.includes('stub-token-value') || out.includes('page-token-');

  const ok = exitOk && !missing.length && !present.length && !leaked;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name);
  if (!exitOk) console.log('          expected exit ' + expectExit + ', got ' + res.status);
  for (const t of missing) console.log('          expected output to contain ' + JSON.stringify(t));
  for (const t of present) console.log('          output should NOT contain ' + JSON.stringify(t));
  if (leaked) console.log('          A TOKEN APPEARED IN THE OUTPUT');
  if (!ok) console.log('          ---- output ----\n' + out.replace(/^/gm, '          '));
  fs.unlinkSync(preload);
  return ok;
}

console.log('Page reach (enumeration + portfolio recovery):\n');

const idRange = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => String(a + i));
const EN14 = idRange(1, 14);
const ALL36 = idRange(1, 36);

// The real situation as of 6 Sep 2026: 14 enumerated, 22 more reachable by id.
check2('enumeration understates reach -> reports the split, not the floor',
  { enumerated: EN14, knownIds: ALL36, reachableById: ALL36 },
  0, ['36 page(s) of 36 collected', '14 enumerated + 22 via portfolio'],
  ['reaches          14 page(s)']);

// A genuinely narrowed token: pages we used to collect are gone for good. Must
// be visible, must NOT fail - sustained loss is meta_collection_runs' job.
check2('pages collected before but unreachable now -> warns, does NOT fail',
  { enumerated: EN14, knownIds: ALL36, reachableById: EN14 },
  0, ['UNREACHABLE      22 page(s)', 'can no longer reach 22 page(s)']);

// Losing the cross-check must never be reported as a small estate.
check2('meta_pages unreadable -> says so and calls the number a FLOOR',
  { enumerated: EN14, knownIds: ALL36, reachableById: ALL36, pagesHttpOk: false },
  0, ['14 page(s) by enumeration', 'FLOOR, not the estate'],
  ['via portfolio']);

console.log(`\n${passed}/${total} passed.\n`);
process.exit(passed === total ? 0 : 1);
