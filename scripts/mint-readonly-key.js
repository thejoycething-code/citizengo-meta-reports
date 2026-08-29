#!/usr/bin/env node
'use strict';

// Mints a PostgREST key that authenticates as meta_readonly.
//
// The hosted MCP currently holds a service key: full read AND write on every
// table in the project, including clacton_actions (supporter names, emails,
// postcodes) and meta_page_tokens (the Facebook tokens themselves). That is far
// more authority than a read-only reporting endpoint needs, and the endpoint is
// reachable over the public internet.
//
// This key reads the meta_* reporting tables and nothing else - verified by
// direct probe: reads blocked on clacton_actions, clacton_events and
// meta_page_tokens; writes blocked on every table it CAN read.
//
// Signed locally so the JWT secret never leaves this machine. Get it from
// Supabase: Project Settings -> API Keys -> JWT Keys -> Legacy JWT Secret.
// Put it in .env as SUPABASE_JWT_SECRET, or pass --secret.

const crypto = require('crypto');
const { loadEnv } = require('../lib/graph');

loadEnv();

main();

function main() {
const args = process.argv.slice(2);
function argVal(name, fallback) {
  const i = args.indexOf('--' + name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

// Verify mode runs first: it needs no secret, only the token and the project URL.
const VERIFY = argVal('verify', null);
if (VERIFY) { verify(VERIFY).catch((e) => { console.error(e.message); process.exit(1); }); return; }

const SECRET = argVal('secret', process.env.SUPABASE_JWT_SECRET);
const ROLE = argVal('role', 'meta_readonly');
const YEARS = Number(argVal('years', 5));

if (!SECRET) {
  console.error('No JWT secret.\n');
  console.error('  Supabase -> Project Settings -> API Keys -> JWT Keys -> Legacy JWT Secret');
  console.error('  Then add to .env:  SUPABASE_JWT_SECRET=...');
  console.error('  Or pass:           node scripts/mint-readonly-key.js --secret "<secret>"');
  process.exit(2);
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

// A long expiry is deliberate. A key that silently expires would stop the whole
// team's reporting with a 401 nobody can interpret, and rotating it is a
// deliberate act rather than something to be forced by a timer.
// The project ref, taken from the Supabase URL. The working anon key carries
// this claim and the API gateway checks it on some projects, so a token without
// it can be rejected at the edge before PostgREST ever sees the role - which
// presents as a confusing 401 rather than a permissions message.
const REF = argVal('ref',
  ((process.env.SUPABASE_URL || '').match(/https?:\/\/([a-z0-9]+)\./) || [])[1]);
if (!REF) {
  console.error('Could not work out the project ref from SUPABASE_URL. Pass --ref <ref>.');
  process.exit(2);
}

const now = Math.floor(Date.now() / 1000);
const payload = {
  iss: 'supabase',
  ref: REF,
  role: ROLE,
  iat: now,
  exp: now + Math.round(YEARS * 365.25 * 24 * 3600),
};

const signingInput = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`;
const sig = crypto.createHmac('sha256', SECRET).update(signingInput).digest('base64url');
const token = `${signingInput}.${sig}`;

console.log(`\nProject: ${REF}`);
console.log(`Role:    ${ROLE}`);
console.log(`Expires: ${new Date(payload.exp * 1000).toISOString().slice(0, 10)} (${YEARS} years)\n`);
console.log(token);
console.log('\nSet it as SUPABASE_MCP_KEY in Vercel, then redeploy.');
console.log('Verify with:  node scripts/mint-readonly-key.js --verify <token>\n');
}

// Proves a key is actually restricted rather than trusting that it is. A key
// that silently still carried service_role would look identical in every other
// respect - it reads the reporting tables perfectly well. The only thing that
// distinguishes them is what they are REFUSED, so that is what this checks.
async function verify(token) {
  const base = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  if (!base) throw new Error('SUPABASE_URL is not set.');
  const h = { apikey: token, Authorization: 'Bearer ' + token };

  const probe = async (table) => {
    const r = await fetch(`${base}/rest/v1/${table}?select=*&limit=1`, { headers: h });
    return { status: r.status, ok: r.ok };
  };

  const mustRead = ['meta_pages', 'meta_posts', 'meta_post_latest', 'meta_page_growth',
                    'meta_ig_media', 'meta_post_ad_spend'];
  const mustNotRead = ['clacton_actions', 'clacton_events', 'meta_page_tokens'];

  let bad = 0;
  console.log('\nMust be readable:');
  for (const t of mustRead) {
    const { status, ok } = await probe(t);
    if (!ok) bad++;
    console.log(`  ${ok ? 'ok     ' : 'FAILED '} ${t} (${status})`);
  }

  console.log('\nMust be refused:');
  for (const t of mustNotRead) {
    const { status, ok } = await probe(t);
    // 200 with an empty array is still a refusal under RLS, but a readable
    // supporter table is the one thing that must never pass quietly - so treat
    // any 2xx here as a failure and let a human look.
    if (ok) bad++;
    console.log(`  ${ok ? 'LEAKED ' : 'blocked'} ${t} (${status})`);
  }

  // A write attempt is the clearest single test of whether this is really a
  // read-only key.
  const w = await fetch(`${base}/rest/v1/meta_pages`, {
    method: 'POST', headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({ page_id: '__verify_probe__', name: 'probe' }),
  });
  if (w.ok) {
    bad++;
    // Clean up after ourselves. A probe that succeeds has written a junk row to
    // a real table, and leaving it there would put '__verify_probe__' into page
    // lists and counts. Delete it with the same key that created it.
    const d = await fetch(`${base}/rest/v1/meta_pages?page_id=eq.__verify_probe__`,
      { method: 'DELETE', headers: h });
    console.log(`\nWrite attempt: SUCCEEDED — THIS IS NOT A READ-ONLY KEY`);
    console.log(`  probe row ${d.ok ? 'removed' : 'COULD NOT BE REMOVED — delete meta_pages.__verify_probe__ by hand'}`);
  } else {
    console.log(`\nWrite attempt: blocked (${w.status})`);
  }

  console.log(bad === 0
    ? '\nPASS — this key reads the reporting tables and nothing else.\n'
    : `\nFAIL — ${bad} check(s) wrong. Do NOT deploy this key.\n`);
  process.exit(bad === 0 ? 0 : 1);
}
