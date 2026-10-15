#!/usr/bin/env node
'use strict';
// Register an Instagram account that its holder has shared with CitizenGO's
// Business Manager as a partner (lib/igpartner.js).
//
//   node scripts/ig-partner-add.js <username> "<label>" [--kind spokesperson] [--country AR] [--id <ig user id>] [--business <id>]
//
// Run by the "Instagram partner account" workflow, which has META_TOKENS. It
// finds the account by username in each Business Manager we hold a token for
// (or takes --id), checks the token can read its posts AND insights, then
// writes ig_accounts with access = 'partner'. The next nightly "Connected
// Instagram collection" run collects it (or dispatch that workflow by hand).

const { loadEnv } = require('../lib/graph');
const igpartner = require('../lib/igpartner');

loadEnv();
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i !== -1 && args[i + 1] ? args[i + 1] : dflt; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const [username, label] = positional;
const kind = opt('kind', 'spokesperson');
const BASE = (process.env.SUPABASE_URL || '').trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY || '';
const TOKENS = String(process.env.META_TOKENS || process.env.META_TOKEN || '').split(/[\n,]/).map((t) => t.trim()).filter(Boolean);

async function pg(method, q, body, prefer) {
  const r = await fetch(`${BASE}/rest/v1/${q}`, { method, headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${q.split('?')[0]}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}

async function main() {
  if (!username || !label) { console.error('Usage: node scripts/ig-partner-add.js <username> "<label>" [--kind spokesperson|organisation] [--country XX] [--id <ig user id>] [--business <id>]'); process.exit(2); }
  if (!['spokesperson', 'organisation'].includes(kind)) { console.error('--kind must be spokesperson or organisation'); process.exit(2); }
  if (!TOKENS.length || !BASE || !KEY) { console.error('META_TOKENS, SUPABASE_URL and SUPABASE_SERVICE_KEY are needed.'); process.exit(2); }

  let found = null;
  if (opt('id')) {
    found = { igUserId: String(opt('id')), username, tokenIndex: null, businessId: opt('business', null), edge: '(given)' };
  } else {
    // --business pins one; otherwise each token says which businesses it belongs to.
    const businessIds = opt('business') ? [opt('business')] : null;
    console.log(`Looking for @${username.replace(/^@/, '')} with ${TOKENS.length} token(s)${businessIds ? ` in business ${businessIds[0]}` : ' in the Business Managers each token belongs to'}…`);
    const r = await igpartner.findShared({ tokens: TOKENS, businessIds, username });
    for (const t of r.tried) console.log(`  token ${t.token} · business ${t.business} · ${t.edge}: ${t.ok ? `${t.count} account(s)` : 'not available'}`);
    found = r.found;
    if (!found) {
      // Fall back to Business Discovery through one of our own Instagram accounts.
      const ourIgIds = [...new Set(((await pg('GET', 'meta_pages?select=ig_user_id&ig_user_id=not.is.null')) || []).map((p) => p.ig_user_id))];
      found = await igpartner.idByDiscovery({ tokens: TOKENS, ourIgIds, username });
      console.log(found ? `  business_discovery: @${found.username} is Instagram user ${found.igUserId}` : '  business_discovery: not found (personal account, wrong username, or our accounts cannot look it up)');
    }
    if (!found) {
      console.error(`\n@${username} is not among the Instagram accounts our Business Managers can see. Check that (1) the holder added CitizenGO's Business Manager as a partner on that Instagram account with Insights access, and (2) the shared account is assigned to our System User (Business settings → Instagram accounts → the account → Assign people). Or pass --id with its Instagram user id.`);
      process.exit(1);
    }
    console.log(`\nFound @${found.username} (${found.igUserId}) via ${found.edge} in business ${found.businessId}.`);
  }

  // Which token can read it, posts and insights both.
  let access = null;
  const order = found.tokenIndex === null ? TOKENS.map((_, i) => i) : [found.tokenIndex, ...TOKENS.map((_, i) => i).filter((i) => i !== found.tokenIndex)];
  for (const i of order) {
    const c = await igpartner.checkAccess(igpartner.api(TOKENS[i]), found.igUserId);
    console.log(`  token ${i}: ${c.ok ? `readable${c.insights ? ', insights OK' : ` (${c.note})`}` : c.why}`);
    if (c.ok) { access = c; break; }
  }
  if (!access) { console.error('\nNo token can read this account with insights. Fix the partner share or the System User assignment, then run again.'); process.exit(1); }

  const now = new Date().toISOString();
  await pg('POST', 'ig_accounts?on_conflict=ig_user_id', [{
    ig_user_id: found.igUserId, username: access.user.username || found.username, name: access.user.name || null,
    kind, country: opt('country', null), label, is_active: true, access: 'partner', business_id: found.businessId || null,
    followers_count: access.user.followers_count ?? null, media_count: access.user.media_count ?? null,
    authorized_at: now, authorized_by: process.env.GITHUB_ACTOR || process.env.USER || null, last_seen_at: now,
  }], 'resolution=merge-duplicates,return=minimal');
  console.log(`\nRegistered @${access.user.username} as "${label}" (${kind}, partner access). Collection starts with the next "Connected Instagram collection" run.`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
