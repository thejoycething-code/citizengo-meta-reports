#!/usr/bin/env node
'use strict';
// How long until somebody's connector access stops working?
//
// Added 3 Sep 2026, alongside the existing Meta token check. Per-person access
// tokens expire 90 days after issue (see lib/tokens.js). The first six were all
// issued on 3 Sep, so they all lapse on 2 Dec together - and a token that
// expires unannounced looks to its holder like the tool breaking.
//
//   node scripts/check-access-tokens.js --warn-days 21 --fail-days 7
//
// Warns in the job log and step summary; FAILS the run inside --fail-days so
// the watchdog goes red and GitHub notifies even with no webhook configured.
// Renewal is `npm run tokens -- rotate <name>` plus a message to that person.

const { loadEnv } = require('../lib/graph');
loadEnv();

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
};
const WARN = arg('--warn-days', 21);
const FAIL = arg('--fail-days', 7);

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_MCP_KEY;
if (!url || !key) { console.error('SUPABASE_URL and a Supabase key are required.'); process.exit(2); }
const base = url.trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');

const days = (t) => Math.round((Date.parse(t) - Date.now()) / 86400000);
const summary = (line) => {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try { require('fs').appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + '\n'); } catch (e) { /* not fatal */ }
};

(async () => {
  const res = await fetch(
    `${base}/rest/v1/meta_access_tokens?select=name,note,expires_at&revoked_at=is.null&limit=1000`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  );
  if (res.status === 404 || res.status === 406) {
    // The table predates nothing else; if it is absent the connector is running
    // on MCP_TOKENS and there is nothing here to expire.
    console.log('No meta_access_tokens table; nothing to check.');
    return;
  }
  if (!res.ok) { console.error(`::warning::could not read meta_access_tokens: HTTP ${res.status}`); process.exit(0); }

  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) { console.log('No active access tokens.'); return; }

  const dated = rows.filter((r) => r.expires_at);
  const undated = rows.filter((r) => !r.expires_at);
  const expired = dated.filter((r) => days(r.expires_at) < 0).sort((a, b) => days(a.expires_at) - days(b.expires_at));
  const live = dated.filter((r) => days(r.expires_at) >= 0).sort((a, b) => days(a.expires_at) - days(b.expires_at));

  console.log(`Active access tokens: ${rows.length}`);
  for (const r of live) console.log(`  ${r.name}: ${days(r.expires_at)} day(s) left (${r.expires_at.slice(0, 10)})`);
  for (const r of undated) console.log(`  ${r.name}: no expiry set`);

  if (expired.length) {
    const who = expired.map((r) => `${r.name} (${Math.abs(days(r.expires_at))}d ago)`).join(', ');
    console.error(`::warning::Access tokens already expired and still not withdrawn: ${who}. `
      + 'They cannot authenticate. Rotate to renew, or revoke to tidy up.');
    summary(`**Expired access tokens:** ${who}`);
  }

  const soon = live.filter((r) => days(r.expires_at) <= WARN);
  if (!soon.length) {
    const next = live[0];
    console.log(next ? `Nothing expiring within ${WARN} days; next is ${next.name} in ${days(next.expires_at)}.` : 'Nothing dated to expire.');
    return;
  }

  const who = soon.map((r) => `${r.name} (${days(r.expires_at)}d)`).join(', ');
  const urgent = soon.filter((r) => days(r.expires_at) <= FAIL);
  const how = 'Renew with: npm run tokens -- rotate <name>  — then send that person the new token.';

  if (urgent.length) {
    console.error(`::error::Access tokens expiring within ${FAIL} days: ${who}. ${how}`);
    summary(`### Access tokens expiring within ${FAIL} days\n\n${who}\n\n${how}`);
    process.exit(1);
  }
  console.error(`::warning::Access tokens expiring within ${WARN} days: ${who}. ${how}`);
  summary(`**Access tokens expiring within ${WARN} days:** ${who}\n\n${how}`);
})().catch((e) => { console.error(`::warning::access token check failed: ${e.message}`); process.exit(0); });
