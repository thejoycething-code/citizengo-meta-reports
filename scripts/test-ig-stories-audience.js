#!/usr/bin/env node
'use strict';
// Stories, audience and missed Facebook Reels (5 Nov 2026), against fakes.

const { collectStories, collectAudience } = require('../collector/instagram');
const { collectMissingReels, isListed } = require('../collector/fbreels');
const { callTool } = require('../mcp/tools');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};
const runStarted = new Date('2026-11-06T03:30:00Z');

(async () => {
  console.log('collectStories');
  const calls = [];
  const storyCall = async (path, params) => {
    calls.push({ path, params });
    if (path === '/IG1/stories') return { ok: true, body: { data: [{ id: 'S1', media_type: 'IMAGE', media_url: 'https://x/s1.jpg', timestamp: '2026-11-05T20:00:00+0000', permalink: 'https://ig/s1' }] } };
    if (params.metric === 'navigation') {
      return { ok: true, body: { data: [{ total_value: { breakdowns: [{ results: [
        { dimension_values: ['TAP_FORWARD'], value: 40 }, { dimension_values: ['TAP_BACK'], value: 3 }, { dimension_values: ['TAP_EXIT'], value: 9 },
      ] }] } }] } };
    }
    if (params.metric === 'follows') return { ok: false, error: { code: 100, message: 'not supported' } };
    // Both response shapes Meta uses for media insights.
    if (params.metric === 'reach') return { ok: true, body: { data: [{ values: [{ value: 120 }] }] } };
    return { ok: true, body: { data: [{ total_value: { value: 7 } }] } };
  };
  const st = await collectStories({ ig: { id: 'IG1', username: 'citizengo' }, page: { page_id: 'P1' }, as: {}, call: storyCall, runStarted, collectedDate: '2026-11-06' });
  check('reads the stories edge', calls[0].path === '/IG1/stories');
  check('a story is held as STORY media', st.media.length === 1 && st.media[0].media_product_type === 'STORY' && st.media[0].thumbnail_url === 'https://x/s1.jpg');
  const m = st.metrics[0];
  check('values from either response shape', m.reach === 120 && m.views === 7 && m.replies === 7);
  check('navigation kept as taps by action', m.navigation && m.navigation.tap_forward === 40 && m.navigation.tap_exit === 9);
  check('an unsupported metric is an error, not a zero', m.follows === null && m.errors && m.errors.follows);
  const off = await collectStories({ ig: { id: 'IG2' }, page: { page_id: 'P1' }, as: {}, call: async () => ({ ok: false, error: { message: 'no' } }), runStarted, collectedDate: '2026-11-06' });
  check('a refused stories edge is reported, not thrown', off.error && off.media.length === 0);

  console.log('collectAudience');
  const aCalls = [];
  const audCall = async (path, params) => {
    aCalls.push(params);
    if (params.metric === 'engaged_audience_demographics' && params.breakdown === 'city') return { ok: false, error: { code: 10, message: 'Not enough users' } };
    // follower_demographics refuses without a timeframe, accepts with one.
    if (params.metric === 'follower_demographics' && !params.timeframe) return { ok: false, error: { code: 100, message: 'timeframe required' } };
    return { ok: true, body: { data: [{ total_value: { breakdowns: [{ results: [
      { dimension_values: [params.breakdown === 'gender' ? 'F' : 'ES'], value: 60 }, { dimension_values: [params.breakdown === 'gender' ? 'M' : 'MX'], value: 40 },
    ] }] } }] } };
  };
  const au = await collectAudience({ ig: { id: 'IG1', username: 'citizengo' }, page: { page_id: 'P1' }, as: {}, call: audCall, runStarted, collectedDate: '2026-11-06' });
  check('two kinds x four breakdowns', au.rows.length === 8);
  check('lifetime total_value, one breakdown per call', aCalls.every((c) => c.period === 'lifetime' && c.metric_type === 'total_value' && !String(c.breakdown).includes(',')));
  check('retries follower_demographics with a timeframe once', au.rows.find((r) => r.kind === 'followers' && r.breakdown === 'country').data.ES === 60);
  check('engaged asked for this month', aCalls.filter((c) => c.metric === 'engaged_audience_demographics').every((c) => c.timeframe === 'this_month'));
  const city = au.rows.find((r) => r.kind === 'engaged' && r.breakdown === 'city');
  check('a withheld breakdown is an error, not an empty audience', city.data === null && city.errors.code === 10);
  check('errorCount', au.errorCount === 1);

  console.log('Facebook Reels');
  const listed = [
    { post_id: 'P1_111', permalink_url: 'https://www.facebook.com/reel/222/' },
    { post_id: 'P1_333', permalink_url: 'https://www.facebook.com/P1/posts/333' },
  ];
  check('listed when a post links to /reel/<id>', isListed('222', listed));
  check('listed when a post id ends in the id', isListed('333', listed));
  check('not listed otherwise (and no partial-id match)', !isListed('22', listed) && !isListed('444', listed));
  const rCall = async (path, params) => {
    if (path === '/P1/video_reels') return { ok: true, body: { data: [
      { id: '222', created_time: '2026-11-04T10:00:00+0000' },
      { id: '444', created_time: '2026-11-03T10:00:00+0000', description: 'A reel', permalink_url: '/reel/444/' },
      { id: '555', created_time: '2026-09-01T10:00:00+0000' },
    ] } };
    const val = { blue_reels_play_count: 900, post_impressions_unique: 700, post_video_avg_time_watched: 4500, post_video_view_time: 100000,
      post_video_social_actions: { COMMENT: 5, SHARE: 2 }, post_video_likes_by_reaction_type: { REACTION_LIKE: 30, REACTION_LOVE: 4 } }[params.metric];
    return val === undefined ? { ok: false, error: { code: 100, message: 'x' } } : { ok: true, body: { data: [{ values: [{ value: val }] }] } };
  };
  const fr = await collectMissingReels({ pageId: 'P1', listed, call: rCall, as: {}, since: new Date('2026-10-23T00:00:00Z'), collectedDate: '2026-11-06', runStarted });
  check('reels in the window counted, older ones dropped', fr.reels === 2, String(fr.reels));
  check('only the unlisted reel is added', fr.missing === 1 && fr.posts.length === 1 && fr.posts[0].post_id === 'P1_444');
  check('added as added_reel with a full link', fr.posts[0].status_type === 'added_reel' && fr.posts[0].permalink_url === 'https://www.facebook.com/reel/444/');
  const mm = fr.metrics[0];
  check('plays as views, unique reach, seconds watched', mm.views_total === 900 && mm.views_unique === 700 && mm.video_avg_seconds_watched === 4.5);
  check('reactions, comments and shares', mm.reactions_total === 34 && mm.comments_total === 5 && mm.shares_total === 2);

  console.log('instagram_audience');
  const store = { async igAudience() { return [
    { ig_username: 'citizengo', kind: 'followers', breakdown: 'gender', data: { F: 60, M: 40 }, collected_date: '2026-11-06' },
    { ig_username: 'citizengo', kind: 'followers', breakdown: 'country', data: { ES: 50, MX: 30, AR: 20 }, collected_date: '2026-11-06' },
    { ig_username: 'citizengo_magyar', kind: 'followers', breakdown: 'country', data: null, errors: { code: 10 }, collected_date: '2026-11-06' },
  ]; } };
  const out = await callTool(store, 'instagram_audience', {});
  const cg = out.data.find((r) => r.account === 'citizengo');
  check('shares, largest first, gender named', cg.countries === 'ES 50%, MX 30%, AR 20%' && cg.gender === 'women 60%, men 40%', `${cg.countries} | ${cg.gender}`);
  check('a withheld account is explained', /withheld/.test(out.text));

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
