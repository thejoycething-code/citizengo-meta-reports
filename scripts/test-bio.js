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
eq('resolve: pinned first, then new campaigns, then saved ones in their order; dated and http left out', r.shown.map((i) => i.id), ['don', 'p19691', 'p19389']);
eq('resolve: a saved auto item keeps its title and feature', [r.shown[2].title, r.shown[2].featured], ['Stop crimes against humanity', true]);
eq('resolve: why the others are off', r.all.filter((i) => i.why).map((i) => [i.id, i.why]), [['old', 'ended'], ['soon', 'not_yet']]);
eq('resolve: auto off shows saved only', B.resolve({ ...bio, auto: false }, auto, { now }).shown.map((i) => i.id), ['don', 'p19389']);
eq('resolve: removed is left out, and a removed campaign does not come back by itself', B.resolve({ ...bio, items: [{ ...bio.items[0], hidden: true }, { id: 'p19691', url: 'https://citizengo.org/en-gb/fr/19691', petition_id: '19691', auto: true, removed: true }] }, auto, { now }).shown.map((i) => i.id), ['p19389']);
{
  const its = [
    { id: 'a', title: 'A', url: 'https://citizengo.org/en-gb/fr/1', petition_id: '1' },
    { id: 'w', title: 'Won', url: 'https://citizengo.org/en-gb/fr/2', petition_id: '2', won: true, won_at: '2026-10-20' },
    { id: 'wold', title: 'Old win', url: 'https://citizengo.org/en-gb/fr/3', petition_id: '3', won: true, won_at: '2026-09-01' },
    { id: 'c', title: 'Closed', url: 'https://citizengo.org/en-gb/fr/4', petition_id: '4', closed: true },
    { id: 'q', title: 'Quiet', url: 'https://citizengo.org/en-gb/fr/5', petition_id: '5' },
    { id: 'qp', title: 'Quiet but pinned', url: 'https://citizengo.org/en-gb/fr/6', petition_id: '6', pinned: true },
    { id: 'as', title: 'Closed in Asana', url: 'https://citizengo.org/en-gb/fr/7', petition_id: '7' },
    { id: 'pr', title: 'Pray', url: 'https://citizengo.org/en-gb/fr/8', petition_id: '8', section: 'Pray with us', cd_date: '2026-11-06', cd_label: 'Council decides' },
    { id: 'don', title: 'Donate', url: 'https://citizengo.org/en-gb/donate' },
  ];
  const status = { 5: { total: 900, last14: 0 }, 6: { total: 900, last14: 0 }, 7: { total: 10, last14: 4, asana_closed: true }, 1: { total: 10812, last14: 300 } };
  const rr = B.resolve({ auto: false, items: its }, [], { now, status });
  eq('resolve: won for 30 days, closed, quiet (14 days, unless pinned) and Asana-closed', rr.all.map((i) => [i.id, i.why]), [['qp', null], ['a', null], ['w', null], ['wold', 'won_old'], ['c', 'closed'], ['q', 'quiet'], ['as', 'asana'], ['pr', null], ['don', null]]);
  eq('resolve: sections (petitions to Act now, links to Get involved, wins to Recent wins)', rr.shown.map((i) => i.section), ['Act now', 'Act now', 'Recent wins', 'Pray with us', 'Get involved']);
  eq('resolve: the quiet rule can be switched off', B.resolve({ auto: false, items: its, settings: { quiet: false } }, [], { now, status }).all.find((i) => i.id === 'q').why, null);
  eq('hero: featured, else the one a post asked for, else the newest in Act now', [B.pickHero(rr.shown).id, B.pickHero([{ ...rr.shown[1], lead: true }, ...rr.shown]).id, B.pickHero(rr.shown.map((i) => (i.id === 'pr' ? { ...i, featured: true } : i))).id], ['qp', 'a', 'pr']);
  eq('goal: a round number a little above the total', [B.goalFor(10812), B.goalFor(950), B.goalFor(4400), B.goalFor(2400000)], [15000, 2500, 5000, 3000000]);
  eq('countdown: in N days, tomorrow, today, gone after', ['2026-11-06', '2026-11-03', '2026-11-02', '2026-11-01'].map((d) => B.countdownText({ cd_date: d, cd_label: 'Council decides' }, '2026-11-02')), ['Council decides in 4 days', 'Council decides tomorrow', 'Council decides today', null]);
  eq('socials: one per platform, plus the WhatsApp channel', B.socialsFor([...accounts, { platform: 'facebook', page_id: '2' }, { platform: 'instagram', handle: 'citizengo_uk' }], { whatsapp_url: 'https://whatsapp.com/channel/x' }).map((x) => x.url), ['https://www.facebook.com/105', 'https://x.com/CitizenGO_GB', 'https://www.instagram.com/citizengo_uk', 'https://whatsapp.com/channel/x']);
  const page = B.pageHtml({ bio: { slug: 'uk', title: 'CitizenGO UK', settings: { donate_url: 'https://citizengo.org/en-gb/donate' } }, items: rr.shown, hero: rr.shown[1], status, origin: 'https://x.test', src: 'ig', today: '2026-11-02', grid: [{ img: 'https://scontent.cdninstagram.com/a.jpg', href: 'https://x.test/links/uk/go/a' }], socials: [{ platform: 'x', url: 'https://x.com/a' }] });
  eq('page: hero with total and goal, WhatsApp share, copy, source carried on links', [page.includes('10,812</b> signed · help reach 15,000'), page.includes('https://wa.me/?text=A%20https%3A%2F%2Fx.test%2Flinks%2Fuk%2Fgo%2Fa%3Fs%3Dwa'), page.includes('data-copy="https://x.test/links/uk/go/a?s=wa"'), page.includes('href="https://x.test/links/uk/go/w?s=ig"')], [true, true, true, true]);
  eq('page: sections in order with wins last, Donate, grid, icons, share preview', [page.indexOf('<h2>Act now') < page.indexOf('<h2>Pray with us') && page.indexOf('<h2>Pray with us') < page.indexOf('<h2>Recent wins'), page.includes('>Donate</a>'), page.includes('Latest on Instagram'), page.includes('aria-label="X"'), page.includes('og:title')], [true, true, true, true, true]);
  eq('page: the hero is not repeated in the list', (page.match(/go\/a\?s=ig/g) || []).length, 1);
  eq('page: the copy script matches the CSP hash', page.includes('<script>') && B.COPY_HASH.startsWith('sha256-'), true);
  eq('leadFromPosts: newest posted Instagram post with the bio box left ticked', B.leadFromPosts([
    { status: 'posted', doc: { posting: { destinations: ['uk-ig'] }, action: { url: 'https://citizengo.org/en-gb/fr/19734-x', petitionId: '19734', title: 'Councillor' }, posted: { at: '2026-11-01T10:00:00Z' } } },
    { status: 'posted', doc: { posting: { destinations: ['uk-ig'], link_in_bio: false }, action: { url: 'https://citizengo.org/en-gb/fr/1-x' }, posted: { at: '2026-11-02T10:00:00Z' } } },
    { status: 'posted', doc: { posting: { destinations: ['uk-fb'] }, action: { url: 'https://citizengo.org/en-gb/fr/2-x' }, posted: { at: '2026-11-02T11:00:00Z' } } },
    { status: 'scheduled', doc: { posting: { destinations: ['uk-ig'] }, action: { url: 'https://citizengo.org/en-gb/fr/3-x' }, posted: {} }, post_at: '2026-11-03T10:00:00Z' },
  ], { now }), { url: 'https://citizengo.org/en-gb/fr/19734-x', petition_id: '19734', title: 'Councillor', at: '2026-11-01T10:00:00Z' });
  eq('autoItems: the post\'s petition leads, even before the collection sees it', B.autoItems(rows, { accounts, now, lead: { url: 'https://citizengo.org/en-gb/fr/19734-x', petition_id: '19734', title: 'Councillor', at: '2026-11-01T10:00:00Z' } }).map((a) => [a.id, !!a.lead]), [['p19734', true], ['p19691', false], ['p19389', false]]);
  eq('routeCountry: a country\'s page, else the global page, else the picker', [B.routeCountry('GB', [{ team_id: 'uk', slug: 'uk' }, { team_id: 'global', slug: 'cg' }]), B.routeCountry('FR', [{ team_id: 'uk', slug: 'uk' }, { team_id: 'global', slug: 'cg' }]), B.routeCountry('FR', [{ team_id: 'uk', slug: 'uk' }])], ['uk', 'cg', null]);
  eq('settings: links must be https, switches default on', B.cleanSettings({ donate_url: 'http://x', emails_url: 'https://e.test', grid: false }), { donate_url: null, emails_url: 'https://e.test', whatsapp_url: null, grid: false, socials: true, totals: true, quiet: true });
}
// QR codes: Reed-Solomon against the standard's worked example ("HELLO WORLD", 1-M).
{
  const Q = require('../lib/qr');
  eq('qr: error correction matches the standard example', Q._rsRemainder([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17], Q._rsDivisor(10)), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  const m = Q.encode('https://meta-organic-reporting.vercel.app/links/uk?s=qr');
  eq('qr: picks the smallest version (4 here) with finder corners in place', [m.length, m[0][0], m[0][6], m[6][6], m[1][1], m[0][m.length - 1], m[m.length - 1][0]], [33, true, true, true, false, true, true]);
  eq('qr: too long is refused', (() => { try { Q.encode('x'.repeat(300)); return 'made'; } catch (e) { return 'refused'; } })(), 'refused');
}
eq('settings: slug checked', [B.checkSettings({ slug: 'UK' }).slug, !!B.checkSettings({ slug: 'a b' }).error, !!B.checkSettings({ slug: '-x' }).error], ['uk', true, true]);
const html = B.pageHtml({ bio: { ...bio, title: '<script>x</script>' }, items: [{ id: 'a"b', title: '<b>Hi</b>' }] });
eq('page: what people typed is escaped', [html.includes('<script>x'), html.includes('&lt;b&gt;Hi'), html.includes('/links/uk/go/a%22b')], [false, true, true]);

// The nightly petition status pull (scripts/load-petition-status.js).
{
  const P = require('./load-petition-status');
  const ev = (content) => JSON.stringify({ type: 'assistant', message: { content } });
  const res = (id, rows) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: JSON.stringify(rows) }] }] } });
  const stream = [ev([{ type: 'tool_use', id: 'a', name: 'mcp__claude_ai_CitizenGO_Looker__get_explore' }]), res('a', []),
    ev([{ type: 'tool_use', id: 'q1', name: 'mcp__claude_ai_CitizenGO_Looker__query' }]), res('q1', [{ 'petitions_signatures_3_0.petition_id': 17968, 'petitions_signatures_3_0.sum_signatures': 27012 }, { 'petitions_signatures_3_0.petition_id': 100, 'petitions_signatures_3_0.sum_signatures': 900 }]),
    ev([{ type: 'tool_use', id: 'q2', name: 'mcp__claude_ai_CitizenGO_Looker__query' }]), res('q2', [{ 'petitions_signatures_3_0.petition_id': 17968, 'petitions_signatures_3_0.sum_signatures': 140 }])].join('\n');
  eq('status: Bluebook totals and last 14 days per petition (no row = none lately)', P.totalsFrom(P.queriesFromStream(stream)), { 17968: { total: 27012, last14: 140 }, 100: { total: 900, last14: 0 } });
  const nid = [ev([{ type: 'tool_use', id: 'n1', name: 'mcp__claude_ai_CitizenGO_Looker__query' }]), res('n1', [{ 'petitions_signatures_3_0.nid': '19439', 'petitions_signatures_3_0.sum_signatures': 5120 }])].join('\n');
  eq('status: the Bluebook\'s petition id field is nid', P.totalsFrom(P.queriesFromStream(nid)), { 19439: { total: 5120, last14: null } });
  const reply = JSON.stringify({ type: 'result', result: 'Here: [{"name":"EN_GB - Stop the banning of church outreach in Colchester - 04/2026","completed":false,"archived":false,"evaluated":true,"status_updated":true},{"name":"EN_GB - Sacked for being Pro-Life: Send Anita your support - 10/2026","completed":false,"archived":false,"evaluated":false,"status_updated":false},{"name":"ES_ES - Stop the banning of church outreach in Colchester - 04/2026","completed":true},{"name":"Campaigns calendar"}]' });
  const projects = P.projectsFrom(P.finalText(reply));
  eq('status: the Asana project list from Claude\'s reply', projects.length, 4);
  const pets = P.petitionsFrom([{ petition_id: '17968', full_url: 'https://citizengo.org/en-gb/fr/17968-stop-the-banning-of-church-outreach-in-colchester?x=1' }, { petition_id: '19691', full_url: 'https://citizengo.org/en-gb/fr/19691-sacked-for-being--pro-life---send-anita-your-support' }, { petition_id: '19734', full_url: 'https://citizengo.org/en-gb/fr/19734-dont-punish-reform-councillor' }]);
  eq('status: projects matched by list and title words; evaluated = closed, status task = won hint', P.matchProjects(projects, pets), { 17968: { name: 'EN_GB - Stop the banning of church outreach in Colchester - 04/2026', closed: true, victory: true }, 19691: { name: 'EN_GB - Sacked for being Pro-Life: Send Anita your support - 10/2026', closed: false, victory: false } });
  eq('status: project names parsed', [P.parseProject('EN_GB - A b c - 04/2026'), P.parseProject('Campaigns calendar')], [{ list: 'en_gb', title: 'A b c' }, null]);
}

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
    async engineBios() { return [{ team_id: 'uk', slug: 'uk', title: 'CitizenGO UK' }]; },
    async petitionStatus() { return [{ petition_id: '19389', total: 4480, last14: 120 }]; },
    async engineCopilotAuth() { return { owner: 'CJO' }; },
    async engineTrackedLink(code) { return tracked.get(code) || null; },
    async engineSaveTrackedLink(row) { tracked.set(row.code, row); return row; },
    async copilotCall() { if (copilotFails) throw new Error('down'); },
  };
}
function run(url, store, headers = { host: 'x.test', 'user-agent': 'Mozilla/5.0 (iPhone)' }) {
  handler._setStore(store);
  return new Promise((resolve) => {
    const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { resolve({ status: this.statusCode, headers: this.headers, body: String(b || '') }); } };
    handler({ method: 'GET', url, headers }, res);
  });
}
(async () => {
  const realNow = Date.now; Date.now = () => now;
  const s = fakeStore();
  const page = await run('/api/bio?slug=uk', s);
  eq('endpoint: page has a hero and lists the other buttons', [page.status, (page.body.match(/class="b[ "]/g) || []).length, page.body.includes('class="hero"'), page.headers['content-security-policy'].includes("default-src 'none'"), page.headers['content-security-policy'].includes(B.COPY_HASH)], [200, 2, true, true, true]);
  eq('endpoint: a page view is counted', s.clicks.splice(0), [['uk', '_v']]);
  await run('/api/bio?slug=uk&s=ig', s);
  await run('/api/bio?slug=uk&s=evil', s);
  await run('/api/bio?slug=uk&s=ig', s, { host: 'x.test', 'user-agent': 'facebookexternalhit/1.1' });
  eq('endpoint: views by source, unknown sources as other, previewers not counted', s.clicks.splice(0), [['uk', '_v:ig'], ['uk', '_v']]);
  eq('endpoint: the hero shows the Bluebook total', page.body.includes('4,480</b> signed'), true);
  const qr = await run('/api/bio?slug=uk&qr=1', s);
  eq('endpoint: QR code as SVG for the page with ?s=qr', [qr.status, qr.headers['content-type'], qr.body.startsWith('<svg')], [200, 'image/svg+xml', true]);
  const g1 = await run('/api/bio', s, { host: 'x.test', 'x-vercel-ip-country': 'GB' });
  const g2 = await run('/api/bio', s, { host: 'x.test', 'x-vercel-ip-country': 'FR' });
  const g3 = await run('/api/bio?pick=1&s=ig', s, { host: 'x.test', 'x-vercel-ip-country': 'GB' });
  eq('endpoint: the global link sends the UK to its page, others to the picker', [g1.status, g1.headers.location, g2.status, g2.body.includes('Choose your country'), g3.status], [302, '/links/uk', 200, true, 200]);
  eq('endpoint: unknown page is a 404', (await run('/api/bio?slug=nope', s)).status, 404);
  const hand = await run('/api/bio?slug=uk&go=don', s);
  eq('endpoint: a hand-added button goes straight to its link and counts', [hand.status, hand.headers.location, s.clicks.splice(0)], [302, 'https://citizengo.org/en-gb/donate', [['uk', 'don']]]);
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
