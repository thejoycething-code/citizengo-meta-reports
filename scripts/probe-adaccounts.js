#!/usr/bin/env node
'use strict';
// Why has ad spend collected nothing since 29 Aug 2026?
//
// Every nightly run since is green but logs
//   ad spend: unavailable ((#100) Unsupported get request...)
// and that comes from the FIRST call in collector/adspend.js: /me/adaccounts.
//
// #100 on /me/<edge> is what Meta returns when the token is not a USER token -
// a System User cannot resolve /me to a person with ad accounts. The same week
// page enumeration dropped from 36 to 14, which is the signature of the token
// having moved to a System User. This probe establishes which route actually
// works before any code is changed, rather than swapping the endpoint and
// hoping.
//
// READ-ONLY.  META_TOKENS=... node scripts/probe-adaccounts.js

const { loadEnv, makeClient } = require('../lib/graph');
loadEnv();

const VERSION = process.env.GRAPH_VERSION || 'v23.0';
const TOKENS = String(process.env.META_TOKENS || process.env.META_TOKEN || '')
  .split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
if (!TOKENS.length) { console.error('No token. Set META_TOKENS or META_TOKEN.'); process.exit(2); }

const client = makeClient({ token: TOKENS[0], version: VERSION });

function show(label, res, pick) {
  if (!res.ok) {
    const e = res.error || {};
    console.log(`  no  ${label.padEnd(42)} #${e.code ?? res.status}${e.error_subcode ? '/' + e.error_subcode : ''} ${String(e.message || '').slice(0, 78)}`);
    return null;
  }
  const body = res.body || {};
  const data = Array.isArray(body.data) ? body.data : null;
  const summary = data ? `${data.length} row(s)` : JSON.stringify(pick ? pick(body) : body).slice(0, 78);
  console.log(`  OK  ${label.padEnd(42)} ${summary}`);
  return data || body;
}

(async () => {
  console.log(`Graph ${VERSION} · ${TOKENS.length} token(s)\n`);

  console.log('What is this token?');
  const me = await client.get('/me', { fields: 'id,name' });
  show('/me', me, (b) => ({ id: b.id, name: b.name }));

  // Decisive: Meta lists the scopes actually granted, so this separates "wrong
  // endpoint" from "permission never granted" without guessing from error text.
  console.log('\nScopes granted to this token:');
  const perms = await client.get('/me/permissions', {});
  if (perms.ok) {
    const rows = (perms.body && perms.body.data) || [];
    const granted = rows.filter((r) => r.status === 'granted').map((r) => r.permission).sort();
    const declined = rows.filter((r) => r.status !== 'granted').map((r) => r.permission).sort();
    console.log(`  granted (${granted.length}): ${granted.join(', ')}`);
    if (declined.length) console.log(`  NOT granted: ${declined.join(', ')}`);
    // leads_retrieval is checked because the ads and leads questions get asked
    // together and a probe that answers only half of one invites the wrong
    // conclusion. The organic six are listed so a regenerated token that
    // silently DROPPED one is visible here rather than three days later.
    for (const need of ['ads_read', 'leads_retrieval', 'ads_management', 'business_management',
      'pages_show_list', 'pages_read_engagement', 'pages_read_user_content',
      'read_insights', 'instagram_basic', 'instagram_manage_insights']) {
      console.log(`  ${granted.includes(need) ? 'yes' : 'NO '}  ${need}`);
    }
  } else {
    console.log(`  could not read /me/permissions: ${perms.error && perms.error.message}`);
  }

  console.log('\nThe route the collector uses today:');
  await (async () => { show('/me/adaccounts', await client.get('/me/adaccounts', { fields: 'id,name', limit: 100 })); })();

  // Scope granted is not the same as leads reachable: lead forms are a
  // SEPARATE asset assignment on the Page, so a token can hold leads_retrieval
  // and still see nothing.
  console.log('\nLead forms (needs leads_retrieval AND Leads access on the Page):');
  try {
    const pagesRes = await client.get('/me/accounts', { fields: 'id,name', limit: 3 });
    const pages = (pagesRes.body && pagesRes.body.data) || [];
    if (!pages.length) console.log('  (no pages returned, so nothing to ask)');
    for (const pg of pages) {
      const f = await client.get(`/${pg.id}/leadgen_forms`, { limit: 3 }, { token: pg.access_token });
      if (!f.ok) {
        console.log(`  no  ${pg.name.padEnd(28)} ${((f.body && f.body.error && f.body.error.message) || `HTTP ${f.status}`).slice(0, 80)}`);
      } else {
        const forms = (f.body && f.body.data) || [];
        console.log(`  OK  ${pg.name.padEnd(28)} ${forms.length} lead form(s)`);
      }
    }
  } catch (e) { console.log(`  lead-form probe failed: ${e.message}`); }

  console.log('\nBusiness-scoped routes (what a System User would use):');
  const biz = show('/me/businesses', await client.get('/me/businesses', { fields: 'id,name', limit: 50 }));
  const businesses = Array.isArray(biz) ? biz : [];
  for (const b of businesses) {
    for (const edge of ['owned_ad_accounts', 'client_ad_accounts']) {
      const r = await client.get(`/${b.id}/${edge}`, { fields: 'id,name,currency', limit: 100 });
      const rows = show(`/${b.id}/${edge}  (${String(b.name).slice(0, 18)})`, r);
      // Prove the account is actually usable for the insights call that follows,
      // not merely listable.
      if (rows && rows.length) {
        const acct = rows[0];
        const ins = await client.get(`/${acct.id}/insights`, {
          level: 'ad',
          fields: 'ad_id,spend,impressions,date_start,date_stop',
          date_preset: 'last_30d',
          limit: 5,
        });
        show(`    └ insights on ${acct.id}`, ins);
      }
    }
  }

  if (!businesses.length) {
    console.log('  (no businesses returned — try /me/assigned_ad_accounts)');
    show('/me/assigned_ad_accounts', await client.get('/me/assigned_ad_accounts', { fields: 'id,name', limit: 100 }));
  }

  console.log('\nRead the OK line that returns ad accounts AND insights: that is the route');
  console.log('collector/adspend.js should use in place of /me/adaccounts.');
})().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
