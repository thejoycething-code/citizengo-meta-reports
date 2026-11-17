#!/usr/bin/env node
'use strict';
// Monday-Sunday Instagram totals (collector/instagram.js collectAccountWeeks)
// and the instagram_weekly tool, against fakes. The window is the point: it
// was matched to Meta Business Suite (Monday 00:00 to Monday 00:00 UTC), and a
// Pacific window is a day out.

const { weekWindows, collectAccountWeeks } = require('../collector/instagram');
const { callTool } = require('../mcp/tools');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};
const iso = (s) => new Date(s * 1000).toISOString();

(async () => {
  console.log('weekWindows');
  // Tuesday 17 Nov 2026, 03:30 UTC (the nightly run).
  let w = weekWindows(new Date('2026-11-17T03:30:00Z'));
  check('this week so far, then last week', w.map((x) => x.week).join() === '2026-11-16,2026-11-09');
  check('this week so far = Monday only', w[0].days === 1 && !w[0].complete && iso(w[0].until) === '2026-11-17T00:00:00.000Z');
  check('last week runs Monday 00:00 UTC to Monday 00:00 UTC',
    iso(w[1].since) === '2026-11-09T00:00:00.000Z' && iso(w[1].until) === '2026-11-16T00:00:00.000Z' && w[1].complete && w[1].days === 7);
  w = weekWindows(new Date('2026-11-16T03:30:00Z'));
  check('on a Monday, no empty "so far" week', w.length === 1 && w[0].week === '2026-11-09' && w[0].complete);
  w = weekWindows(new Date('2026-11-22T23:59:00Z'), 3);
  check('Sunday: six days so far, then three complete weeks', w.length === 4 && w[0].days === 6 && w[3].week === '2026-10-26');
  w = weekWindows(new Date('2026-10-14T03:30:00Z'), 1);
  check('the 12-18 Oct reference week starts Monday 12 Oct', w[0].week === '2026-10-12' && iso(w[0].since) === '2026-10-12T00:00:00.000Z');

  console.log('collectAccountWeeks');
  const calls = [];
  async function call(p, params) {
    calls.push(params);
    if (params.metric === 'replies') return { ok: false, error: { code: 100, message: 'nope' } };
    return { ok: true, body: { data: [{ total_value: { value: params.metric === 'total_interactions' ? 1134 : 7 } }] } };
  }
  const { rows, errorCount } = await collectAccountWeeks({
    ig: { id: 'IG1', username: 'citizengo' }, page: { page_id: 'P1' }, as: {}, call,
    runStarted: new Date('2026-11-17T03:30:00Z'),
  });
  check('two rows', rows.length === 2);
  check('total_value with since/until', calls.every((c) => c.metric_type === 'total_value' && c.period === 'day' && c.since && c.until));
  const last = rows.find((r) => r.week_start === '2026-11-09');
  check('interactions written', last.total_interactions === 1134 && last.likes === 7 && last.complete === true && last.page_id === 'P1');
  check('a failing metric is recorded, not written as null', !('replies' in last) && last.errors && last.errors.replies);
  check('errorCount counts weeks with an error', errorCount === 2);

  console.log('instagram_weekly');
  let asked;
  const store = {
    async igAccountWeeks(q) {
      asked = q;
      return [
        { ig_username: 'citizengo_uk', week_start: '2026-10-12', total_interactions: 40, complete: true, days_covered: 7 },
        { ig_username: 'citizengo', week_start: '2026-10-12', total_interactions: 1134, likes: 498, comments: 47, shares: 236, saves: 98, reposts: 19, replies: 0, reach: 9000, complete: true, days_covered: 7 },
        { ig_username: 'citizengo', week_start: '2026-10-05', total_interactions: 968, complete: true, days_covered: 7, views: 5, errors: { views: { code: 1 } } },
        { ig_username: 'hazteoir', week_start: '2026-10-12', total_interactions: 5, complete: true, days_covered: 7 },
      ];
    },
  };
  let out = await callTool(store, 'instagram_weekly', { week: '2026-10-15', weeks: 2 });
  check('asks for the Mondays of the weeks wanted', asked.from === '2026-10-05' && asked.to === '2026-10-12', JSON.stringify(asked));
  check('GLOBAL first, weeks in order', out.data.rows[0].account === 'citizengo' && out.data.rows[0].week_start === '2026-10-05' && out.data.rows[1].interactions === 1134);
  check('a failed metric is not shown', out.data.rows[0].views === null && /views not read/.test(out.data.rows[0].source));
  check('off-dashboard accounts only on request', !out.data.rows.some((r) => r.account === 'hazteoir') && /1 other connected/.test(out.text));
  check('the note says it is not a sum of posts', /not the sum of instagram_posts/.test(out.text));
  out = await callTool(store, 'instagram_weekly', { since: '2026-10-07', until: '2026-10-18', all_accounts: true });
  check('since/until map to Mondays', asked.from === '2026-10-05' && asked.to === '2026-10-12');
  check('all_accounts adds them', out.data.rows.some((r) => r.account === 'hazteoir'));
  await callTool(store, 'instagram_weekly', {});
  check('default is a complete week (a Monday)', new Date(`${asked.to}T00:00:00Z`).getUTCDay() === 1 && asked.from === asked.to);
  const empty = await callTool({ async igAccountWeeks() { return []; } }, 'instagram_weekly', { week: '2025-01-01' });
  check('no rows: says how weeks get filled', /backfill/.test(empty.text));

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
