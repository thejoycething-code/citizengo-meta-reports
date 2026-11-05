#!/usr/bin/env node
'use strict';
// Calendar-month Instagram totals (collector/instagram.js collectAccountMonths)
// and the instagram_monthly tool that reads them, against fakes.
//
// The monthly Instagram dashboard needs Accounts reached per month. That is a
// UNIQUE count, so it can only come from Meta's own total over the month,
// never from adding daily reach - the main thing these checks hold in place.

const { monthWindows, collectAccountMonths } = require('../collector/instagram');
const { callTool } = require('../mcp/tools');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};
const iso = (s) => new Date(s * 1000).toISOString();

(async () => {
  console.log('monthWindows');
  // 6 Nov 2026 04:30 Madrid = 5 Nov 20:30 Pacific.
  let w = monthWindows(new Date('2026-11-06T03:30:00Z'));
  check('reads this month so far and last month in the grace days', w.map((x) => x.month).join() === '2026-11-01,2026-10-01');
  const oct = w.find((x) => x.month === '2026-10-01');
  check('October runs Pacific midnight to Pacific midnight (DST ends 1 Nov)',
    iso(oct.start) === '2026-10-01T07:00:00.000Z' && iso(oct.end) === '2026-11-01T07:00:00.000Z', `${iso(oct.start)} ${iso(oct.end)}`);
  check('October is complete and 31 days', oct.complete === true && oct.days === 31);
  const nov = w.find((x) => x.month === '2026-11-01');
  check('November so far stops at the last closed day (4 days, winter offset)',
    nov.days === 4 && !nov.complete && iso(nov.end) === '2026-11-05T08:00:00.000Z', `${nov.days} ${iso(nov.end)}`);
  w = monthWindows(new Date('2026-12-15T03:30:00Z'));
  check('past the grace days, last month is no longer read', w.map((x) => x.month).join() === '2026-12-01');
  w = monthWindows(new Date('2027-01-01T03:00:00Z')); // 31 Dec, 19:00 Pacific
  check('the night before a month ends reads it as not complete', w.length === 1 && w[0].month === '2026-12-01' && !w[0].complete && w[0].days === 30);

  console.log('collectAccountMonths');
  const calls = [];
  async function call(path, params) {
    calls.push(params);
    const range = params.until - params.since;
    if (range > 30 * 86400) return { ok: false, error: { code: 100, message: 'The since and until range is more than 30 days' } };
    if (params.metric === 'accounts_engaged') return { ok: false, error: { code: 100, message: 'not available' } };
    const days = Math.round(range / 86400);
    const per = { reach: 1000, views: 50, total_interactions: 5 }[params.metric];
    // Unique reach grows slower than days; views add up per day.
    return { ok: true, body: { data: [{ total_value: { value: params.metric === 'reach' ? per + days : per * days } }] } };
  }
  const { rows, errorCount } = await collectAccountMonths({
    ig: { id: 'IG1', username: 'citizengo' }, page: { page_id: 'P1' }, as: {}, call,
    runStarted: new Date('2026-11-06T03:30:00Z'),
  });
  const o = rows.find((r) => r.month === '2026-10-01');
  const n = rows.find((r) => r.month === '2026-11-01');
  check('every total is asked as total_value over a since/until range',
    calls.every((c) => c.metric_type === 'total_value' && c.since && c.until));
  check('since is one second after the month opens', calls.some((c) => iso(c.since) === '2026-10-01T07:00:01.000Z'));
  check('a 31-day month refused by Meta: views = first 30 days + the last day', o.views === 50 * 30 + 50 * 1, String(o.views));
  check('...interactions likewise', o.total_interactions === 5 * 31, String(o.total_interactions));
  check('...reach is NOT added across windows; it keeps 30 days and says so', o.reach === 1030 && o.reach_days === 30, `${o.reach} ${o.reach_days}`);
  check('a month inside the range is read in one call', n.reach === 1004 && n.reach_days === 4 && n.views === 200);
  check('a failing metric is recorded, not written as null', !('accounts_engaged' in o) && o.errors && o.errors.accounts_engaged);
  check('errorCount counts months with an error', errorCount === 2);
  check('rows carry the dashboard keys', o.complete === true && o.days_covered === 31 && o.ig_user_id === 'IG1' && o.page_id === 'P1');

  console.log('instagram_monthly');
  const store = {
    async igAccountMonths({ months }) {
      check('asks for the month and the one before', months.join() === '2026-09-01,2026-10-01');
      return [
        { ig_username: 'citizengo', month: '2026-09-01', reach: 100000, complete: true, days_covered: 30 },
        { ig_username: 'citizengocanada', month: '2026-10-01', reach: 900, views: 40, total_interactions: 4, complete: true, days_covered: 31, errors: { views: { code: 1 } } },
        { ig_username: 'citizengo', month: '2026-10-01', reach: 150000, views: 900000, total_interactions: 20000, complete: true, days_covered: 31, reach_days: 31 },
      ];
    },
    async igAccountGrowth() {
      return [
        { ig_username: 'citizengo', metric_date: '2026-10-30', followers_snapshot: 12500, daily_follows: 10, daily_unfollows: 2 },
        { ig_username: 'citizengo', metric_date: '2026-10-31', followers_snapshot: 12611, daily_follows: 20, daily_unfollows: 3 },
        { ig_username: 'citizengo_uk', metric_date: '2026-10-31', followers_snapshot: 242, daily_follows: 1 },
      ];
    },
    async igMonthPosts() {
      return [
        { ig_username: 'citizengo_uk', views: 300, total_interactions: 12 },
        { ig_username: 'citizengo_uk', views: 200, total_interactions: 8 },
        { ig_username: 'hazteoir', views: 1, total_interactions: 1 },
        { ig_username: 'citizengo_italia', views: null, total_interactions: null },
      ];
    },
  };
  const out = await callTool(store, 'instagram_monthly', { month: '2026-10' });
  const g = out.data.rows.find((r) => r.account === 'citizengo');
  check('dashboard order: GLOBAL first', out.data.rows[0].dashboard_row === '🌍 GLOBAL');
  check('Meta month totals used as they are', g.reach === 150000 && g.views === 900000 && g.interactions === 20000);
  check('accounts reached vs previous month', g.reach_vs_previous_pct === 50);
  check('followers = latest count in the month; net = follows - unfollows', g.followers === 12611 && g.net_growth === 25);
  const uk = out.data.rows.find((r) => r.account === 'citizengo_uk');
  check('no month total: views/interactions from posts published, marked', uk.views === 500 && uk.interactions === 20 && /†/.test(uk.source));
  check('...and reach left blank, not estimated', uk.reach === null);
  check('net withheld when unfollows were not measured every day', uk.net_growth === null);
  check('accounts without access listed as such', out.data.rows.some((r) => r.dashboard_row === '🇧🇷 PT BRASIL' && /not in the connector/.test(r.source)));
  check('accounts off the dashboard only on request', !out.data.rows.some((r) => r.account === 'hazteoir') && /1 other connected/.test(out.text));
  const it = out.data.rows.find((r) => r.account === 'citizengo_italia');
  check('posts without insights give no figure, not 0', it.views === null && it.interactions === null, `${it.views}`);
  const ca = out.data.rows.find((r) => r.account === 'citizengocanada');
  check('a metric whose last read failed is not shown as the month total', ca.views === null && ca.reach === 900 && /views not read/.test(ca.source));
  const all = await callTool(store, 'instagram_monthly', { month: '2026-10', all_accounts: true });
  check('all_accounts adds them', all.data.rows.some((r) => r.account === 'hazteoir'));
  check('the note says reach is unique, not summed', /never the sum of daily reach/.test(out.text));

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
