#!/usr/bin/env node
'use strict';

// Warns before the Meta tokens expire, rather than after.
//
// Access runs through a personal Facebook profile because the citizenGO
// portfolio cannot have apps added to it, so a System User is not currently
// possible. Personal-profile tokens last 60 days. Without this check the first
// sign of expiry is collection silently returning nothing, and the 2-day
// staleness watchdog then reports a symptom ("no data") rather than the cause
// ("the token died on Tuesday").
//
// Deliberately checks BOTH expiries Meta tracks, because they are different
// dates and the earlier one is what actually bites:
//   expires_at              - the token stops working
//   data_access_expires_at  - the token still authenticates but returns no data
//
// It also asserts the scopes, because a token renewed WITHOUT read_insights
// returns HTTP 200 and an empty body rather than an error. That is this
// project's characteristic failure: success reported, nothing achieved.
//
// Never prints a token. Tokens are identified by position, app id, and a short
// hash, which is enough to tell two apart in a log without exposing either.

const crypto = require('crypto');
const { loadEnv } = require('../lib/graph');

loadEnv();

const args = process.argv.slice(2);
const argVal = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i !== -1 && args[i + 1] ? Number(args[i + 1]) : fallback;
};

// Renewal is manual and needs a person, so warn with enough runway to act
// around a weekend or a holiday.
const WARN_DAYS = argVal('warn-days', 21);
const FAIL_DAYS = argVal('fail-days', 7);

const REQUIRED_SCOPES = ['pages_show_list', 'pages_read_engagement', 'read_insights'];
const WANTED_SCOPES = ['pages_read_user_content', 'instagram_basic', 'instagram_manage_insights'];

const GRAPH = 'https://graph.facebook.com/v23.0';

const fingerprint = (t) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 6);
const daysUntil = (secs) => (secs ? Math.round((secs * 1000 - Date.now()) / 86_400_000) : null);
const asDate = (secs) => (secs ? new Date(secs * 1000).toISOString().slice(0, 10) : 'never');

// Who holds this token, and how far does it actually reach? Both matter and
// neither was visible anywhere. Two tokens can carry identical scopes and differ
// enormously in coverage - a personal login only offers Pages the person holds a
// DIRECT role on, so the same person can produce a 36-page token one month and a
// 14-page one the next without anything looking wrong.
async function reach(token) {
  const out = { name: null, pages: 0, ig: 0 };
  try {
    const me = await (await fetch(`${GRAPH}/me?fields=name&access_token=${encodeURIComponent(token)}`)).json();
    out.name = me.name || null;
    let after = null;
    do {
      const u = new URL(`${GRAPH}/me/accounts`);
      u.searchParams.set('fields', 'id,instagram_business_account{id}');
      u.searchParams.set('limit', '100');
      u.searchParams.set('access_token', token);
      if (after) u.searchParams.set('after', after);
      const r = await (await fetch(u)).json();
      const batch = r.data || [];
      out.pages += batch.length;
      out.ig += batch.filter((x) => x.instagram_business_account).length;
      after = r.paging && r.paging.next && r.paging.cursors ? r.paging.cursors.after : null;
    } while (after);
  } catch (e) { /* coverage is a nice-to-have; never fail the check on it */ }
  return out;
}

async function inspect(token) {
  const url = `${GRAPH}/debug_token?input_token=${encodeURIComponent(token)}`
    + `&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (body.error) return { error: body.error.message || JSON.stringify(body.error) };
  return body.data || {};
}

async function main() {
  const tokens = (process.env.META_TOKENS || '').split(',').map((s) => s.trim()).filter(Boolean);

  if (!tokens.length) {
    console.error('META_TOKENS is not set — nothing to check.');
    process.exit(2);
  }

  const problems = [];
  const warnings = [];

  console.log(`Checking ${tokens.length} Meta token(s).\n`);

  for (const [i, token] of tokens.entries()) {
    const label = `token ${i + 1} (${fingerprint(token)})`;
    const d = await inspect(token);

    if (d.error) {
      problems.push(`${label}: could not be inspected — ${d.error}`);
      console.log(`  ${label}: ERROR — ${d.error}`);
      continue;
    }

    if (d.is_valid === false) {
      problems.push(`${label} is no longer valid. Collection through it has stopped.`);
      console.log(`  ${label}: INVALID`);
      continue;
    }

    // Whichever runs out first is the one that matters.
    const tokenDays = daysUntil(d.expires_at);
    const dataDays = daysUntil(d.data_access_expires_at);
    const candidates = [tokenDays, dataDays].filter((n) => n !== null);
    const soonest = candidates.length ? Math.min(...candidates) : null;

    const cov = await reach(token);
    console.log(`  ${label}  app ${d.app_id || '?'}  type ${d.type || '?'}`);
    console.log(`    held by          ${cov.name || 'unknown'}`);
    console.log(`    reaches          ${cov.pages} page(s), ${cov.ig} with Instagram`);
    console.log(`    expires          ${asDate(d.expires_at)}${tokenDays === null ? '' : `  (${tokenDays} days)`}`);
    console.log(`    data access ends ${asDate(d.data_access_expires_at)}${dataDays === null ? '' : `  (${dataDays} days)`}`);

    const scopes = d.scopes || [];
    const missingRequired = REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
    const missingWanted = WANTED_SCOPES.filter((s) => !scopes.includes(s));

    if (missingRequired.length) {
      // Worth failing on: a token missing read_insights returns 200 with an
      // empty body, so collection "succeeds" and writes nothing.
      problems.push(`${label} is missing required scope(s): ${missingRequired.join(', ')}. `
        + 'Collection will return empty metrics without failing.');
      console.log(`    MISSING SCOPES   ${missingRequired.join(', ')}`);
    }
    if (missingWanted.length) {
      console.log(`    not granted      ${missingWanted.join(', ')}`);
    }

    if (soonest === null) {
      console.log('    no expiry — a System User token, which is what we want.');
    } else if (soonest <= FAIL_DAYS) {
      problems.push(`${label} expires in ${soonest} day(s), on ${asDate(Math.min(d.expires_at || Infinity, d.data_access_expires_at || Infinity))}.`);
    } else if (soonest <= WARN_DAYS) {
      warnings.push(`${label} expires in ${soonest} days.`);
    }
    console.log('');
  }

  const renewal = 'Renew: open the Graph API Explorer on the profile that owns the token, '
    + 'generate a fresh token with the same scopes, extend it to 60 days in the Access Token Debugger, '
    + 'then update the META_TOKENS secret. Keep any other tokens in the list.';

  if (problems.length) {
    const msg = 'CitizenGO Meta reporting — TOKEN PROBLEM. ' + problems.join(' ') + ' ' + renewal;
    console.error(`::error::${msg}`);
    for (const p of problems) console.error(`  ${p}`);
    console.error(`\n  ${renewal}`);
    process.exit(1);
  }

  if (warnings.length) {
    // A warning must not fail the job — that would cry wolf for three weeks —
    // but it must be visible, so it goes to the run summary too.
    for (const w of warnings) console.log(`  NOTE: ${w}`);
    console.log(`\n  ${renewal}`);
    console.log(`::warning::${warnings.join(' ')} ${renewal}`);
    process.exit(0);
  }

  console.log('All tokens valid, in scope, and not expiring soon.');
}

main().catch((e) => {
  console.error(`Token check failed to run: ${e.message}`);
  process.exit(2);
});
