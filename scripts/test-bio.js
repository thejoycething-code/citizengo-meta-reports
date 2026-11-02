#!/usr/bin/env node
'use strict';
// Link in bio (lib/bio.js, api/bio.js, the engine_bio tool): recent campaigns
// are found per team and de-duplicated, saved buttons win over auto ones,
// dates and hiding work, the page escapes what people type, and a click is
// counted and sent on as a BIO tracked link (or the plain link if Copilot fails).
// Usage: node scripts/test-bio.js

let passed = 0, failed = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${name}`); passed++; } else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failed++; }
}
const B = require('../lib/bio');
const now = Date.parse('2026-11-02T12:00:00Z');
const accounts = [{ key: 'uk-fb', page_id: '105', platform: 'facebook' }, { key: 'uk-ig', ig_id: '178', platform: 'instagram' }, { key: 'uk-x', handle: 'CitizenGO_GB', platform: 'x' }];
const rows = [
  { platform: 'x', account_id: '9', account_label: '@CitizenGO_GB', full_url: 'https://citizengo.org/en-gb/fr/19691-sacked-for-being--pro-life---send-anita-your-support?utm_source=tw', petition_id: '19691', posted_at: '2026-10-29T13:05:40Z' },
  { platform: 'facebook', account_id: '105', account_label: 'Citizen GO UK', full_url: 'https://citizengo.org/en-gb/fr/19691?campaign=X&utm_source=fb', petition_id: '19691', posted_at: '2026-10-28T10:00:00Z' },
  { platform: 'facebook', account_id: '105', account_label: 'Citizen GO UK', full_url: 'https://citizengo.org/en-gb/lf/19389?campaign=Y', petition_id: '19389', posted_at: '2026-10-22T19:12:18Z' },
  { platform: 'facebook', account_id: '999', account_label: 'CitizenGO España', full_url: 'https://citizengo.org/es-es/fr/1-x', petition_id: '1', posted_at: '2026-11-01T10:00:00Z' },
  { platform: 'facebook', account_id: '105', account_label: 'Citizen GO UK', full_url: 'https://citizengo.org/en-gb/fr/100-old', petition_id: '100', posted_at: '2026-09-01T10:00:00Z' },
  { platform: 'facebook', account_id: '105', account_label: 'Citizen GO UK', full_url: 'https://example.com/x', petition_id: '5', posted_at: '2026-11-01T10:00:00Z' },
];
eq('cleanItem: a hand-added petition link gets its petition id (so it goes out tracked)', [B.cleanItem({ title: 'Help', url: 'https://citizengo.org/en-gb/fr/19691-sacked?x=1' }).petition_id, B.cleanItem({ title: 'Donate', url: 'https://example.com/give/12345' }).petition_id, B.cleanItem({ url: 'https://citizengo.org/en-gb/fr/1', petition_id: '777' }).petition_id], ['19691', null, '777']);
const auto = B.autoItems(rows, { accounts, titles: { 19389: 'Crimes against humanity' }, now });
eq('auto: the team\'s petitions only, one each, newest first, last 30 days', auto.map((a) => [a.id, a.url, a.posts]), [['p19691', 'https://citizengo.org/en-gb/fr/19691', 2], ['p19389', 'https://citizengo.org/en-gb/lf/19389', 1]]);
eq('auto: titles from the posts, else from the link', auto.map((a) => a.title), ['Sacked for being pro life send anita your support', 'Crimes against humanity']);

const bio = { slug: 'uk', title: 'CitizenGO UK', auto: true, items: [
  { id: 'don', title: 'Donate', url: 'https://citizengo.org/en-gb/donate', pinned: true },
  { id: 'p19389', title: 'Stop crimes against humanity', url: 'https://citizengo.org/en-gb/lf/19389', petition_id: '19389', auto: true, featured: true },
  { id: 'old', title: 'Ended', url: 'https://citizengo.org/x', ends: '2026-11-01' },
  { id: 'soon', title: 'Not yet', url: 'https://citizengo.org/y', starts: '2026-11-05' },
  { id: 'bad', title: 'Insecure', url: 'http://citizengo.org/z' },
] };
const r = B.resolve(bio, auto, { now });
eq('resolve: pinned first, saved retitle wins over auto, dated ones and http left out', r.shown.map((i) => i.id), ['don', 'p19389', 'p19691']);
eq('resolve: a saved auto item keeps its title and feature', [r.shown[1].title, r.shown[1].featured], ['Stop crimes against humanity', true]);
eq('resolve: auto off shows saved only', B.resolve({ ...bio, auto: false }, auto, { now }).shown.map((i) => i.id), ['don', 'p19389']);
eq('resolve: hidden is left out', B.resolve({ ...bio, items: [{ ...bio.items[0], hidden: true }] }, auto, { now }).shown.map((i) => i.id), ['p19691', 'p19389']);
eq('settings: slug checked', [B.checkSettings({ slug: 'UK' }).slug, !!B.checkSettings({ slug: 'a b' }).error, !!B.checkSettings({ slug: '-x' }).error], ['uk', true, true]);
const html = B.pageHtml({ bio: { ...bio, title: '<script>x</script>' }, items: [{ id: 'a"b', title: '<b>Hi</b>' }] });
eq('page: what people typed is escaped', [html.includes('<script>x'), html.includes('&lt;b&gt;Hi'), html.includes('/links/uk/go/a%22b')], [false, true, true]);

// The public endpoint, against a fake store.
const handler = require('../api/bio');
function fakeStore({ copilotFails = false } = {}) {
  const clicks = [], tracked = new Map();
  return {
    clicks,
    async engineBio({ slug }) { return slug === 'uk' ? { team_id: 'uk', ...bio } : null; },
    async engineTeams() { return [{ id: 'uk', name: 'United Kingdom', accounts }]; },
    async linkPostsSince() { return rows; },
    async enginePosts() { return []; },
    async engineBioClick(slug, id) { clicks.push([slug, id]); return true; },
    async engineCopilotAuth() { return { owner: 'CJO' }; },
    async engineTrackedLink(code) { return tracked.get(code) || null; },
    async engineSaveTrackedLink(row) { tracked.set(row.code, row); return row; },
    async copilotCall() { if (copilotFails) throw new Error('down'); },
  };
}
function run(url, store) {
  handler._setStore(store);
  return new Promise((resolve) => {
    const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { resolve({ status: this.statusCode, headers: this.headers, body: String(b || '') }); } };
    handler({ method: 'GET', url }, res);
  });
}
(async () => {
  const realNow = Date.now; Date.now = () => now;
  const s = fakeStore();
  const page = await run('/api/bio?slug=uk', s);
  eq('endpoint: page lists the buttons', [page.status, (page.body.match(/class="b/g) || []).length, page.headers['content-security-policy'].includes("default-src 'none'")], [200, 3, true]);
  eq('endpoint: unknown page is a 404', (await run('/api/bio?slug=nope', s)).status, 404);
  const hand = await run('/api/bio?slug=uk&go=don', s);
  eq('endpoint: a hand-added button goes straight to its link and counts', [hand.status, hand.headers.location, s.clicks], [302, 'https://citizengo.org/en-gb/donate', [['uk', 'don']]]);
  const T = require('../lib/tracked');
  const orig = T.trackLink;
  T.trackLink = async (o) => { const p = T.plan({ petition: T.petitionOf(o.url), info: {}, platform: o.platform, mark: o.mark, who: o.who, owner: o.owner, now: o.now }); return { to: p.long, code: p.code, via: 'long' }; };
  const pet = await run('/api/bio?slug=uk&go=p19691', s);
  eq('endpoint: a petition goes out marked BIO, dated by its first post', [pet.status, /utm_campaign=EN_GB-2026_10_29-BIO_/.test(pet.headers.location), /utm_source=ig/.test(pet.headers.location)], [302, true, true]);
  T.trackLink = async () => { throw new Error('Copilot down'); };
  const plain = await run('/api/bio?slug=uk&go=p19691', s);
  eq('endpoint: if tracking fails the plain link still works', plain.headers.location, 'https://citizengo.org/en-gb/fr/19691');
  T.trackLink = orig;
  const gone = await run('/api/bio?slug=uk&go=old', s);
  eq('endpoint: an ended button sends people back to the page', [gone.status, gone.headers.location], [302, '/links/uk']);
  Date.now = realNow;
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
