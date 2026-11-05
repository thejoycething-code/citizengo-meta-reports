#!/usr/bin/env node
'use strict';
// Pins petition sign-ups per post (lib/post-signups.js, post_signups tool,
// scripts/load-link-signature-days.js). Usage: node scripts/test-post-signups.js

const { attribute, localDay } = require('../lib/post-signups');
const { toDayRows } = require('./load-link-signature-days');
const { postSignups } = require('../mcp/link-tools');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

const posts = [
  { platform: 'facebook', post_id: 'A', account_label: 'UK', posted_at: '2026-10-01T09:00:00Z', campaign_code: 'c1', petition_id: '1' },
  { platform: 'facebook', post_id: 'B', account_label: 'Scotland', posted_at: '2026-10-05T09:00:00Z', campaign_code: 'c1', petition_id: '1' },
  { platform: 'facebook', post_id: 'C', account_label: 'Ireland', posted_at: '2026-10-05T18:00:00Z', campaign_code: 'c1', petition_id: '1' },
  { platform: 'x', post_id: 'X1', account_label: '@cgo', posted_at: '2026-10-02T09:00:00Z', campaign_code: 'c1', petition_id: '1' },
];
const days = [
  { campaign_code: 'c1', source: 'fb', day: '2026-09-30', signatures: 7, new_members: 1 },  // before any post
  { campaign_code: 'c1', source: 'fb', day: '2026-10-01', signatures: 100, new_members: 10 },
  { campaign_code: 'c1', source: 'fb', day: '2026-10-04', signatures: 50, new_members: 5 },
  { campaign_code: 'c1', source: 'fb', day: '2026-10-05', signatures: 40, new_members: 4 }, // B and C share
  { campaign_code: 'c1', source: 'fb', day: '2026-10-20', signatures: 10, new_members: 0 },
  { campaign_code: 'c1', source: 'tw', day: '2026-10-02', signatures: 9, new_members: 3 },
  { campaign_code: 'c1', source: 'ig', day: '2026-10-02', signatures: 99, new_members: 9 },  // no IG post: credited to none
];
const { posts: out, unposted } = attribute(posts, days);
const by = Object.fromEntries(out.map((r) => [r.post_id, r]));
check('days before the first post credit no post', unposted.signatures === 7);
check('the first post keeps its days until the next post', by.A.signatures === 150 && by.A.new_members === 15, JSON.stringify(by.A));
check('same-day posts share that day and later ones', by.B.signatures === 25 && by.C.signatures === 25, `${by.B.signatures} ${by.C.signatures}`);
check('first 7 days counted per post', by.A.first_days === 150 && by.B.first_days === 20, `${by.A.first_days} ${by.B.first_days}`);
check('platforms kept apart; an X post gets X arrivals only', by.X1.signatures === 9 && by.X1.shared_with === 0);
check('other posts of the link are counted', by.A.shared_with === 2);
check('posts dated in Madrid time', localDay('2026-10-04T22:30:00Z') === '2026-10-05');

const F = 'petitions_signatures_3_0.';
const dr = toDayRows([
  { [F + 'utm_campaign']: 'ABC-FB1', [F + 'source']: 'fb', [F + 'date_date']: '2026-11-01', [F + 'sum_signatures']: 5, [F + 'sum_new_members']: 2 },
  { [F + 'utm_campaign']: 'abc-fb1', [F + 'source']: 'wa', [F + 'date_date']: '2026-11-01', [F + 'sum_signatures']: 3 },
  { [F + 'utm_campaign']: 'abc-fb1', [F + 'source']: 'fb', [F + 'date_date']: 'bad', [F + 'sum_signatures']: 3 },
], '2026-11-06T00:00:00Z');
check('loader keeps fb/ig/tw days, lowercases codes', dr.length === 1 && dr[0].campaign_code === 'abc-fb1' && dr[0].signatures === 5);

(async () => {
  const store = {
    linkPosts: async () => posts.filter((p) => p.post_id !== 'A'),
    linkPostsByCodes: async () => posts,
    linkSignatureDays: async () => days,
    linkPostReach: async () => [{ post_id: 'B', impressions: 5000 }],
  };
  const res = await postSignups(store, { days: 30 });
  const rb = res.rows.find((r) => r.post_id === 'B');
  check('tool leaves out posts outside the window but still splits with them', !res.rows.some((r) => r.post_id === 'A') && rb.signatures === 25);
  check('per 1,000 reached', rb.per_1k === 5, String(rb.per_1k));
  check('tool says when a link is split', /split by date/.test(res.text));
  const none = await postSignups({ ...store, linkSignatureDays: async () => null }, {});
  check('not loaded yet is said, not shown as zero', /not loaded yet/.test(none.text));
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
