#!/usr/bin/env node
'use strict';
// Will Meta give us Instagram UNFOLLOWS, so net follower growth can be reported?
//
// We hold `follower_count` per day, which is new followers only - gross, not
// net. `follows_and_unfollows` is the documented route to both halves, and the
// collector has asked for it every night since August and stored nothing: it
// asks for total_value WITHOUT breakdown=follow_type, and without the breakdown
// the envelope comes back empty. Asked for by the Scorecard (29 Sept 2026),
// which needs a calendar-week net, so the date-range form matters as much as
// the daily one.
//
//   node scripts/probe-ig-follows.js
//
// READ-ONLY. Writes nothing to Meta or the database. Runs in Actions, where
// META_TOKENS lives.

const { loadEnv, makeClient } = require('../lib/graph');

loadEnv();

const { makePageTokens } = require('../lib/pagetokens');

const VERSION = process.env.GRAPH_VERSION || 'v23.0';
const SB = String(process.env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY;

async function q(pathname) {
  const r = await fetch(`${SB}/rest/v1/${pathname}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : [];
}

const DAY = 86400;
const now = Math.floor(Date.now() / 1000);
// Whole UTC days, so the answers are comparable with the daily series.
const today0 = now - (now % DAY);

const ATTEMPTS = [
  { label: 'no breakdown (what the collector asks)', params: { metric: 'follows_and_unfollows', metric_type: 'total_value', period: 'day' } },
  { label: 'breakdown=follow_type, no dates', params: { metric: 'follows_and_unfollows', metric_type: 'total_value', period: 'day', breakdown: 'follow_type' } },
  { label: 'breakdown, yesterday only', params: { metric: 'follows_and_unfollows', metric_type: 'total_value', period: 'day', breakdown: 'follow_type', since: today0 - DAY, until: today0 } },
  { label: 'breakdown, last 7 days', params: { metric: 'follows_and_unfollows', metric_type: 'total_value', period: 'day', breakdown: 'follow_type', since: today0 - 7 * DAY, until: today0 } },
  { label: 'breakdown, 28-35 days ago', params: { metric: 'follows_and_unfollows', metric_type: 'total_value', period: 'day', breakdown: 'follow_type', since: today0 - 35 * DAY, until: today0 - 28 * DAY } },
  // Round 2 (29 Sept): the UTC-midnight single day came back empty while 7-day
  // ranges worked. Meta's day closes at 07:00Z (Pacific midnight, summer), so
  // try single days on that boundary, and a 2-day range, to find which it is.
  { label: 'breakdown, 1 day on 07:00Z boundary', params: { metric: 'follows_and_unfollows', metric_type: 'total_value', period: 'day', breakdown: 'follow_type', since: today0 - 2 * DAY + 7 * 3600, until: today0 - DAY + 7 * 3600 } },
  { label: 'breakdown, 1 day on 08:00Z boundary', params: { metric: 'follows_and_unfollows', metric_type: 'total_value', period: 'day', breakdown: 'follow_type', since: today0 - 2 * DAY + 8 * 3600, until: today0 - DAY + 8 * 3600 } },
  { label: 'breakdown, 2 days on 07:00Z boundary', params: { metric: 'follows_and_unfollows', metric_type: 'total_value', period: 'day', breakdown: 'follow_type', since: today0 - 3 * DAY + 7 * 3600, until: today0 - DAY + 7 * 3600 } },
  { label: 'breakdown, 2 days UTC midnight', params: { metric: 'follows_and_unfollows', metric_type: 'total_value', period: 'day', breakdown: 'follow_type', since: today0 - 2 * DAY, until: today0 } },
  { label: 'breakdown, 1 day, a week back', params: { metric: 'follows_and_unfollows', metric_type: 'total_value', period: 'day', breakdown: 'follow_type', since: today0 - 7 * DAY + 7 * 3600, until: today0 - 6 * DAY + 7 * 3600 } },
  // Round 3 (29 Sept): the collector's [end - 1 day, end] window returned TWO
  // days summed - stored value for day D was follower_count(D-1) + (D) on every
  // day, e.g. HazteOir 22 Sept 1,209 = 670 + 539. Meta appears to count both
  // boundary dates. Find the form that returns exactly one. The target is the
  // day follower_count labels end_time 2026-09-23T07:00 (539; the day before is
  // 670). Fixed dates, so this round is comparable with the stored series.
  ...(() => {
    const e = Math.floor(Date.parse('2026-09-23T07:00:00Z') / 1000);
    const f = { metric: 'follows_and_unfollows', metric_type: 'total_value', period: 'day', breakdown: 'follow_type' };
    return [
      { label: 'R3 since=until=end', params: { ...f, since: e, until: e } },
      { label: 'R3 since=end-1d, until=end-1s', params: { ...f, since: e - DAY, until: e - 1 } },
      { label: 'R3 since=end-1d+1s, until=end', params: { ...f, since: e - DAY + 1, until: e } },
      { label: 'R3 since=end-1d+1s, until=end-1s', params: { ...f, since: e - DAY + 1, until: e - 1 } },
      { label: 'R3 since=end-1d, until=end-1d+1h', params: { ...f, since: e - DAY, until: e - DAY + 3600 } },
      { label: 'R3 since=end-1h, until=end', params: { ...f, since: e - 3600, until: e } },
      { label: 'R3 since=end, until=end+1d (next)', params: { ...f, since: e, until: e + DAY } },
      { label: 'R3 control follower_count 21-24', params: { metric: 'follower_count', period: 'day', since: e - 2 * DAY, until: e + DAY } },
    ];
  })(),
  // Control: the gross series we already store, same window, to compare against.
  { label: 'control: follower_count, last 7 days', params: { metric: 'follower_count', period: 'day', since: today0 - 7 * DAY, until: today0 } },
];

async function main() {
  const tokens = String(process.env.META_TOKENS || process.env.META_TOKEN || '')
    .split(/[\n,]/).map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) { console.error('No token. Set META_TOKENS.'); process.exit(2); }
  const client = makeClient({ token: tokens[0], version: VERSION });
  const pt = makePageTokens(client, tokens);
  await pt.enumeratePages();

  // One large, one medium, one small account: a metric that works only above
  // some follower threshold shows up as a split, not as a blanket answer.
  const wanted = ['hazteoir', 'citizengo_uk', 'citizengocanada'];
  const accounts = await q('meta_ig_account_metrics?select=ig_user_id,page_id,ig_username'
    + `&ig_username=in.(${wanted.join(',')})&order=metric_date.desc&limit=30`);
  const seen = new Map();
  for (const a of accounts) if (!seen.has(a.ig_user_id)) seen.set(a.ig_user_id, a);

  console.log(`Probing follows_and_unfollows on ${seen.size} account(s), Graph ${VERSION}\n`);
  const verdict = new Set();
  for (const a of seen.values()) {
    const tok = (await pt.tokenFor(a.page_id)) || tokens[0];
    console.log(`--- @${a.ig_username} (${a.ig_user_id})`);
    for (const t of ATTEMPTS) {
      const r = await client.get(`/${a.ig_user_id}/insights`, t.params, { token: tok });
      if (!r.ok) {
        const msg = (r.body && r.body.error && r.body.error.message) || `HTTP ${r.status}`;
        console.log(`  ${t.label.padEnd(42)} REFUSED — ${String(msg).slice(0, 110)}`);
        continue;
      }
      const d = r.body && r.body.data && r.body.data[0];
      const shown = d ? (d.total_value || d.values || d) : r.body;
      console.log(`  ${t.label.padEnd(42)} ${JSON.stringify(shown).slice(0, 300)}`);
      const breakdowns = d && d.total_value && d.total_value.breakdowns;
      if (breakdowns && breakdowns.length && breakdowns[0].results && breakdowns[0].results.length) verdict.add(t.label);
    }
    console.log();
  }

  console.log(verdict.size
    ? `VERDICT: follow/unfollow split returned for — ${[...verdict].join('; ')}`
    : 'VERDICT: no follow/unfollow split returned on any form asked.');
}

main().catch((e) => { console.error(e); process.exit(1); });
