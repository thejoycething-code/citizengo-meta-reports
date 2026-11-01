#!/usr/bin/env node
'use strict';
// Pins the daily UK monitoring digest (mcp/digest-tools.js): which posts,
// hashtags and ads cross a line, that a post is announced on one day only, and
// that a quiet day sends nothing. Usage: node scripts/test-digest.js

const { buildDigest, hashtags, ukDigest, NOTHING } = require('../mcp/digest-tools');

let passed = 0, failed = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failed++; }
}

const now = new Date('2026-11-02T08:00:00Z');
const post = (o) => ({ username: 'u', label: 'U', country: 'UK', stance: 'ally', caption: 'x', permalink: 'https://ig/p', timestamp: '2026-11-01T12:00:00Z', like_count: 900, comments_count: 100, vs_median: 1, ...o });

(async () => {
  eq('hashtags: lower-cased, unique, accents kept', hashtags('Vote #AssistedDying #assisteddying #Ley_Trans #ab'), ['#assisteddying', '#ley_trans']);

  eq('quiet day: nothing to send', buildDigest({ posts: [post({})], ads: [], now }), { nothing: true, text: NOTHING, counts: { opp: 0, ally: 0, converging: 0, adOrgs: 0 } });

  const d = buildDigest({ now, ads: [], posts: [
    post({ username: 'glp', label: 'Good Law Project', stance: 'opponent', country: 'UK', vs_median: 7.2 }),
    post({ username: 'old', label: 'Old', stance: 'opponent', vs_median: 9, timestamp: '2026-10-30T12:00:00Z' }),
    post({ username: 'spuc', label: 'SPUC', vs_median: 5 }),
    post({ username: 'us', label: 'US ally', country: 'US', vs_median: 20 }),
  ] });
  eq('breakouts: yesterday only, 5x and over, UK allies only', d.counts, { opp: 1, ally: 1, converging: 0, adOrgs: 0 });
  eq('breakouts: named with multiple', [d.text.includes('**Good Law Project**: 7.2× its normal'), d.text.includes('US ally'), d.text.includes('**Old**')], [true, false, false]);

  const tag = (username, stance, ts, cap = 'Sign #KillTheBill') => post({ username, label: username, stance, timestamp: ts, caption: cap });
  const conv = buildDigest({ now, ads: [], posts: [
    tag('a', 'opponent', '2026-11-01T09:00:00Z'), tag('b', 'opponent', '2026-11-01T10:00:00Z'), tag('c', 'opponent', '2026-10-31T20:00:00Z'),
    tag('a', 'opponent', '2026-11-01T09:00:00Z', '#OldTag'), tag('b', 'opponent', '2026-11-01T09:00:00Z', '#OldTag'), tag('c', 'opponent', '2026-11-01T09:00:00Z', '#OldTag'),
    tag('d', 'ally', '2026-10-04T09:00:00Z', 'Seen 29 days before the window #OldTag'),
  ] });
  eq('convergence: 3 accounts in 48h, new in 30 days', [conv.counts.converging, conv.text.includes('#killthebill'), conv.text.includes('#oldtag')], [1, true, false]);

  const future = buildDigest({ now, ads: [], posts: [
    tag('a', 'opponent', '2026-11-01T09:00:00Z', '#Later'), tag('b', 'opponent', '2026-11-01T10:00:00Z', '#Later'), tag('c', 'opponent', '2026-11-02T09:00:00Z', '#Later'),
  ] });
  eq('convergence: posts after the digest morning do not count', future.counts.converging, 0);

  const ads = buildDigest({ now, posts: [], ads: [
    { label: 'Dignity in Dying', spend_lower: 100, spend_upper: 199, currency: 'GBP', delivery_start: '2026-11-01', link_titles: 'Sign the letter', snapshot_url: 'https://www.facebook.com/ads/library/?id=1' },
    { label: 'Dignity in Dying', spend_lower: 0, spend_upper: 99, currency: 'GBP', delivery_start: '2026-11-01', link_titles: 'Sign', snapshot_url: 'https://www.facebook.com/ads/library/?id=2' },
    { label: 'Dignity in Dying', spend_lower: 0, spend_upper: 99, currency: 'GBP', delivery_start: '2026-10-31', link_titles: 'Old', snapshot_url: 'https://www.facebook.com/ads/library/?id=3' },
    { label: 'BPAS', spend_lower: 0, spend_upper: 99, currency: 'GBP', delivery_start: '2026-11-01', link_titles: 'Clinic', snapshot_url: 'https://www.facebook.com/ads/library/?id=4' },
  ] });
  eq('ads: grouped, burst flagged at 3', [ads.text.includes('**Dignity in Dying**: 3 new ads ⚠️ burst, spend GBP 100–397'), ads.text.includes('**BPAS**: 1 new ad, ')], [true, true]);
  eq('ads: no token-bearing link', ads.text.includes('access_token'), false);

  const asked = {};
  await ukDigest({ peerRecent: async (q) => { asked.posts = [q.since, q.until]; return []; }, opponentAdsSeen: async (q) => { asked.ads = [q.since, q.until]; return []; } }, { date: '2026-11-02' });
  eq('windows: 32 days of posts up to that morning, ads first seen in the last 24 hours', [asked.posts, asked.ads], [['2026-10-01T08:00:00.000Z', '2026-11-02T08:00:00.000Z'], ['2026-11-01T08:00:00.000Z', '2026-11-02T08:00:00.000Z']]);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
