#!/usr/bin/env node
'use strict';
// Content Engine nightly rights re-check (slice 2, Nov 2026). Runs on the Mini
// once a night: shows each person's sealed Page token to Facebook and removes
// the publishing right (and token) of anyone who has lost it. Rules in
// lib/rightscheck.js. Only rights from Connect Facebook (source 'meta') are
// checked; ones the maintainer seeded are left alone.
//
//   node collector/rights-check.js            # removes lost rights
//   node collector/rights-check.js --dry-run  # only says what it would remove
//
// Needs SUPABASE_URL, SUPABASE_SERVICE_KEY and ENGINE_TOKEN_PRIVATE_KEY.
// Prints who and which account, never a token.

const { loadEnv } = require('../lib/graph');
const { supabaseStore } = require('../lib/store');
const xauth = require('../lib/xauth');
const R = require('../lib/rightscheck');

async function run({ store, privateKey, live, now = Date.now(), log = console.log, fetchImpl }) {
  const [teams, tokens, rights] = await Promise.all([store.engineTeams(), store.engineConnectedTokens(), store.engineMetaRights()]);
  const { checks, orphans } = R.plan(tokens, rights, teams);
  const tally = { ok: 0, lost: 0, unsure: 0, orphans: orphans.length, held: false };
  const results = [];
  for (const item of checks) {
    let out;
    try {
      out = await R.check(item, xauth.open(privateKey, item.tok.sealed), fetchImpl);
    } catch (e) {
      out = { result: 'unsure', why: 'the sealed token could not be opened with this key' };
    }
    results.push({ item, ...out });
  }
  const at = new Date(now).toISOString();
  const held = R.looksAppWide(results);
  tally.held = held;
  if (held) log(`  ! Every token (${results.length}) came back refused: this looks like a problem with the Meta app, not with the people. Nothing removed.`);
  for (const r of results) {
    const label = `${r.item.who} → ${r.item.account_key}`;
    tally[r.result]++;
    if (r.result === 'ok') { if (live) await store.engineTouchRight({ who: r.item.who, account_key: r.item.account_key }, at); continue; }
    if (r.result === 'unsure') { log(`  ? ${label}: couldn't check (${r.why}); kept`); continue; }
    if (held) continue;
    log(`  ✗ ${label}: ${r.why}; ${live ? 'removed' : 'would remove'}`);
    if (live) await store.engineDropRight({ who: r.item.who, account_key: r.item.account_key });
  }
  for (const o of orphans) {
    log(`  ✗ ${o.who} → ${o.account_key}: no Page token behind it; ${live ? 'removed' : 'would remove'}`);
    if (live) await store.engineDropRight(o);
  }
  return tally;
}

if (require.main === module) {
  loadEnv();
  const live = !process.argv.includes('--dry-run');
  const privateKey = String(process.env.ENGINE_TOKEN_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!privateKey) { console.error('ENGINE_TOKEN_PRIVATE_KEY is not set: cannot open sealed Page tokens (scripts/engine-keygen.js).'); process.exit(1); }
  const store = supabaseStore({ url: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_KEY });
  console.log(`Content Engine rights check, ${live ? 'live' : 'dry run'}, ${new Date().toISOString()}`);
  run({ store, privateKey, live }).then((t) => console.log(JSON.stringify(t))).catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { run };
