#!/usr/bin/env node
'use strict';
// Phase 0 probe. Answers four questions against real CitizenGO pages:
//   1. Does the expanded post-object query return what we expect?
//   2. Which insights metrics actually survived the deprecations?
//   3. Do Instagram permissions clear under this token without App Review?
//   4. Is the page inventory what ads_get_user_pages implied?
//
// Writes every raw response to fixtures/ — including error envelopes — then
// prints a verdict table. Nothing here writes to a database; no schema exists
// yet, deliberately.
//
// Token model, learned the hard way on the first run: a USER token can read
// /{page-id} basic fields, but /{page-id}/published_posts and
// /{page-id}/insights reject it (errors #210 and #190) and require a PAGE
// access token. Page tokens are fetched from /me/accounts?fields=access_token
// and held in memory only — the redactor keeps them out of every fixture.
//
// Usage:  META_TOKEN=... node probe/probe.js [page_id ...]

const fs = require('fs');
const path = require('path');
const { loadEnv, makeClient } = require('../lib/graph');
const M = require('./metrics');

loadEnv();

const TOKEN = process.env.META_TOKEN;
const VERSION = process.env.GRAPH_VERSION || 'v23.0';
const FIXTURES = path.join(__dirname, '..', 'fixtures');

if (!TOKEN) {
  console.error('META_TOKEN is not set.\n');
  console.error('Copy .env.example to .env and paste a token, or export META_TOKEN.');
  console.error('See README.md for how to create a System User token.');
  process.exit(2);
}

const client = makeClient({ token: TOKEN, version: VERSION });
const verdicts = [];
const pageTokens = new Map();

