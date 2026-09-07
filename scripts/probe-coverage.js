#!/usr/bin/env node
'use strict';
// What does Meta offer that we are not collecting?
//
// Asked before committing to a 90-day backfill: a backfill costs roughly nine
// API calls per post across thousands of posts, so it is worth running once
// with the full metric set rather than twice.
//
// Every candidate below is probed against a real object and reported in one of
// three buckets: available and uncollected (act on these), available and
// already collected (the controls - if these fail, the run is broken rather
// than informative), and unavailable (recorded so nobody retries it blind).
//
// READ-ONLY. Writes nothing, to Meta or to the database.
//
//   Actions -> "Probe metric coverage" -> Run workflow
//   or: META_TOKENS=... node scripts/probe-coverage.js

const { loadEnv, makeClient } = require('../lib/graph');
const { makePageTokens } = require('../lib/pagetokens');
loadEnv();

const VERSION = process.env.GRAPH_VERSION || 'v23.0';
const TOKENS = String(process.env.META_TOKENS || process.env.META_TOKEN || '')
  .split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
if (!TOKENS.length) { console.error('No token. Set META_TOKENS or META_TOKEN.'); process.exit(2); }

const client = makeClient({ token: TOKENS[0], version: VERSION });
const { enumeratePages, tokenFor } = makePageTokens(client, TOKENS);

// `have: true` means the collector already requests it. Kept in the same list
// as the candidates on purpose - they are the controls, and a surface where
// every control fails has proved nothing about its candidates.
const FB_POST = [
  { m: 'post_media_view', have: true },
  { m: 'post_reactions_by_type_total', have: true },
  { m: 'post_activity_by_action_type', have: true },
  { m: 'post_clicks_by_type', have: true },
  // Negative feedback: hides, unfollows, spam reports. The one quality signal
  // we have no proxy for - a post can reach well and still cost followers.
  { m: 'post_negative_feedback' },
  { m: 'post_negative_feedback_unique' },
  { m: 'post_negative_feedback_by_type' },
  { m: 'post_negative_feedback_by_type_unique' },
  { m: 'post_engaged_users' },
  { m: 'post_engaged_fan' },
  { m: 'post_consumptions' },
  { m: 'post_consumptions_by_type' },
  { m: 'post_impressions' },
  { m: 'post_impressions_unique' },
  { m: 'post_video_views_unique' },
  { m: 'post_video_views_organic' },
  { m: 'post_video_views_paid' },
  { m: 'post_video_views_10s' },
  { m: 'post_video_social_actions' },
  { m: 'post_video_views_by_distribution_type' },
];

const FB_PAGE = [
  { m: 'page_views_total', have: true },
  { m: 'page_post_engagements', have: true },
  { m: 'page_daily_follows', have: true },
  { m: 'page_follows', have: true },
  // We track follows but not unfollows, so "net growth" is currently a guess.
  { m: 'page_daily_unfollows' },
  { m: 'page_daily_follows_unique' },
  { m: 'page_fans' },
  { m: 'page_fan_adds' },
  { m: 'page_fan_removes' },
  { m: 'page_fan_adds_unique' },
  { m: 'page_fan_removes_unique' },
  { m: 'page_negative_feedback' },
  { m: 'page_negative_feedback_by_type' },
  { m: 'page_impressions' },
  { m: 'page_impressions_unique' },
  { m: 'page_video_views' },
  { m: 'page_video_view_time' },
  { m: 'page_actions_post_reactions_total' },
];

const IG_MEDIA = [
  { m: 'reach', have: true },
  { m: 'views', have: true },
  { m: 'total_interactions', have: true },
  { m: 'saved', have: true },
  { m: 'shares', have: true },
  { m: 'follows', have: true },        // FEED only, added 7 Sept 2026
  { m: 'profile_visits', have: true }, // FEED only
  { m: 'profile_activity', have: true },
  // Reels watch-through. We collect the Facebook equivalents but nothing for
  // Reels, which is 374 of our 790 Instagram posts.
  { m: 'ig_reels_avg_watch_time' },
  { m: 'ig_reels_video_view_total_time' },
  { m: 'clips_replays_count' },
  { m: 'ig_reels_aggregated_all_plays_count' },
  { m: 'navigation' },
  { m: 'replies' },
  { m: 'thruplays' },
];

