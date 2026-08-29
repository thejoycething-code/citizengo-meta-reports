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

console.log(`\n${passed}/${total} passed.\n`);
process.exit(passed === total ? 0 : 1);
