#!/usr/bin/env node
'use strict';

// DOES NOT WORK ON THIS PROJECT - kept because the finding is worth keeping.
//
// Supabase's gateway validates against ISSUED API keys, not merely a valid
// signature. A token signed with the project's own legacy JWT secret carrying
// role=meta_readonly is rejected upstream as "Invalid API key" before Postgres
// is reached. The real anon key, on the same request, returns a Postgres grant
// error instead - which is how the two were told apart.
//
// The underlying problem was solved differently: clacton_actions and
// clacton_events were moved to a non-exposed schema, so the service key can only
// reach reporting data. See sql/schema.sql.
//
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

async function main() {
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

// Check the secret BEFORE presenting the token. A wrong secret produces a
// perfectly well-formed token that simply never authenticates, and the failure
// surfaces later as a bare 401 against every table at once - which reads like a
// broken role or a network problem rather than a mistyped secret.
//
// Signing a throwaway 'anon' token and calling the API is the cheapest true
// test: anon is a role the project definitely has, so a 401 can only mean the
// signature was rejected.
const base = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
if (base) {
  const probeInput = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'supabase', ref: REF, role: 'anon', iat: now, exp: now + 300 })}`;
  const probe = `${probeInput}.${crypto.createHmac('sha256', SECRET).update(probeInput).digest('base64url')}`;
  // Probe the PostgREST ROOT, not a table. The root returns the OpenAPI spec to
  // any validly-signed token and needs no table grants, so a 401 there can only
  // mean the signature was rejected.
  //
  // The first version of this check called meta_pages, where anon has no grant
  // at all - so it returned 401 for a perfectly correct secret and refused to
  // mint. A test that fails on correct input is worse than no test.
  const r = await fetch(`${base}/rest/v1/`,
    { headers: { apikey: probe, Authorization: 'Bearer ' + probe } });
  if (r.status === 401) {
    console.error('\nThe secret in SUPABASE_JWT_SECRET is not this project signing secret.');
    console.error('A token signed with it is rejected before any permissions are considered.\n');
    console.error('  You want:     Legacy JWT Secret - a plain string, usually 40-64 characters');
    console.error('  You do NOT:   anything starting eyJ (a token) or sb_ (an API key),');
    console.error('                a PEM block, or anything with brackets or quotes attached\n');
    console.error('  Supabase -> Project Settings -> JWT Keys -> Legacy JWT Secret -> Reveal\n');
    console.error('No token has been printed, because it would not work.');
    process.exit(1);
  }
}

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
  if (!token || !/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) {
    throw new Error(
      `That is not a token: ${JSON.stringify(String(token).slice(0, 24))}\n\n`
      + '  Paste the actual minted token - three dot-separated parts starting "eyJ".\n'
      + '  Run the mint command with no arguments to produce one.'
    );
  }
  const base = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  if (!base) throw new Error('SUPABASE_URL is not set.');
  const h = { apikey: token, Authorization: 'Bearer ' + token };

  const probe = async (table) => {
    const r = await fetch(`${base}/rest/v1/${table}?select=*&limit=1`, { headers: h });
    return { status: r.status, ok: r.ok };
  };

  const mustRead = ['meta_pages', 'meta_posts', 'meta_post_latest', 'meta_page_growth',
                    'meta_ig_media', 'meta_post_ad_spend'];
  // These are no longer reachable over the API by any key - they were moved to
  // the private schema and meta_page_tokens was dropped. Kept in the probe so a
  // regression that re-exposed them would be caught.
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
