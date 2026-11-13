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
  eq('page: hero with total and goal, one share button, source carried on links', [page.includes('10,812</b> signed</div>') && page.includes('72% of 15,000'), page.includes('href="https://x.test/links/uk/go/a?s=share" aria-label="Share this petition"'), page.includes('wa.me'), page.includes('data-copy="'), page.includes('href="https://x.test/links/uk/go/w?s=ig"')], [true, true, false, false, true]);
  {
    const st2 = { ...status, 1: { total: 10812, last14: 300, site_total: 80205, share_url: 'https://citizengo.org/en-gb/LP2-share?m=8&nid=1&title=a' } };
    const p2 = B.pageHtml({ bio: { slug: 'uk', title: 'UK' }, items: rr.shown, hero: rr.shown[1], status: st2, today: '2026-11-02' });
    eq('page: the all-language total from the site, and the petition\'s own share page', [p2.includes('80,205</b> signed'), p2.includes('href="https://citizengo.org/en-gb/LP2-share?m=8&amp;nid=1&amp;title=a"')], [true, true]);
  }
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
  {
    const st3 = { ...status, 1: { total: 10812, site_total: 80223, site_goal: 100000 } };
    const p3 = B.pageHtml({ bio: { slug: 'uk', title: 'UK' }, items: rr.shown, hero: rr.shown[1], status: st3, today: '2026-11-02', origin: 'https://x.test', grid: [{ img: 'https://kept/a.jpg', href: 'https://www.instagram.com/p/abc/' }] });
    eq('page: the site goal, a bar on every petition row, picture preview, grid opens Instagram', [p3.includes('80,223</b> signed</div>') && p3.includes('80% of 100,000'), (p3.match(/class="rbar"/g) || []).length > 0, p3.includes('og:description" content="Sign A'), p3.includes('href="https://www.instagram.com/p/abc/"'), p3.includes('see it on Instagram')], [true, true, true, true, true]);
    const card = B.cardHtml({ bio: { slug: 'uk', title: 'UK' }, item: { id: 'p19960', petition_id: '19960', title: 'Netflix: Cancel The Body', image: 'https://kept/n.jpg' }, status: { 19960: { site_total: 80223, site_goal: 100000 } }, origin: 'https://x.test' });
    eq('share card: picture, title and total in the preview, then on to sign', [card.includes('og:image" content="https://kept/n.jpg"'), card.includes('80,223 signed. Help reach 100,000.'), card.includes('url=https://x.test/links/uk/go/p19960')], [true, true, true]);
  }
  eq('top card: chosen first, else the busiest in 14 days, else the post\'s', [B.pickHero([{ id: 'a', petition_id: '1', lead: true }, { id: 'b', petition_id: '2' }], { 1: { last14: 5 }, 2: { last14: 900 } }).id, B.pickHero([{ id: 'a', petition_id: '1' }, { id: 'b', petition_id: '2', featured: true }], { 1: { last14: 9000 } }).id, B.pickHero([{ id: 'a', petition_id: '1', lead: true }, { id: 'b', petition_id: '2' }], {}).id, B.heroWhy({ id: 'b', petition_id: '2' }, { 2: { last14: 900 } })], ['b', 'b', 'a', 'busiest']);
  eq('round numbers for Just passed', [999, 1200, 7400, 26000, 80294, 181107].map(B.markOf), [0, 1000, 5000, 25000, 80000, 100000]);
  {
    const T = Date.parse('2026-11-12T20:00:00Z');
    eq('tags: Just passed for 2 days, else New for 7 days', [B.tagOf({ passed_mark: 80000, passed_at: '2026-11-11T20:00:00Z', site_start: '2026-11-10T00:00:00Z' }, T), B.tagOf({ passed_mark: 80000, passed_at: '2026-11-09T20:00:00Z', site_start: '2026-11-10T00:00:00Z' }, T), B.tagOf({ site_start: '2026-11-01T00:00:00Z' }, T)], [{ kind: 'passed', mark: 80000 }, { kind: 'new' }, null]);
    const st4 = { ...status, 1: { total: 80294, site_start: new Date(Date.now() - 864e5).toISOString() } };
    const p4 = B.pageHtml({ bio: { slug: 'uk', title: 'UK' }, items: rr.shown, hero: rr.shown[1], status: st4, today: '2026-11-02' });
    eq('tags: shown over the picture', p4.includes('<span class="tg">New</span>'), true);
  }
  eq('short titles: the first part of a long title, else cut at a word; short ones untouched', [B.shortName('Conversations Are Not Criminal - Protect Parents, Clergy and Free Speech: Stop the Conversion Practices Bill'), B.shortName('Netflix: Cancel The Body'), B.shortName('Stop the UN From Smuggling Gender Ideology Into International Law and the courts too')], ['Conversations Are Not Criminal', 'Netflix: Cancel The Body', 'Stop the UN From Smuggling Gender Ideology Into…']);
  eq('settings: links must be https, switches default on', B.cleanSettings({ donate_url: 'http://x', emails_url: 'https://e.test', grid: false }), { donate_url: null, emails_url: 'https://e.test', whatsapp_url: null, grid: false, socials: true, totals: true, quiet: true, bio_line: null });
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

