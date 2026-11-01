#!/usr/bin/env node
'use strict';
// engine_analytics (the desk's Analytics) against stubbed reporting handlers:
// scopes keep CitizenGO and HazteOir apart, a team sees only its own accounts,
// and every post is measured against its own Page's median.
// Usage: node scripts/test-analytics.js

let passed = 0, failed = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${name}`); passed++; } else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failed++; }
}
const tools = require('../mcp/tools');
const xtools = require('../mcp/x-tools');
const { ENGINE_TOOLS } = require('../mcp/engine-tools');
const peer = require('../mcp/peer-tools');

const pages = [{ page_id: '105', name: 'Citizen GO UK' }, { page_id: '120', name: 'Citizen GO Scotland' }, { page_id: '434', name: 'CitizenGO' }, { page_id: '154', name: 'HazteOir.org' }];
const stub = (list, name, fn) => { list.find((t) => t.name === name).handler = fn; };
stub(tools.TOOLS, 'page_growth', async () => ({ data: {
  facebook: [{ name: 'Citizen GO UK', followers: 10775, reach: 496006, views: 8498, engagements: 112630, newFollows: 807, unfollows: 62, netFollows: 745 },
    { name: 'CitizenGO', followers: 119756, reach: 900000, views: 20000, engagements: 50000, newFollows: 300, unfollows: 100, netFollows: 200 },
    { name: 'HazteOir.org', followers: 324249, reach: 7240000, views: 1, engagements: 1, newFollows: 14361, unfollows: 0, netFollows: 14361 }],
  instagram: [{ name: 'citizengo_uk', followers: 239, newFollowers: 90, unfollows: 3, net: null }, { name: 'hazteoir', followers: 214193, newFollowers: 10903, unfollows: null, net: null }],
} }));
const post = (page_id, page_name, views, msg) => ({ page_id, page_name, views_total: views, message: msg, permalink_url: `https://fb/${msg}`, created_time: '2026-10-20T10:00:00Z', beyond_followers_pct: 80, engagement_rate: 9 });
stub(tools.TOOLS, 'top_posts', async () => ({ data: { rows: [post('105', 'Citizen GO UK', 1000, 'a'), post('105', 'Citizen GO UK', 3000, 'b'), post('105', 'Citizen GO UK', 240000, 'court'), post('154', 'HazteOir.org', 543127, 'mercadona'), post('434', 'CitizenGO', 5000, 'g')] } }));
stub(tools.TOOLS, 'instagram_posts', async (store, a) => ({ data: [{ ig_username: a.page_id ? 'citizengo_uk' : 'hazteoir', caption: 'Isabel', permalink: 'https://ig/1', reach: 175, saved: 3 }].concat(a.page_id ? [] : [{ ig_username: 'citizengo_uk', caption: 'Isabel', reach: 175 }]) }));
xtools.enabled = () => true;
stub(xtools.X_TOOLS, 'x_period_summary', async () => ({ rows: [{ username: 'CitizenGO_GB', label: 'CitizenGO UK', posts: 40, impressions: 30000, engagements: 900, followers_first: 1296, followers_last: 1297, top_post_text: 'SNP', top_post_url: 'https://x/1' }, { username: 'HazteOir', posts: 1, impressions: 9 }] }));

const day = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const growthRows = [];
for (let n = 0; n < 84; n++) {
  growthRows.push({ page_id: '105', metric_date: day(n), media_view_unique: 1000, post_engagements: 100, daily_follows: 3, daily_unfollows: 1 });
  growthRows.push({ page_id: '434', metric_date: day(n), media_view_unique: 3000, post_engagements: 50, daily_follows: 1, daily_unfollows: 0 });
  growthRows.push({ page_id: '154', metric_date: day(n), media_view_unique: 99999, post_engagements: 1, daily_follows: 0, daily_unfollows: 0 });
}
const store = {
  async pageGrowth() { return growthRows; },
  async loadAll() { return { pages }; },
  async engineTeams() { return [{ id: 'uk', name: 'United Kingdom', accounts: [{ key: 'uk-fb', platform: 'facebook', page_id: '105' }, { key: 'uk-ig', platform: 'instagram', handle: 'citizengo_uk' }, { key: 'uk-x', platform: 'x', handle: 'CitizenGO_GB' }, { key: 'sc-fb', platform: 'facebook', page_id: '120' }] }]; },
  async engineMembers({ who }) { return who === 'chris' ? [{ team_id: 'uk', who: 'chris', role: 'admin' }] : []; },
};
const call = async (args, who = 'chris') => JSON.parse((await ENGINE_TOOLS.find((t) => t.name === 'engine_analytics').handler(store, args, { who })).text);
const callErr = async (args, who) => { try { await call(args, who); return null; } catch (e) { return e.code; } };