// Nothing at all is collected at Instagram account level. followers_count is
// already fetched in collector/instagram.js and thrown away, so IG follower
// growth is invisible while the Facebook equivalent is charted.
const IG_ACCOUNT = [
  { m: 'follower_count' },
  { m: 'reach' },
  { m: 'views' },
  { m: 'profile_views' },
  { m: 'website_clicks' },
  { m: 'accounts_engaged' },
  { m: 'total_interactions' },
  { m: 'follows_and_unfollows' },
  { m: 'online_followers' },
  { m: 'replies' },
];

const sb = (() => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_MCP_KEY;
  if (!url || !key) return null;
  return { base: url.trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, ''),
    headers: { apikey: key, Authorization: 'Bearer ' + key } };
})();

async function fromStore(path) {
  if (!sb) return [];
  try {
    const res = await fetch(`${sb.base}/rest/v1/${path}`, { headers: sb.headers });
    return res.ok ? await res.json() : [];
  } catch (e) { return []; }
}

// Meta rejects a metric in several different ways and the distinction matters:
// "not a valid metric" means gone, "does not support ... for this media product
// type" means gone for THIS object but possibly fine for another, and a
// permissions error means we have proved nothing at all.
function classify(res) {
  if (res.ok) {
    const d = (res.body && res.body.data && res.body.data[0]) || null;
    if (!d) return { state: 'empty', note: 'accepted but returned no data' };
    const v = d.total_value !== undefined ? d.total_value
      : (d.values && d.values[0] && d.values[0].value);
    return { state: 'ok', note: JSON.stringify(v ?? null).slice(0, 60) };
  }
  const e = res.error || {};
  const msg = String(e.message || res.transport_error || '');
  let state = 'error';
  if (/must be a valid insights metric|valid metrics are/i.test(msg)) state = 'invalid';
  else if (/does not support/i.test(msg)) state = 'unsupported';
  else if (/permission|OAuth|access token/i.test(msg)) state = 'permissions';
  return { state, note: `#${e.code ?? res.status} ${msg.slice(0, 80)}` };
}

async function probeSet({ label, id, token, set, extra = {} }) {
  console.log(`\n${label}`);
  const out = [];
  for (const { m, have } of set) {
    let res = await client.get(`/${id}/insights`, { metric: m, ...extra }, { token });
    let c = classify(res);
    // A metric can be real but only served as a total, or only per period.
    if (c.state !== 'ok' && !extra.metric_type) {
      const alt = await client.get(`/${id}/insights`,
        { metric: m, ...extra, metric_type: 'total_value' }, { token });
      const c2 = classify(alt);
      if (c2.state === 'ok') { res = alt; c = { ...c2, note: c2.note + ' [total_value]' }; }
    }
    const flag = have ? 'have' : 'NEW ';
    const mark = c.state === 'ok' ? 'OK ' : (c.state === 'empty' ? '   ' : 'no ');
    console.log(`  ${mark} ${flag} ${m.padEnd(38)} ${c.note}`);
    out.push({ metric: m, have: !!have, state: c.state, note: c.note, surface: label });
  }
  return out;
}

