#!/usr/bin/env node
'use strict';
// Is "followers gained per post" available from Meta? Probe, do not guess.
//
// We hold follower counts per PAGE per DAY (meta_page_metrics: followers_snapshot,
// daily_follows) but nothing follower-related per POST. Inferring it from the
// daily change does not work: across 3,557 page-days with a measurable change,
// only 16% had exactly one post that day, 67% had none at all, and the median
// absolute daily change is 0 - the signal sits under the noise.
//
// So the question is whether Meta will simply tell us. Instagram documents
// `follows` and `profile_visits` as media insights in recent API versions and we
// do not request either; Facebook appears to expose no per-post equivalent. This
// script settles both against the real API rather than against documentation,
// the same way the demographics metrics were probed before being written off
// (see the AUDIENCE DEMOGRAPHICS note in sql/schema.sql).
//
// READ-ONLY. It writes nothing, to Meta or to the database.
//
// Runs in CI because META_TOKENS lives in GitHub Secrets, not in a local .env:
//   Actions -> "Probe follower metrics" -> Run workflow
// Locally, if you have a token:
//   META_TOKENS=... node scripts/probe-follower-metrics.js

const { loadEnv, makeClient } = require('../lib/graph');
loadEnv();

const VERSION = process.env.GRAPH_VERSION || 'v23.0';
const TOKENS = String(process.env.META_TOKENS || process.env.META_TOKEN || '')
  .split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
if (!TOKENS.length) {
  console.error('No token. Set META_TOKENS (list) or META_TOKEN (single).');
  process.exit(2);
}
const client = makeClient({ token: TOKENS[0], version: VERSION });

// Instagram media insights. `follows` and `profile_visits` are the two that
// would answer the question; the rest are controls, so a blanket failure is
// distinguishable from these two specifically being unavailable.
const IG_CANDIDATES = ['follows', 'profile_visits', 'profile_activity', 'navigation'];
const IG_CONTROLS = ['reach', 'total_interactions'];

// Facebook per-post. No documented follower metric exists, so these are
// plausible names being ruled out on the record rather than by assumption.
const FB_CANDIDATES = ['post_follows', 'post_new_followers', 'post_fan_adds', 'post_page_follows', 'post_follows_unique'];
const FB_CONTROLS = ['post_activity_by_action_type', 'post_media_view'];

const sb = (() => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_MCP_KEY;
  if (!url || !key) return null;
  return {
    base: url.trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, ''),
    headers: { apikey: key, Authorization: 'Bearer ' + key },
  };
})();

async function fromStore(path) {
  if (!sb) return [];
  try {
    const res = await fetch(`${sb.base}/rest/v1/${path}`, { headers: sb.headers });
    return res.ok ? await res.json() : [];
  } catch (e) { return []; }
}

// page_id -> Page access token. Page-scoped edges reject a user token, so the
// probe has to ask as the page, exactly as the collector does.
async function pageTokens() {
  const map = new Map();
  for (const token of TOKENS) {
    let after = null;
    for (let guard = 0; guard < 20; guard++) {
      const params = { fields: 'id,name,access_token', limit: 100 };
      if (after) params.after = after;
      const res = await client.get('/me/accounts', params, { token });
      if (!res.ok) break;
      for (const p of (res.body && res.body.data) || []) {
        if (p.id && p.access_token && !map.has(p.id)) map.set(p.id, p.access_token);
      }
      after = res.body && res.body.paging && res.body.paging.cursors && res.body.paging.cursors.after;
      if (!after) break;
    }
  }
  return map;
}

// One probe. Returns a row rather than printing, so the summary can be built
// from the same data the detail came from.
async function probe({ label, id, metric, token, extra = {} }) {
  const res = await client.get(`/${id}/insights`, { metric, ...extra }, { token });
  if (res.ok) {
    const d = (res.body && res.body.data && res.body.data[0]) || null;
    const value = d
      ? (d.total_value !== undefined ? JSON.stringify(d.total_value)
        : JSON.stringify((d.values && d.values[0] && d.values[0].value) ?? null))
      : '(no data rows)';
    return { label, metric, ok: true, note: String(value).slice(0, 70) };
  }
  const e = res.error || {};
  return {
    label, metric, ok: false,
    note: `#${e.code ?? res.status}${e.error_subcode ? '/' + e.error_subcode : ''} ${String(e.message || res.transport_error || '').slice(0, 90)}`,
  };
}

