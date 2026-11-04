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
const { cached, CACHE_MS, convergence, convergenceBuilding, topicsOf, langOf, storyKeys } = require('../mcp/engine-tools');

const pages = [{ page_id: '105', name: 'Citizen GO UK' }, { page_id: '120', name: 'Citizen GO Scotland' }, { page_id: '434', name: 'CitizenGO' }, { page_id: '154', name: 'HazteOir.org' }];
const stub = (list, name, fn) => { list.find((t) => t.name === name).handler = fn; };
stub(tools.TOOLS, 'page_growth', async () => ({ data: {
  facebook: [{ name: 'Citizen GO UK', followers: 10775, reach: 496006, views: 8498, engagements: 112630, newFollows: 807, unfollows: 62, netFollows: 745 },
    { name: 'CitizenGO', followers: 119756, reach: 900000, views: 20000, engagements: 50000, newFollows: 300, unfollows: 100, netFollows: 200 },
    { name: 'HazteOir.org', followers: 324249, reach: 7240000, views: 1, engagements: 1, newFollows: 14361, unfollows: 0, netFollows: 14361 }],
  instagram: [{ name: 'citizengo_uk', followers: 239, newFollowers: 90, unfollows: 3, net: null }, { name: 'hazteoir', followers: 214193, newFollowers: 10903, unfollows: null, net: null }],
} }));
const post = (page_id, page_name, views, msg) => ({ page_id, page_name, views_total: views, message: msg, permalink_url: `https://fb/${msg}`, created_time: '2026-10-20T10:00:00Z', beyond_followers_pct: 80, engagement_rate: 9, media_type: 'photo' });
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
  async engineInbox({ team_ids }) {
    const t = (m) => new Date(Date.now() - m * 60000).toISOString();
    return team_ids[0] === 'uk' ? [
      { kind: 'comment', from_us: false, created_at: t(300), replied_at: t(280), is_ad: true },
      { kind: 'comment', from_us: false, created_at: t(200), replied_at: t(140), is_ad: false },
      { kind: 'comment', from_us: false, created_at: t(100), replied_at: null, is_ad: false },
      { kind: 'message', from_us: false, created_at: t(90), replied_at: null, is_ad: false },
      { kind: 'comment', from_us: true, created_at: t(279), replied_at: null, is_ad: false },
    ] : [];
  },
  async engineInboxActions() {
    const at = new Date(Date.now() - 3600e3).toISOString();
    return [{ action: 'reply', created_at: at }, { action: 'reply', created_at: at }, { action: 'hide', created_at: at, detail: { auto: true } }, { action: 'hide', created_at: at, detail: {} }, { action: 'delete', created_at: at }, { action: 'reply', created_at: '2020-01-01T00:00:00Z' }];
  },
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

  const ib = (await call({ scope: 'team', team: 'uk' })).inbox;
  eq('team Analytics carries the Inbox figures: received, answered, how fast, hidden, auto-hidden, deleted', [ib.comments, ib.messages, ib.answered, ib.answered_pct, ib.median_reply_minutes, ib.replies, ib.hidden, ib.auto_hidden, ib.deleted, ib.on_ads], [3, 1, 2, 50, 40, 2, 1, 1, 1, 1]);
  eq('the CitizenGO-wide view has no Inbox figures', (await call({})).inbox, null);

  // Platform pages.
  {
    const d = await call({ scope: 'team', team: 'uk' });
    eq('team Analytics: a Facebook page (best post, formats, hours) and every Instagram post; none for the CitizenGO view', [d.facebook.best.text, d.facebook.formats.map((f) => [f.format, f.posts]), Array.isArray(d.facebook.hours), d.instagram_all.length, (await call({})).facebook], ['court', [['Photo', 3]], true, 2, null]);
  }

  {
    const saved = tools.TOOLS.find((t) => t.name === 'top_posts').handler;
    stub(tools.TOOLS, 'top_posts', async () => ({ data: { rows: [
      { ...post('105', 'Citizen GO UK', 12859, 'library'), created_time: '2026-10-19T20:23:21Z', permalink_url: 'https://fb/lib' },
      { ...post('120', 'Citizen GO Scotland', 12859, 'library'), created_time: '2026-10-19T21:12:32Z', permalink_url: 'https://fb/lib' },
      post('105', 'Citizen GO UK', 900, 'x1') ] } }));
    eq('a post shared to a second Page counts once, as the original', (await call({ scope: 'team', team: 'uk' })).top_posts.map((p) => [p.page, p.text]), [['Citizen GO UK', 'library'], ['Citizen GO UK', 'x1']]);
    tools.TOOLS.find((t) => t.name === 'top_posts').handler = saved;
  }

  // Convergence.
  eq('story keys: hashtags, whole links and two-word names; no stop-word pairs', storyKeys('Prince Alois of Liechtenstein vetoes it. #ProLife Read righttolife.org.uk/news/alois?x=1 This Friday'), ['#prolife', 'link:righttolife.org.uk/news/alois', 'Prince Alois']);
  {
    const h = (n) => new Date(Date.now() - n * 3600e3).toISOString();
    const rows = [
      { who: 'Right To Life UK', handle: 'rtl', text: 'Prince Alois vetoes the abortion Bill', created_time: h(30) },
      { who: 'Right To Life UK', handle: 'rtl', text: 'Thank you Prince Alois', created_time: h(10) },
      { who: 'SPUC', handle: 'spuc', text: 'Liechtenstein: Prince Alois stands firm', created_time: h(20) },
      { who: 'CARE', handle: 'care', text: 'Prince Alois and the right to life #ProLife', created_time: h(5) },
      { who: 'Live Action', handle: 'la', text: 'Prince Alois said no', created_time: h(60) },
      { who: 'A', handle: 'a', text: '#ProLife weekend', created_time: h(3) }, { who: 'B', handle: 'b', text: '#ProLife', created_time: h(4) },
    ];
    eq('convergence: 3+ accounts on the same story within 48 hours; older posts and a 2-account story do not count', convergence(rows).map((c) => [c.key, c.kind, c.accounts]), [['Prince Alois', 'story', 3], ['#prolife', 'hashtag', 3]]);
    const more = rows.concat([{ who: 'SPUC', handle: 'spuc', text: 'Assisted Suicide Bill vote', created_time: h(6) }, { who: 'SPUC', handle: 'spuc', text: 'Assisted Suicide Bill: write to your MP', created_time: h(2) }]);
    eq('building: one account twice or two accounts, under the alert line; converged stories left out', convergenceBuilding(more, convergence(more)).map((b) => [b.key, b.accounts, b.needs]), [['Assisted Suicide', 1, 2]]);
    eq('topics: keys used by 2+ posts from 2+ accounts', topicsOf(rows.map((r) => ({ ...r, x: 3 }))).map((t) => [t.key, t.posts, t.accounts]).slice(0, 2), [['Prince Alois', 5, 4], ['#prolife', 3, 3]]);
  }
  eq('language from common words', [langOf('Stop the UN from turning your beliefs into a crime and we are with you'), langOf('Firma la petición para que el gobierno no apruebe la ley'), langOf('Nie dla aborcji, to jest życie i nie'), langOf('Amen 🙏'), langOf('Vamos a recordar a diario este vídeo del indecente Óscar Puente hasta que dimita o sea cesado. ¡Firma ahora para exigir su dimisión!'), langOf('Você também pode assinar a petição, não é muito')], ['en', 'es', 'pl', null, 'es', 'pt']);

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

  {
    const mem = {}; let runs = 0;
    const cs = { async engineCacheGet(k) { return mem[k] || null; }, async engineCacheSet(k, v) { mem[k] = { value: v, computed_at: new Date().toISOString() }; } };
    const compute = async () => { runs++; return { raw: true, text: JSON.stringify({ n: runs }) }; };
    const a = JSON.parse((await cached(cs, 'k', {}, compute)).text);
    const b = JSON.parse((await cached(cs, 'k', {}, compute)).text);
    const c = JSON.parse((await cached(cs, 'k', { fresh: true }, compute)).text);
    mem.k.computed_at = new Date(Date.now() - CACHE_MS - 1000).toISOString();
    const d = JSON.parse((await cached(cs, 'k', {}, compute)).text);
    const e = JSON.parse((await cached(cs, 'bad', {}, async () => ({ raw: true, text: JSON.stringify({ ok: false }) }))).text);
    eq('cache: a repeat is served from the cache; fresh and expired recalculate; refusals are not kept', [a.n, b.n, c.n, d.n, !!b.cached_at, e.ok, 'bad' in mem], [1, 1, 2, 3, true, false, false]);
  }
  {
    const AX = require('../lib/analytics-extra');
    const now = Date.parse('2026-11-02T12:00:00Z');
    const d = AX.dailySeries([{ page_id: 'p1', metric_date: '2026-11-01', media_view_unique: 10, post_engagements: 2, daily_follows: 3, daily_unfollows: 1 }, { page_id: 'p1', metric_date: '2026-11-01', media_view_unique: 5 }, { page_id: 'other', metric_date: '2026-11-01', media_view_unique: 99 }], new Set(['p1']), { now, days: 3 });
    eq('analytics: daily lines for the Pages in scope', [d.dates.join(','), d.reach.join(','), d.net.join(',')], ['2026-10-30,2026-10-31,2026-11-01', ',,15', ',,2']);
    const cur = AX.totals([{ reach: 120, netFollows: 5 }], [{ newFollowers: 3 }], []), prev = AX.totals([{ reach: 100, netFollows: 9 }], [], []);
    eq('analytics: change against the window before', [AX.changes(cur, prev).reach, AX.changes(cur, prev).net_follows], [20, -44]);
    const w = AX.whatChanged({ kpis: cur, prev, days: 30, detail: { formats: [{ format: 'Reel', posts: 4, median_views: 900 }, { format: 'Photo', posts: 5, median_views: 300 }], hours: [] }, top: [], sig: { total: 50 }, sigPrev: { total: 40 } });
    eq('analytics: what changed, from the figures', w.map((x) => x.icon).join(','), 'up,format,down,sign');
    const c = AX.campaigns([
      { id: 'a', title: 'A', action_url: 'https://citizengo.org/en-gb/isabel?x=1', action_title: 'Free Isabel', signatures: 30, new_members: 5, by_platform: { facebook: 30 }, urls: ['https://www.facebook.com/uk/posts/123456789012'], posted_at: '2026-10-30' },
      { id: 'b', title: 'B', action_url: 'https://www.citizengo.org/en-gb/isabel', signatures: 10, new_members: 1, by_platform: { instagram: 10 }, urls: ['https://www.instagram.com/p/XYZ/'], posted_at: '2026-10-31' },
      { id: 'c', title: 'C', action_url: 'https://citizengo.org/en-gb/hospices', signatures: 0, urls: [] }],
      { fbRows: [{ permalink_url: 'https://www.facebook.com/123456789012', views_total: 5000 }], igRows: [{ permalink: 'https://www.instagram.com/p/XYZ', reach: 800 }] });
    eq('analytics: campaigns grouped by petition with views and signatures per 1k', [c.length, c[0].title, c[0].signatures, c[0].views, c[0].ig_reach, c[0].per_1k, c[0].by_platform.instagram], [2, 'Free Isabel', 40, 5000, 800, 8, 10]);
  }
  {
    const AX = require('../lib/analytics-extra');
    const { topicsOf } = require('../lib/listen-topics');
    const rows = [];
    for (let i = 0; i < 24; i++) rows.push({ page_id: 'p', views_total: i % 2 ? 900 : 300, engagement_rate: i % 2 ? 4 : 2, created_time: `2026-10-${String(5 + (i % 7)).padStart(2, '0')}T${i % 2 ? '19' : '09'}:00:00Z`,
      message: i % 2 ? 'Peers vote on assisted suicide today?' : 'A much longer post about many things that go on and on with lots of words in it to read, more than twenty five words in all for sure here', media_type: i % 2 ? 'reel' : 'photo' });
    const w = AX.works(rows, { med: { p: 600 }, ukParts: (iso) => { const d = new Date(iso); return { weekday: (d.getUTCDay() + 6) % 7, hour: d.getUTCHours() }; }, topicsOf, langOf: () => 'en', fbFormat: (r) => (r.media_type === 'reel' ? 'Reel' : 'Photo') });
    eq('what works: formats, topics and habits from the posts', [w.posts, w.formats[0].key, w.formats[0].median_views, w.topics[0].key, w.habits.map((h) => h.label).includes('Short text'), w.habits.find((h) => h.label === 'Short text').ratio], [24, 'Reel', 900, 'assisted-dying', true, 2]);
    eq('what works: heat map cells need two posts', [w.heat.length, w.heat[0].length, w.heat.flat().filter((c) => c && c.median_views).length > 0], [7, 8, true]);
    const now = Date.parse('2026-11-02T12:00:00Z');
    const wk = AX.weeklyByGroup([{ page_id: 'a', metric_date: '2026-10-27', media_view_unique: 5 }, { page_id: 'a', metric_date: '2026-10-28', media_view_unique: 7 }, { page_id: 'b', metric_date: '2026-10-27', media_view_unique: 1 }], { uk: new Set(['a']), ie: new Set(['b']) }, { now, weeks: 2 });
    eq('countries: weekly reach per team', [wk.weeks.join(','), wk.series.uk.join(','), wk.series.ie.join(',')], ['2026-10-19,2026-10-26', ',12', ',1']);
  }
  {
    // Round two (3 Nov 2026): the report, peaks, conversations and ranked posts.
    const AX = require('../lib/analytics-extra');
    const G = [], P = [], GP = [];
    const ids = new Set(['p1', 'p2']);
    AX.datesBetween('2026-10-01', '2026-10-05').forEach((d, i) => {
      G.push({ page_id: 'p1', metric_date: d, followers_snapshot: 100 + i, daily_follows: 3, daily_unfollows: 1, net_follows: 2, media_view: i === 3 ? 900 : 100, media_view_unique: i === 3 ? 600 : 50, post_engagements: 10, video_views: 5, video_view_time_ms: 60000, post_reactions_by_type: { like: 8, love: 2 } });
      if (i !== 2) G.push({ page_id: 'p2', metric_date: d, followers_snapshot: 50, media_view: 10, media_view_unique: 5 });
      G.push({ page_id: 'other', metric_date: d, followers_snapshot: 9999, media_view: 9999 });
    });
    AX.datesBetween('2026-09-26', '2026-09-30').forEach((d) => GP.push({ page_id: 'p1', metric_date: d, daily_follows: 1, daily_unfollows: 1, net_follows: 0, media_view: 100, media_view_unique: 50 }));
    P.push({ page_id: 'p1', page_name: 'UK', created_time: '2026-10-04T09:00:00Z', views_total: 800, views_unique: 500, views_from_nonfollowers: 400, reactions_total: 30, comments_total: 10, shares_total: 5, clicks_total: 5, message: 'big one', permalink_url: 'u1' });
    P.push({ page_id: 'p1', page_name: 'UK', created_time: '2026-10-01T09:00:00Z', views_total: 200, views_unique: 100, views_from_nonfollowers: 0, reactions_total: 6, comments_total: 2, shares_total: 1, clicks_total: 1, message: 'small', permalink_url: 'u2' });
    const R = AX.report({ growth: G, growthPrev: GP, posts: P, postsPrev: [], pageIds: ids, from: '2026-10-01', to: '2026-10-05', cfrom: '2026-09-26', cto: '2026-09-30', med: { p1: 400 } });
    eq('report: followers carried forward when a Page misses a day', R.daily.followers, [150, 151, 152, 153, 154]);
    eq('report: new, lost and net, other Pages left out', [R.totals.follows, R.totals.unfollows, R.totals.net_follows, R.totals.views], [15, 5, 10, 1340]);
    eq('report: engagement by type on the day posted, per post and rates', [R.daily.reactions.join(','), R.totals.engagements, R.totals.per_post, R.totals.rate_per_view, R.totals.beyond_pct], ['6,0,0,30,0', 60, 30, 6, 40]);
    eq('report: reactions by type and change against the window before', [R.reactions_by_type.map((r) => `${r.key}:${r.pct}`).join(','), R.change.net_follows, R.change.views], ['like:80,love:20', null, 168]);
    eq('report: a peak names the post behind it', R.peaks.map((p) => [p.date, p.post && p.post.text, p.post && p.post.x_median]), [['2026-10-04', 'big one', 2]]);
    eq('ranked: biggest first, against the Page normal', AX.ranked(P, { med: { p1: 400 } }).map((r) => [r.rank, r.views, r.x_median]), [[1, 800, 2], [2, 200, 0.5]]);
    const items = [
      { id: 'a', kind: 'comment', thread_id: 't1', post_text: 'Post one', created_at: '2026-10-02T08:30:00Z', replied_at: '2026-10-02T09:30:00Z', text: 'thank you' },
      { id: 'b', kind: 'comment', thread_id: 't1', post_text: 'Post one', created_at: '2026-10-02T19:00:00Z', replied_at: null, text: 'disgusting' },
      { id: 'c', kind: 'message', thread_id: 'm1', created_at: '2026-10-03T10:00:00Z', replied_at: null, text: 'hello there' },
      { id: 'd', kind: 'comment', thread_id: 't1', from_us: true, created_at: '2026-10-02T09:30:00Z', text: 'thanks' },
    ];
    const acts = [{ item_id: 'a', action: 'reply', by: 'chris', created_at: '2026-10-02T09:30:00Z' }, { item_id: 'c', action: 'private_reply', by: 'x', detail: { automation_id: 1 }, created_at: '2026-10-03T10:00:05Z' }, { item_id: 'b', action: 'hide', by: 'chris', created_at: '2026-10-02T19:10:00Z' }];
    const C = AX.conversations(items, acts, { dates: AX.datesBetween('2026-10-01', '2026-10-05'), hourOf: (iso) => new Date(iso).getUTCHours(), toneOf: (t) => (/thank/.test(t) ? 'positive' : /disgust/.test(t) ? 'negative' : 'neutral') });
    eq('conversations: in and answered each day, our own left out', [C.daily.in.join(','), C.daily.answered.join(',')], ['0,2,1,0,0', '0,1,0,0,0']);
    eq('conversations: tone, who replied and how fast, busiest posts, hours', [C.tones.positive, C.tones.negative, C.people.map((p) => `${p.who}:${p.replies}+${p.private}:${p.median_reply_minutes}`).join(','), C.busiest[0].comments, C.busiest[0].answered_pct, C.hours[8]], [33, 33, 'chris:1+0:60,auto:0+1:null', 2, 50, 1]);
    const r1 = await call({ scope: 'team', team: 'uk', from: '2026-10-10', to: '2026-10-01' });
    eq('range: start after end is refused', r1.error, 'The start date is after the end date.');
    const r2 = await call({ scope: 'team', team: 'uk', from: day(9), to: day(0), fresh: true });
    eq('range: a chosen window returns the report with the days just before to compare', [r2.custom, r2.report.dates.length, r2.report.compare_to, !!r2.talk, Array.isArray(r2.ranked)], [true, 10, day(10), true, true]);
    const r3 = await call({ scope: 'team', team: 'uk', days: 30, fresh: true });
    eq('presets carry the round-two report too', [r3.report.dates.length, r3.report.totals.net_follows > 0, !!r3.talk], [30, true, true]);
  }
  {
    // Leaderboard (37E + 37C): CitizenGO Pages only, this window and the one before, fair measures.
    const recent = new Date(Date.now() - 3 * 864e5).toISOString(), older = new Date(Date.now() - 40 * 864e5).toISOString();
    store.loadAll = async () => ({ pages, posts: [{ page_id: '105', created_time: recent }, { page_id: '105', created_time: recent }, { page_id: '434', created_time: recent }, { page_id: '105', created_time: older }, { page_id: '154', created_time: recent }] });
    const lb = await call({ scope: 'leaderboard', fresh: true });
    const uk = lb.pages.find((p) => p.name === 'Citizen GO UK');
    eq('leaderboard: CitizenGO Pages only (HazteOir apart), team marked, nothing viewer-specific in the shared cache', [lb.scope, lb.pages.map((p) => p.name).sort(), 'mine' in uk, uk.team], ['leaderboard', ['Citizen GO UK', 'CitizenGO'], false, 'uk']);
    eq('leaderboard: posts per window, per post, per 1k followers, growth', [uk.cur.posts, uk.prev.posts, uk.cur.per_post, uk.cur.per_1k, uk.cur.growth], [2, 1, 56315, 10452.9, 7.4]);
    eq('leaderboard: best post of the window, against its own Page median', [uk.best.text, uk.best.x > 1], ['uk-big', true]);
    store.loadAll = async () => ({ pages });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
