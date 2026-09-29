#!/usr/bin/env node
'use strict';
// collectAccountMetrics, against a fake Graph. Two things found 29 Sept 2026:
//
//   1. Every row was filled with every column, nulls included, so each night
//      the upsert blanked the follower count, views and profile visits saved
//      on the previous 30 days. Older rows must now carry ONLY what was
//      observed for them.
//
//   2. Instagram unfollows come from follows_and_unfollows with
//      breakdown=follow_type, one Meta day at a time, on the day boundaries
//      follower_count reports - a UTC-midnight day comes back empty.

const { collectAccountMetrics } = require('../collector/instagram');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

// Three days closing at 07:00Z (Pacific midnight, summer).
const ENDS = ['2026-09-25T07:00:00+0000', '2026-09-26T07:00:00+0000', '2026-09-27T07:00:00+0000'];
const GAINED = [296, 523, 870];
const LOST = [40, 55, 96];

const calls = [];
async function call(path, params) {
  calls.push({ path, params });
  if (params.metric === 'follower_count' || params.metric === 'reach') {
    return { ok: true, body: { data: [{ values: ENDS.map((end_time, i) => ({ end_time, value: GAINED[i] })) }] } };
  }
  if (params.metric === 'follows_and_unfollows') {
    const i = ENDS.findIndex((e) => Math.floor(Date.parse(e) / 1000) === params.until);
    // Only a request on the day boundary gets results - as Meta behaves.
    if (i < 0 || params.since !== params.until - 86400 || params.breakdown !== 'follow_type') {
      return { ok: true, body: { data: [{ total_value: { breakdowns: [{ dimension_keys: ['follow_type'] }] } }] } };
    }
    // The middle day comes back empty, to prove an empty day is left unset.
    if (i === 1) return { ok: true, body: { data: [{ total_value: { breakdowns: [{ dimension_keys: ['follow_type'] }] } }] } };
    return {
      ok: true,
      body: { data: [{ total_value: { breakdowns: [{ dimension_keys: ['follow_type'], results: [
        { dimension_values: ['FOLLOWER'], value: GAINED[i] },
        { dimension_values: ['NON_FOLLOWER'], value: LOST[i] },
      ] }] } }] },
    };
  }
  // total_value scalars for the current day.
  return { ok: true, body: { data: [{ total_value: { value: 1000 } }] } };
}

(async () => {
  console.log('collectAccountMetrics');
  const { rows } = await collectAccountMetrics({
    ig: { id: 'IG1', username: 'hazteoir', followers_count: 202810, media_count: 5000 },
    page: { page_id: 'P1' },
    as: null, call,
    lookbackDays: 30,
    runStarted: new Date('2026-09-28T20:05:00Z'),
    collectedDate: '2026-09-28',
  });

  const byDate = Object.fromEntries(rows.map((r) => [r.metric_date, r]));
  const today = byDate['2026-09-28'];
  const older = rows.filter((r) => r.metric_date !== '2026-09-28');

  check('the current day carries the follower snapshot', today && today.followers_snapshot === 202810);
  check('the current day carries the total_value metrics', today && today.views === 1000 && today.profile_views === 1000);
  check('older days do NOT carry the snapshot key at all',
    older.every((r) => !('followers_snapshot' in r)), older.map((r) => r.metric_date).join(','));
  check('older days do NOT carry total_value keys (a null would overwrite the stored value)',
    older.every((r) => !('views' in r) && !('profile_views' in r) && !('media_count' in r)));
  check('older days still get the series', byDate['2026-09-26'] && byDate['2026-09-26'].follower_count === 870);

  // Dated the day DESCRIBED: the day closing 27 Sept 07:00Z is 26 Sept.
  check('unfollows are stored on the day described', byDate['2026-09-26'] && byDate['2026-09-26'].daily_unfollows === 96,
    JSON.stringify(byDate['2026-09-26']));
  check('follows from the split sit beside them', byDate['2026-09-26'] && byDate['2026-09-26'].daily_follows === 870);
  check('an empty day is left unset, not written as null or zero',
    byDate['2026-09-25'] && !('daily_unfollows' in byDate['2026-09-25']));

  const splitCalls = calls.filter((c) => c.params.metric === 'follows_and_unfollows');
  check('one follows_and_unfollows call per day', splitCalls.length === ENDS.length, `${splitCalls.length}`);
  check('every call sits on a boundary follower_count reported',
    splitCalls.every((c) => ENDS.some((e) => Math.floor(Date.parse(e) / 1000) === c.params.until)
      && c.params.since === c.params.until - 86400));
  check('the old no-breakdown request is gone',
    !calls.some((c) => c.params.metric === 'follows_and_unfollows' && !c.params.breakdown));

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