(async () => {
  console.log(`Graph ${VERSION} · ${TOKENS.length} token(s)\n`);
  const tokens = await pageTokens();
  console.log(`Page tokens resolved: ${tokens.size}\n`);
  if (!tokens.size) {
    console.error('Could not resolve any Page access token — every insights call would fail on permissions.');
    console.error('Check the token has pages_show_list and the pages are in a Business Portfolio it can see.');
    process.exit(1);
  }

  const rows = [];

  // ---- Instagram -----------------------------------------------------------
  const igMedia = await fromStore('meta_ig_media?select=media_id,page_id,ig_username,media_product_type,timestamp&order=timestamp.desc&limit=40');
  // One per product type (FEED / REELS), since availability can differ by type.
  const igPicked = [];
  for (const m of igMedia) {
    if (!tokens.has(m.page_id)) continue;
    if (igPicked.some((p) => p.media_product_type === m.media_product_type)) continue;
    igPicked.push(m);
    if (igPicked.length >= 3) break;
  }
  if (!igPicked.length) {
    console.log('INSTAGRAM: no media found whose page has a resolvable token — skipped.\n');
  }
  for (const m of igPicked) {
    console.log(`INSTAGRAM  @${m.ig_username}  ${m.media_product_type}  ${String(m.timestamp).slice(0, 10)}`);
    const token = tokens.get(m.page_id);
    for (const metric of [...IG_CONTROLS, ...IG_CANDIDATES]) {
      const r = await probe({ label: `IG ${m.media_product_type} ${metric}`, id: m.media_id, metric, token });
      console.log(`   ${r.ok ? 'OK  ' : 'ERR '} ${metric.padEnd(18)} ${r.note}`);
      rows.push({ ...r, group: 'instagram', candidate: IG_CANDIDATES.includes(metric) });
      // Some IG metrics are only served as a total, not a time series.
      if (!r.ok && IG_CANDIDATES.includes(metric)) {
        const r2 = await probe({ label: `IG ${m.media_product_type} ${metric} (total_value)`, id: m.media_id, metric, token, extra: { metric_type: 'total_value' } });
        console.log(`   ${r2.ok ? 'OK  ' : 'ERR '} ${(metric + ' [total_value]').padEnd(18)} ${r2.note}`);
        rows.push({ ...r2, group: 'instagram', candidate: true });
      }
    }
    console.log('');
  }

  // ---- Facebook ------------------------------------------------------------
  const fbPosts = await fromStore('meta_posts?select=post_id,page_id,created_time&order=created_time.desc&limit=60');
  const fbPicked = fbPosts.filter((p) => tokens.has(p.page_id)).slice(0, 2);
  if (!fbPicked.length) console.log('FACEBOOK: no post found whose page has a resolvable token — skipped.\n');
  for (const p of fbPicked) {
    console.log(`FACEBOOK   post ${p.post_id}  ${String(p.created_time).slice(0, 10)}`);
    const token = tokens.get(p.page_id);
    for (const metric of [...FB_CONTROLS, ...FB_CANDIDATES]) {
      const r = await probe({ label: `FB ${metric}`, id: p.post_id, metric, token });
      console.log(`   ${r.ok ? 'OK  ' : 'ERR '} ${metric.padEnd(26)} ${r.note}`);
      rows.push({ ...r, group: 'facebook', candidate: FB_CANDIDATES.includes(metric) });
    }
    console.log('');
  }

  // ---- Verdict -------------------------------------------------------------
  const summary = (group) => {
    const g = rows.filter((r) => r.group === group);
    const controlsOk = g.filter((r) => !r.candidate && r.ok).length;
    const controlsTotal = g.filter((r) => !r.candidate).length;
    const winners = [...new Set(g.filter((r) => r.candidate && r.ok).map((r) => r.metric))];
    return { controlsOk, controlsTotal, winners };
  };

  const lines = [];
  lines.push('## Verdict');
  lines.push('');
  for (const group of ['instagram', 'facebook']) {
    const s = summary(group);
    if (!s.controlsTotal) { lines.push(`- **${group}**: not probed (no usable target).`); continue; }
    if (!s.controlsOk) {
      lines.push(`- **${group}**: inconclusive — even the control metrics failed (${s.controlsOk}/${s.controlsTotal}), so this is a permissions or token problem, not proof the metric is missing.`);
      continue;
    }
    if (s.winners.length) {
      lines.push(`- **${group}**: per-post follower data IS available via \`${s.winners.join('`, `')}\`. Worth adding to the collector.`);
    } else {
      lines.push(`- **${group}**: no per-post follower metric available. Controls passed (${s.controlsOk}/${s.controlsTotal}), so the token and permissions are fine — the metric genuinely does not exist.`);
    }
  }
  lines.push('');
  lines.push('Nothing was written. If Instagram returned a metric, the change is two columns on `meta_ig_media_metrics` and one entry in `IG_METRICS` in `collector/instagram.js`.');

  const out = lines.join('\n');
  console.log(out);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { require('fs').appendFileSync(process.env.GITHUB_STEP_SUMMARY, out + '\n'); } catch (e) { /* not fatal */ }
  }
})().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