// Single choke point for secrets: everything written to disk passes through
// here. Redacting at fetch time instead would corrupt the page access tokens
// the caller legitimately needs in memory — which is exactly what went wrong
// on the second probe run.
function save(name, data) {
  fs.mkdirSync(FIXTURES, { recursive: true });
  const json = JSON.stringify(data, null, 2)
    .replace(/"access_token"\s*:\s*"[^"]*"/g, '"access_token": "<redacted>"')
    .replace(/access_token=[^&"\s]+/g, 'access_token=<redacted>');
  fs.writeFileSync(path.join(FIXTURES, `${name}.json`), json + '\n');
}

function note(scope, subject, result) {
  verdicts.push({
    scope,
    subject,
    ok: result.ok,
    status: result.status ?? null,
    error_code: result.error ? result.error.code : null,
    retired: !!(result.error && /valid insights metric/i.test(result.error.message || '')),
    error_subcode: result.error ? result.error.error_subcode ?? null : null,
    message: result.error ? result.error.message : null,
  });
  return result;
}

// Probes metrics one at a time — see the comment in metrics.js for why.
//
// The first run turned up a free signal worth exploiting: Graph validates the
// metric NAME before it checks the token type. A retired metric returns #100
// ("must be a valid insights metric") even when the call would also have failed
// on auth, whereas a live metric name returns the auth error instead. So #100 is
// a definitive "this metric is gone" regardless of token problems.
async function probeMetrics(scope, edgePath, metricNames, extraParams = {}, opts = {}) {
  const out = {};
  for (const metric of metricNames) {
    const res = await client.get(edgePath, { metric, ...extraParams }, opts);
    out[metric] = res;
    note(scope, metric, res);
  }
  return out;
}

async function probePage(page) {
  const id = page.page_id;
  const label = `${page.name} (${id})`;
  const pageToken = pageTokens.get(id);
  const as = pageToken ? { token: pageToken } : {};
  console.log(`\n── ${label}${pageToken ? '' : '  [no page token — user token only]'}`);

  // 1. Identity and IG linkage. followers_count is a page field, not an insights
  //    metric, so it survived page_fans being deprecated.
  const info = note('page', `${id} fields`, await client.get(`/${id}`, {
    fields: 'id,name,followers_count,fan_count,link,instagram_business_account{id,username}',
  }, as));
  save(`${id}-01-page`, info);
  console.log(`   page fields: ${info.ok ? 'ok' : `FAILED (${info.error && info.error.message})`}`);
  if (!info.ok) {
    console.log('   skipping remaining probes for this page — no access.');
    return;
  }

  // 2. The expanded post query. This is the load-bearing call for the whole build.
  const posts = note('posts', `${id} published_posts (safe fields)`, await client.get(`/${id}/published_posts`, {
    fields: M.POST_FIELDS_SAFE,
    limit: 5,
  }, as));
  const gated = note('posts', `${id} published_posts (gated fields)`, await client.get(`/${id}/published_posts`, {
    fields: 'id,' + M.POST_FIELDS_GATED,
    limit: 5,
  }, as));
  save(`${id}-02-posts`, { safe: posts, gated_needs_pages_read_user_content: gated });
  const rows = posts.ok && posts.body && posts.body.data ? posts.body.data : [];
  console.log(`   published_posts: ${posts.ok ? `ok, ${rows.length} posts` : `FAILED (${posts.error && posts.error.message})`}`);

  // 3. Insights, one metric per call.
  if (rows.length) {
    const postId = rows[0].id;
    const total = M.POST_METRICS_EXPECTED_DEAD.length + M.POST_METRICS_CANDIDATE.length;
    console.log(`   probing ${total} post metrics on ${postId} ...`);
    save(`${id}-03-post-insights`, {
      post_id: postId,
      expected_dead: await probeMetrics('post-insight(dead?)', `/${postId}/insights`, M.POST_METRICS_EXPECTED_DEAD, {}, as),
      candidates: await probeMetrics('post-insight', `/${postId}/insights`, M.POST_METRICS_CANDIDATE, {}, as),
      // Does the is_from_ads breakdown still exist? Sources contradict each other.
      breakdowns: Object.fromEntries(await Promise.all(M.POST_BREAKDOWNS.map(async (b) => [
        b,
        note('post-insight', `post_media_view+${b}`,
          await client.get(`/${postId}/insights`, { metric: 'post_media_view', breakdown: b }, as)),
      ]))),
    });
  }

  console.log(`   probing ${M.PAGE_METRICS_CANDIDATE.length} page metrics ...`);
  save(`${id}-04-page-insights`, await probeMetrics('page-insight', `/${id}/insights`,
    M.PAGE_METRICS_CANDIDATE, { period: 'day', date_preset: 'last_30d' }, as));

  // 4. Instagram. Needs instagram_basic + instagram_manage_insights.
  const ig = info.body && info.body.instagram_business_account;
  if (!ig) {
    console.log('   instagram: no linked business account visible to this token');
    save(`${id}-05-instagram`, { linked: false });
    return;
  }
  console.log(`   instagram: @${ig.username} (${ig.id})`);
  const media = note('instagram', `${ig.id} media`, await client.get(`/${ig.id}/media`, {
    fields: M.IG_MEDIA_FIELDS, limit: 5,
  }, as));
  const igOut = { linked: true, ig_user_id: ig.id, username: ig.username, media };
  const igRows = media.ok && media.body && media.body.data ? media.body.data : [];
  if (igRows.length) {
    igOut.media_insights = {
      media_id: igRows[0].id,
      metrics: await probeMetrics('ig-insight', `/${igRows[0].id}/insights`, M.IG_MEDIA_METRICS_CANDIDATE, {}, as),
    };
  }
  save(`${id}-05-instagram`, igOut);
}

async function main() {
  console.log(`Phase 0 probe — Graph API ${VERSION}`);

  const who = note('token', 'identity', await client.get('/me', { fields: 'id,name' }));
  save('00-token', who);
  if (!who.ok) {
    console.error(`\nToken rejected: ${who.error ? who.error.message : 'unknown error'}`);
    process.exit(1);
  }
  console.log(`Token identity: ${who.body.name || '(no name)'} [${who.body.id}]`);

  const scopes = note('token', 'permissions', await client.get('/me/permissions'));
  save('00-permissions', scopes);
  if (scopes.ok) {
    const granted = scopes.body.data.filter((p) => p.status === 'granted').map((p) => p.permission);
    console.log(`Granted scopes: ${granted.join(', ')}`);
  }

  // 4. Inventory reconciliation, and the source of page tokens. ads_get_user_pages
  //    listed 35 pages, but that edge shows pages with ADS permission — this one
  //    shows what can actually be READ, which is the number that matters.
  const accounts = note('token', 'accounts', await client.get('/me/accounts', {
    fields: 'id,name,followers_count,access_token',
    limit: 100,
  }));
  save('00-accounts', accounts);
  let discovered = [];
  if (accounts.ok && accounts.body && accounts.body.data) {
    discovered = accounts.body.data.map((p) => ({ page_id: p.id, name: p.name }));
    for (const p of accounts.body.data) {
      if (p.access_token) pageTokens.set(p.id, p.access_token);
    }
    console.log(`Pages readable by this token: ${discovered.length} (page tokens obtained: ${pageTokens.size})`);
  } else {
    console.log(`Pages readable: could not list (${accounts.error && accounts.error.message})`);
  }

  const argIds = process.argv.slice(2);
  let pilots;
  if (argIds.length) {
    pilots = argIds.map((page_id) => ({ page_id, name: 'from argv' }));
  } else if (discovered.length) {
    // Probe what is actually reachable rather than an aspirational pilot list.
    pilots = discovered;
  } else {
    pilots = JSON.parse(fs.readFileSync(path.join(__dirname, 'pilot-pages.json'), 'utf8'));
  }

  for (const page of pilots) await probePage(page);

  save('summary', { graph_version: VERSION, probed_at_utc: new Date().toISOString(), verdicts });

  const width = Math.max(...verdicts.map((v) => v.subject.length), 8);
  console.log('\n\nVERDICTS   (#100 = metric retired · #190/#210 = needs page token · #10 = no access to page)\n');
  let lastScope = null;
  for (const v of verdicts) {
    if (v.scope !== lastScope) { console.log(`  [${v.scope}]`); lastScope = v.scope; }
    const mark = v.ok ? 'LIVE' : (v.retired ? 'GONE' : 'FAIL');
    const why = v.ok ? '' : `  ${v.error_code ?? v.status ?? '?'}: ${(v.message || '').slice(0, 80)}`;
    console.log(`    ${mark}  ${v.subject.padEnd(width)}${why}`);
  }
  const live = verdicts.filter((v) => v.ok).length;
  const gone = verdicts.filter((v) => v.retired).length;
  console.log(`\n  ${live}/${verdicts.length} returned data · ${gone} confirmed retired (#100). Fixtures in fixtures/.`);
}

main().catch((err) => { console.error('\nProbe crashed:', err); process.exit(1); });