(async () => {
  const cgo = await call({});
  eq('CitizenGO scope: CitizenGO Pages only, HazteOir kept out of the totals', [cgo.scope, cgo.days, cgo.pages.map((p) => p.name), cgo.kpis.reach, cgo.kpis.net_follows], ['citizengo', 30, ['CitizenGO', 'Citizen GO UK'], 1396006, 945]);
  eq('top posts: ranked by views, each against its own Page\'s median', cgo.top_posts.map((p) => [p.text, p.x_median]), [['court', 80], ['g', 1], ['b', 1], ['a', 0.3]]);
  const hz = await call({ scope: 'hazteoir', days: 7 });
  eq('HazteOir scope: shown on its own', [hz.pages.map((p) => p.name), hz.instagram.map((r) => r.name), hz.x.map((r) => r.account), hz.days], [['HazteOir.org'], ['hazteoir'], ['@HazteOir'], 7]);
  const uk = await call({ scope: 'team', team: 'uk' });
  eq('team scope: the UK team\'s Pages, Instagram and X only', [uk.pages.map((p) => p.name), uk.instagram.map((r) => r.name), uk.instagram_posts.map((r) => r.account), uk.x.map((r) => [r.account, r.follower_change])], [['Citizen GO UK'], ['citizengo_uk'], ['citizengo_uk', 'citizengo_uk'], [['CitizenGO UK', 1]]]);
  eq('only team members see Analytics, and only their own team', [await callErr({}, 'stranger'), await callErr({ scope: 'team', team: 'de' })], ['ENGINE_NOT_MEMBER', 'ENGINE_NOT_MEMBER']);

  const tr = uk.trend;
  const fullWeek = tr.series[0].reach[tr.weeks.length - 1];
  eq('trend: 12 complete Monday weeks; the team\'s Page with weekly reach and net follows; the median is of CitizenGO Pages only', [tr.weeks.length, new Date(tr.weeks[0] + 'T00:00:00Z').getUTCDay(), tr.series.map((x) => x.name), fullWeek, tr.series[0].net[tr.weeks.length - 1], tr.median.reach[tr.weeks.length - 1], Date.parse(tr.weeks[11]) + 7 * 864e5 <= Date.now()], [12, 1, ['Citizen GO UK'], 7000, 14, 14000, true]);
  eq('trend: the CitizenGO view shows its biggest Pages, HazteOir never', (await call({})).trend.series.map((x) => x.name), ['CitizenGO', 'Citizen GO UK']);

  // Listening.
  {
    const ago = (d) => new Date(Date.now() - d * 864e5).toISOString();
    const P = (page_id, page_name, views, msg, d) => ({ page_id, page_name, views_total: views, message: msg, permalink_url: `https://fb/${msg}`, created_time: ago(d), media_type: 'photo' });
    stub(tools.TOOLS, 'top_posts', async (st, a) => ({ data: { rows: [
      P('105', 'Citizen GO UK', 50000, 'uk-big', 2), P('105', 'Citizen GO UK', 1000, 'uk1', 40), P('105', 'Citizen GO UK', 1000, 'uk2', 50),
      P('773', 'CitizenGO Magyarország', 90000, 'hu-big', 5), P('773', 'CitizenGO Magyarország', 10000, 'hu1', 40), P('773', 'CitizenGO Magyarország', 10000, 'hu2', 60), P('773', 'CitizenGO Magyarország', 9000, 'hu-old', 80),
      P('154', 'HazteOir.org', 9e6, 'hz', 3), P('154', 'HazteOir.org', 1000, 'hz1', 50) ] } }));
    pages.push({ page_id: '773', name: 'CitizenGO Magyarország' });
    const ls = (a) => call({ ...a });
    const callL = async (args, who = 'chris') => JSON.parse((await ENGINE_TOOLS.find((t) => t.name === 'engine_listening').handler(store, args, { who })).text);
    const cg = await callL({ tab: 'citizengo', team: 'uk' });
    eq('listening, CitizenGO: other Pages beating their own normal; not my team, not HazteOir, not old', cg.posts.map((p) => [p.who, p.text, p.x]), [['CitizenGO Magyarország', 'hu-big', 9]]);
    peer.PEER_TOOLS.find((t) => t.name === 'ally_watch').handler = async (st, a) => ({ rows: [{ username: 'righttolifeuk', label: 'Right To Life UK', country: 'UK', caption: 'Prince Alois', permalink: 'https://ig/1', timestamp: ago(1), like_count: 2000, comments_count: 90, vs_median: 11.4, settled: false }], seen: a });
    peer.PEER_TOOLS.find((t) => t.name === 'opponent_watch').handler = async () => ({ rows: [], ads: [{ label: 'TransActual', delivery_start: ago(2), spend_lower: 100, spend_upper: 199, currency: 'GBP', link_titles: 'Trans rights', snapshot_url: 'https://ads/1' }] });
    const al = await callL({ tab: 'allies', country: 'UK' });
    eq('listening, allies: the ally rows as data', al.posts.map((p) => [p.who, p.x, p.settled]), [['Right To Life UK', 11.4, false]]);
    const op = await callL({ tab: 'opponents' });
    eq('listening, opponents: their ads with spend ranges', op.ads.map((a) => [a.who, a.spend_lower, a.spend_upper, a.running]), [['TransActual', 100, 199, true]]);
    let e = null; try { await callL({}, 'stranger'); } catch (x) { e = x.code; }
    eq('listening: team members only', e, 'ENGINE_NOT_MEMBER');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