(async () => {
  console.log(`Graph ${VERSION} · ${TOKENS.length} token(s)`);
  const n = await enumeratePages();
  console.log(`Pages enumerated: ${n} (others resolved by id on demand)`);

  const rows = [];

  // Pick targets that will actually answer: a video post for the video metrics,
  // a FEED and a REELS item for Instagram.
  const fbVideo = await fromStore('meta_posts?select=post_id,page_id,created_time,media_type&media_type=eq.video&order=created_time.desc&limit=60');
  const fbAny = await fromStore('meta_posts?select=post_id,page_id,created_time,media_type&order=created_time.desc&limit=60');

  for (const [name, list] of [['video', fbVideo], ['non-video', fbAny]]) {
    for (const p of list) {
      const token = await tokenFor(p.page_id);
      if (!token) continue;
      rows.push(...await probeSet({
        label: `FACEBOOK POST (${name}, ${p.media_type}) ${p.post_id}`,
        id: p.post_id, token, set: FB_POST,
      }));
      // One target per flavour is enough; the answer is per metric, not per post.
      break;
    }
  }

  for (const p of fbAny) {
    const token = await tokenFor(p.page_id);
    if (!token) continue;
    const until = Math.floor(Date.now() / 1000);
    rows.push(...await probeSet({
      label: `FACEBOOK PAGE ${p.page_id}`,
      id: p.page_id, token, set: FB_PAGE,
      extra: { period: 'day', since: until - 7 * 86400, until },
    }));
    break;
  }

  const igMedia = await fromStore('meta_ig_media?select=media_id,page_id,ig_user_id,ig_username,media_product_type,timestamp&order=timestamp.desc&limit=250');
  const seen = new Set();
  let igAccount = null;
  for (const m of igMedia) {
    if (seen.has(m.media_product_type)) continue;
    const token = await tokenFor(m.page_id);
    if (!token) continue;
    seen.add(m.media_product_type);
    if (!igAccount) igAccount = { id: m.ig_user_id, username: m.ig_username, token };
    rows.push(...await probeSet({
      label: `INSTAGRAM MEDIA (${m.media_product_type}) @${m.ig_username}`,
      id: m.media_id, token, set: IG_MEDIA,
    }));
  }

  if (igAccount) {
    rows.push(...await probeSet({
      label: `INSTAGRAM ACCOUNT @${igAccount.username} (nothing collected here today)`,
      id: igAccount.id, token: igAccount.token, set: IG_ACCOUNT,
      extra: { period: 'day' },
    }));
  }

  // ---- Report --------------------------------------------------------------
  const lines = ['', '## Coverage', ''];
  const controlsFailed = rows.filter((r) => r.have && r.state !== 'ok').length;
  const controlsTotal = rows.filter((r) => r.have).length;
  lines.push(`Controls (metrics we already collect): ${controlsTotal - controlsFailed}/${controlsTotal} returned data.`);
  if (controlsFailed > controlsTotal / 2) {
    lines.push('');
    lines.push('**More than half the controls failed — treat everything below as unproven.**');
  }
  lines.push('');

  // A metric counts as available if it worked on ANY surface it was tried on.
  const wins = new Map();
  for (const r of rows) {
    if (r.state !== 'ok') continue;
    if (!wins.has(r.metric)) wins.set(r.metric, { have: r.have, where: [], note: r.note });
    wins.get(r.metric).where.push(r.surface.split(' (')[0].split(' ').slice(0, 2).join(' '));
  }
  const gains = [...wins.entries()].filter(([, v]) => !v.have);
  lines.push('### Available and NOT collected');
  lines.push('');
  if (!gains.length) lines.push('_Nothing. Current coverage is complete for everything probed._');
  for (const [m, v] of gains) {
    lines.push(`- \`${m}\` — ${v.note} (works on: ${[...new Set(v.where)].join(', ')})`);
  }
  lines.push('');

  const dead = [...new Set(rows.filter((r) => !r.have && r.state !== 'ok' && !wins.has(r.metric)).map((r) => r.metric))];
  lines.push('### Unavailable (do not retry without re-probing)');
  lines.push('');
  lines.push(dead.length ? dead.map((m) => `\`${m}\``).join(', ') : '_none_');

  const out = lines.join('\n');
  console.log(out);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { require('fs').appendFileSync(process.env.GITHUB_STEP_SUMMARY, out + '\n'); } catch (e) { /* not fatal */ }
  }
  if (!rows.length) {
    console.error('\nNothing was probed — this run proved nothing. Failing so it is not read as an answer.');
    process.exit(1);
  }
})().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