// Link in bio upgrades [12 Nov 2026].
{
  eq('L1: titles from a page, without the site name', [B.pageTitle('Save Maria | CitizenGO'), B.pageTitle('CitizenGO'), B.pageTitle('CitizenGO - Stop the Bill'), B.pageTitle('')], ['Save Maria', null, 'Stop the Bill', null]);
  eq('L1: titles from an Asana project name', [B.asanaTitle('EN_GB - Tell Andy Burnham: Rule Out UK Rejoining the EU  - 10/2026'), B.asanaTitle('Campaigns calendar')], ['Tell Andy Burnham: Rule Out UK Rejoining the EU', null]);
  eq('L1: poor titles are caught', ['Petition 19960', 'NI Petition Launch Should A Mum Go To Prison', 'Tell andy burnham fully rule out rejoining the eu', 'Stop the banning of church outreach in Colchester', 'Westminster: don\'t criminalise parents'].map(B.badTitle), ['placeholder', 'internal', 'lower', null, null]);
  eq('L1: long titles shortened at a word', B.shortTitle('She was abducted at 12. UK aid to Pakistan must protect Christian girls like Maria from harm'), 'She was abducted at 12. UK aid to Pakistan must protect Christian…');
  const handed = [{ status: 'scheduled', post_at: '2026-11-02T10:00:00Z', doc: { posting: { handoff: { at: '2026-11-01T09:00:00Z' }, destinations: ['uk-ig'] }, action: { url: 'https://citizengo.org/en-gb/fr/19960', petitionId: '19960', title: 'Stop the BBC' } } },
    { status: 'scheduled', post_at: '2026-11-03T10:00:00Z', doc: { posting: { handoff: { at: '2026-11-01T09:00:00Z' }, destinations: ['uk-ig'] }, action: { url: 'https://citizengo.org/en-gb/fr/19961', petitionId: '19961' } } },
    { status: 'scheduled', post_at: '2026-11-02T11:00:00Z', doc: { posting: { destinations: ['uk-ig'] }, action: { url: 'https://citizengo.org/en-gb/fr/19962', petitionId: '19962' } } }];
  eq('L9: a handed-off post whose time has come leads the bio; future or not handed off does not', (B.leadFromPosts(handed, { now }) || {}).petition_id, '19960');
  const st = { 2: { last14: 50 }, 3: { last14: 900 } };
  const r = B.resolve({ auto: true, items: [{ id: 'a', title: 'A', url: 'https://citizengo.org/en-gb/fr/7', petition_id: '7' }, { id: 'b', title: 'B again', url: 'https://citizengo.org/en-gb/fr/7', petition_id: '7' }] },
    [{ id: 'p2', petition_id: '2', url: 'https://citizengo.org/en-gb/fr/2', title: 'Two', auto: true, last_posted: '2026-11-01' }, { id: 'p3', petition_id: '3', url: 'https://citizengo.org/en-gb/fr/3', title: 'Three', auto: true, last_posted: '2026-10-20' }, { id: 'p4', petition_id: '4', url: 'https://citizengo.org/en-gb/fr/4', title: 'Four', auto: true, lead: true, last_posted: '2026-10-01' }], { now, status: st });
  eq('L3: one button per petition; new campaigns: the bio post first, then most signed in 14 days', r.all.map((i) => i.id), ['p4', 'p3', 'p2', 'a']);
  const many = Array.from({ length: 8 }, (_, n) => ({ id: 'x' + n, title: 'Petition title ' + n, petition_id: String(100 + n), section: 'Act now', image: n === 0 ? 'https://h.test/i.jpg' : null }));
  const html = B.pageHtml({ bio: { slug: 'uk', title: 'UK', settings: {} }, items: many, status: { 100: { total: 1234 } }, today: '2026-11-02' });
  eq('L3: five under the heading, the rest under More', [(html.match(/class="b pic/g) || []).length, /<summary>More petitions \(3\)<\/summary>/.test(html)], [8, true]);
  eq('L2a: picture rows show signatures', html.includes('<b>1,234</b> signed · goal 2,500'), true);
}
{
  const R = require('../lib/bio-refresh');
  eq('refresh: reads a page\'s title and picture', R.readPage('<html><head><title>x</title><meta property="og:title" content="Stop the Bill | CitizenGO"><meta property="og:image" content="/img/a.jpg"></head></html>', 'https://citizengo.org/en-gb/fr/1'), { title: 'Stop the Bill', image: 'https://citizengo.org/img/a.jpg' });
  eq('refresh: a page with no title tags gives nothing', R.readPage('<title>CitizenGO</title>', 'https://citizengo.org/x'), { title: null, image: null });
  eq('refresh: when a petition is due another look', [R.due(null, now), R.due({ page_checked_at: '2026-11-02T11:00:00Z', page_title: 't', page_image: 'i' }, now), R.due({ page_checked_at: '2026-10-29T12:00:00Z', page_title: 't', page_image: 'i' }, now), R.due({ page_checked_at: '2026-11-01T06:00:00Z', page_title: 't' }, now)], [true, false, true, true]);
  eq('refresh: closed petitions with no recent post leave the saved list; pinned and removed stay', R.staleSaved({ items: [{ id: 'c' }, { id: 'k' }, { id: 'p', pinned: true }, { id: 'h', hidden: true }, { id: 'n' }] }, { auto: [{ id: 'k' }], all: [{ id: 'c', why: 'closed' }, { id: 'k', why: 'closed' }, { id: 'p', why: 'closed' }, { id: 'h', why: 'removed' }, { id: 'n', why: null }] }), ['c']);
}

eq('titles: first line of our post, without emoji', [B.titleFromText('📺 Sex. Satanic rituals. Mockery of Christ. All funded by you.\n\nMore'), B.titleFromText('👇\nhttps://x.y'), B.titleFromText('Faith is NOT a crime against humanity.\n\nGovernments at the UN')], ['Sex. Satanic rituals. Mockery of Christ. All funded by you.', null, 'Faith is NOT a crime against humanity.']);
// Refresh end to end, against a fake store and a fake web.
const refreshDone = (async () => {
  const R = require('../lib/bio-refresh');
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const pages = [], copies = [], igCopies = [], saved = [];
  const store = {
    async linkPostsSince() { return [{ platform: 'instagram', account_id: '178', post_id: '555', petition_id: '19389', full_url: 'https://citizengo.org/en-gb/lf/19389', posted_at: '2026-11-01T10:00:00Z' }]; },
    async enginePosts() { return []; },
    async igGridMedia() { return [{ media_id: '555', thumbnail_url: 'https://scontent.cdninstagram.com/a.jpg?oe=7AFB2F4F', timestamp: '2026-11-01T10:00:00Z' }, { media_id: '556', thumbnail_url: 'https://scontent.cdninstagram.com/b.jpg?oe=7AFB2F4F', image_copy: 'https://kept/b.jpg', timestamp: '2026-10-31T10:00:00Z' }]; },
    async igMediaByIds() { return []; },
    async petitionStatus() { return [{ petition_id: '19389', total: 10, last14: 5, asana_project: 'EN_GB - Faith Is Not A Crime - 10/2026' }]; },
    async fbPicturesForPetitions() { return []; },
    async publicAssetPut(path, buf, type) { copies.push([path, type, buf.length]); return 'https://kept/' + path; },
    async petitionPagesSet(rows) { pages.push(...rows); },
    async igImageCopySet(id, url) { igCopies.push([id, url.split('?')[0]]); },
    async engineSaveBio(row) { saved.push(row); return row; },
  };
  const site = JSON.stringify([{ id: 19389, title: 'Faith is not a crime against humanity', featured_image: 'https://api.citizengo.org/media/images/p.jpg', signature_count: 900, padding: 100, cluster_count: 4500, segment: { code: 'en-gb', listcode: 'EN_GB' } }]);
  const web = async (url) => {
    const api = url.includes('api.citizengo.org/api/') && url.includes('19389');
    return { status: 200, ok: true, headers: { get: (k) => (k === 'content-type' ? (api ? 'application/json' : 'image/jpeg') : null) }, arrayBuffer: async () => (api ? Buffer.from(site) : jpg) };
  };
  const lookup = async () => [{ address: '104.16.1.1', family: 4 }];
  const team = { id: 'uk', accounts };
  const bioR = { slug: 'uk', title: 'UK', auto: true, items: [{ id: 'old', title: 'Old one', url: 'https://citizengo.org/en-gb/fr/42', petition_id: '42', closed: true }] };
  const out = await R.refreshTeam(store, { team, bio: bioR, now, fetchImpl: web, lookup });
  eq('refresh: page title kept, picture copied from the page, grid picture copied once', [pages.find((p) => p.petition_id === '19389').page_title, pages.find((p) => p.petition_id === '19389').page_image_src, copies.map((c) => c[0]), igCopies], ['Faith is not a crime against humanity', 'page', ['bio/petitions/19389.jpg', 'bio/ig/555.jpg'], [['555', 'https://kept/bio/ig/555.jpg']]]);
  {
    const p = pages.find((x) => x.petition_id === '19389');
    eq('refresh: the site\'s all-language total and share page are kept', [p.site_total, p.site_count, p.share_url], [4500, 900, 'https://citizengo.org/en-gb/LP2-share?m=8&nid=19389&title=faith-is-not-a-crime-against-humanity&list=EN_GB&utm_source=bio&utm_medium=linkinbio']);
  }
  eq('refresh: reads the site for Netflix (parent total counts)', R.readSite('[{"id":19960,"title":"Netflix: Cancel The Body","signature_count":3100,"padding":0,"cluster_count":80205,"goal":100000,"featured_image":"https://api.citizengo.org/media/images/n.jpg","segment":{"code":"en-gb","listcode":"EN_GB"}}]'), { title: 'Netflix: Cancel The Body', image: 'https://api.citizengo.org/media/images/n.jpg', count: 80205, own: 3100, goal: 100000, start: null, share: 'https://citizengo.org/en-gb/LP2-share?m=8&nid=19960&title=netflix-cancel-the-body&list=EN_GB&utm_source=bio&utm_medium=linkinbio' });
  eq('refresh: the closed petition is tidied out of the saved list', [out.removed, saved[0].items.length], [1, 0]);
  // The loader then uses what the refresh kept.
  store.petitionStatus = async () => [{ petition_id: '19389', total: 10, last14: 5, page_title: 'Faith is not a crime against humanity', page_image: 'https://kept/p.jpg', page_image_src: 'page' }];
  const L = await B.load(store, { team, bio: { slug: 'uk', auto: true, items: [{ id: 'p19389', title: 'Petition 19389', url: 'https://citizengo.org/en-gb/lf/19389', petition_id: '19389', auto: true }] }, now });
  const it = L.all.find((i) => i.petition_id === '19389');
  eq('load: a saved placeholder title and a missing picture are replaced by the kept ones', [it.title, it.image, it.title_src], ['Faith is not a crime against humanity', 'https://kept/p.jpg', 'page']);
  const L2 = await B.load(store, { team, bio: { slug: 'uk', auto: true, items: [{ id: 'p19389', title: 'Our own words', url: 'https://citizengo.org/en-gb/lf/19389', petition_id: '19389', auto: true, retitled: true }] }, now });
  eq('load: a title someone typed is never replaced', L2.all.find((i) => i.petition_id === '19389').title, 'Our own words');
  eq('load: grid uses the kept copy, else the Instagram link', L2.tiles.map((t) => t.img), ['https://scontent.cdninstagram.com/a.jpg?oe=7AFB2F4F', 'https://kept/b.jpg']);
})();

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
    async petitionPagesSet(rows) { (this.pagesSet = this.pagesSet || []).push(...rows); },
    async engineCopilotAuth() { return { owner: 'CJO' }; },
    async engineTrackedLink(code) { return tracked.get(code) || null; },
    async engineSaveTrackedLink(row) { tracked.set(row.code, row); return row; },
    async copilotCall() { if (copilotFails) throw new Error('down'); },
  };
}
const liveWeb = async (url) => ({ status: 200, ok: true, headers: { get: (k) => (k === 'content-type' ? 'application/json' : null) }, arrayBuffer: async () => Buffer.from(url.includes('19389') ? '[{"id":19389,"title":"x","signature_count":4000,"padding":0,"cluster_count":4613}]' : '[]') });
handler._setLive({ fetchImpl: liveWeb, lookup: async () => [{ address: '104.16.1.1', family: 4 }] });
function run(url, store, headers = { host: 'x.test', 'user-agent': 'Mozilla/5.0 (iPhone)' }) {
  handler._setStore(store);
  return new Promise((resolve) => {
    const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { resolve({ status: this.statusCode, headers: this.headers, body: String(b || '') }); } };
    handler({ method: 'GET', url, headers }, res);
  });
}
(async () => {
  await refreshDone;
  const realNow = Date.now; Date.now = () => now;
  const s = fakeStore();
  const page = await run('/api/bio?slug=uk', s);
  eq('endpoint: page has a hero and lists the other buttons', [page.status, (page.body.match(/class="b[ "]/g) || []).length, page.body.includes('class="hero"'), page.headers['content-security-policy'].includes("default-src 'none'"), page.headers['content-security-policy'].includes(B.COPY_HASH)], [200, 2, true, true, true]);
  eq('endpoint: a page view is counted', s.clicks.splice(0), [['uk', '_v']]);
  await run('/api/bio?slug=uk&s=ig', s);
  await run('/api/bio?slug=uk&s=evil', s);
  await run('/api/bio?slug=uk&s=ig', s, { host: 'x.test', 'user-agent': 'facebookexternalhit/1.1' });
  eq('endpoint: views by source, unknown sources as other, previewers not counted', s.clicks.splice(0), [['uk', '_v:ig'], ['uk', '_v']]);
  eq('endpoint: the hero shows the live total from citizengo.org when newer', page.body.includes('4,613</b> signed'), true);
  eq('endpoint: the live total is kept', (s.pagesSet || []).some((r) => r.petition_id === '19389' && r.site_total === 4613), true);
  const cb = await run('/api/bio?slug=uk&p=19389', s, { host: 'x.test', 'user-agent': 'WhatsApp/2.23' });
  const cp = await run('/api/bio?slug=uk&p=19389', s);
  const cx = await run('/api/bio?slug=uk&p=999', s);
  eq('endpoint: share card for previews, people go on to sign, unknown back to the page', [cb.status, cb.body.includes('og:title'), cp.status, cp.headers.location, cx.headers.location], [200, true, 302, '/links/uk/go/p19389', '/links/uk']);
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
