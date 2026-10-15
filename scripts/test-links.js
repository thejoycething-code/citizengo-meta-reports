#!/usr/bin/env node
'use strict';
// Link performance: parsing, the registry, the Looker loader and the tool.
// No network: the shortener and Supabase are faked.
//
//   npm run test:links

const links = require('../lib/links');
const { rowsFor } = require('../collector/links');
const { rowsFromStream, toSignatureRows } = require('./load-link-signatures');
const { aggregate, groupBy, linkPerformance } = require('../mcp/link-tools');

let pass = 0; let fail = 0;
const ok = (name, cond, why = '') => { if (cond) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${why ? ' — ' + why : ''}`); } };
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

console.log('\nFinding links in text');
eq('bare cgo.ac link gets a scheme; trailing full stop dropped', links.extractLinks('Firma: cgo.ac/scdThbMVZ.'), ['https://cgo.ac/scdThbMVZ']);
eq('a bare domain is a mention, not a link', links.extractLinks('Visit citizengo.org today'), []);
eq('both links in one post, de-duplicated', links.extractLinks('https://cgo.ac/scA1b2C3d and cgo.ac/scA1b2C3d and https://www.citizengo.org/en-gb/fr/19487-x'), ['https://cgo.ac/scA1b2C3d', 'https://www.citizengo.org/en-gb/fr/19487-x']);
eq('other sites ignored', links.extractLinks('https://bbc.co.uk/news/1 https://example.org/citizengo'), []);
eq('short code read from cgo.ac', links.shortCodeOf('https://cgo.ac/scqA0hnxp'), 'scqA0hnxp');
eq('no short code on a long link', links.shortCodeOf('https://citizengo.org/en-gb/fr/1'), null);

console.log('\nReading campaign codes');
const rda = links.parseCode('EN_ROW-2026_10_14-Tedros_Wants_His_Win_Say_NO_To_The_WHO-RDA-AA_NA-GL-FR-19538-TW1');
eq('owner, petition, series and date from a Copilot code', [rda.owner, rda.petition_id, rda.series, rda.code_date], ['rda', '19538', 'tw1', '2026-10-14']);
eq('code is lowercased (Looker stores it lowercase)', rda.campaign_code.startsWith('en_row-2026_10_14-tedros'), true);
eq('fundraising code with a numeric list', links.parseCode('550-2026_09_28-Donazioni-MMO-OTD_CLS-IN-FR-550-TW1').owner, 'mmo');
eq('email code: series l5, no social platform', links.parseCode('en_gb-2026_10_05-pandemic_treaty-cjo-aa_tim-gl-fr-19611-l5').series, 'l5');
eq('free-text campaign: kept, nothing parsed', links.parseCode('19239_facebook_launch_post'), { campaign_code: '19239_facebook_launch_post', owner: null, petition_id: null, series: null, code_date: null });
const t = links.parseTracked('https://citizengo.org/en-ie/ot/19607?campaign=EN_IE-2026_10_14-Save_NotreDames_Stained_Glass-MMA-AA_NA-IN-OT-19607-TW1&utm_source=tw&utm_medium=social&utm_campaign=EN_IE-2026_10_14-Save_NotreDames_Stained_Glass-MMA-AA_NA-IN-OT-19607-TW1');
eq('tracked link: source, medium, owner', [t.utm_source, t.utm_medium, t.owner, t.petition_id], ['tw', 'social', 'mma', '19607']);
eq('plain petition link: petition id from the path, no code', [links.parseTracked('https://citizengo.org/es-ar/fr/17260-actua').petition_id, links.parseTracked('https://citizengo.org/es-ar/fr/17260-actua').campaign_code], ['17260', null]);
eq('donation form id from fundraising_id', links.petitionIdOf('https://donate.citizengo.org/en-gb/md/?fundraising_id=580&campaign=x'), '580');

console.log('\nRegistry rows');
const LONG = 'https://citizengo.org/en-ie/ot/19607?utm_source=fb&utm_medium=social&utm_campaign=EN_IE-2026_10_14-Save-MMA-AA_NA-IN-OT-19607-FB1';
const rows = rowsFor({
  pages: [{ page_id: 'p1', name: 'CitizenGO Ireland' }],
  fbPosts: [{ post_id: 'f1', page_id: 'p1', created_time: '2026-10-14T10:00:00Z', message: 'Sign: cgo.ac/scAAAA1111', link_url: null, permalink_url: 'https://facebook.com/f1' }],
  igMedia: [{ media_id: 'i1', page_id: 'p1', ig_user_id: 'ig1', ig_username: 'citizengo_ie', caption: 'Link in bio citizengo.org', timestamp: '2026-10-14T11:00:00Z', permalink: 'https://instagram.com/p/i1' }],
  xPosts: [{ post_id: 'x1', account_id: 'a9', created_at: '2026-10-14T12:00:00Z', citizengo_urls: ['https://citizengo.org/es-ar/fr/17260-actua'], permalink_url: 'https://x.com/r/status/x1' }],
  xAccounts: [{ account_id: 'a9', username: 'rociodangelo6', kind: 'spokesperson' }],
  shortMap: new Map([['scAAAA1111', LONG]]),
});
eq('one row per post link; the bare-domain caption adds none', rows.map((r) => r.platform), ['facebook', 'x']);
eq('short link resolved to its code', [rows[0].short_code, rows[0].campaign_code, rows[0].owner], ['scAAAA1111', 'en_ie-2026_10_14-save-mma-aa_na-in-ot-19607-fb1', 'mma']);
eq('spokesperson kind and handle carried', [rows[1].account_kind, rows[1].account_label], ['spokesperson', '@rociodangelo6']);
eq('every row has the same columns (the sink refuses mixed batches)', new Set(rows.map((r) => Object.keys(r).sort().join())).size, 1);
const unresolved = rowsFor({ fbPosts: [{ post_id: 'f2', page_id: 'p1', created_time: '2026-10-14T10:00:00Z', message: 'cgo.ac/scBBBB2222' }] });
eq('an unresolved short link is kept, with no code', [unresolved[0].full_url, unresolved[0].campaign_code], [null, null]);

console.log('\nLooker loader');
const lookerRows = [
  { 'petitions_signatures_3_0.utm_campaign': 'en_row-2026_10_14-tedros-rda-aa_na-gl-fr-19538-tw1', 'petitions_signatures_3_0.source': 'tw', 'petitions_signatures_3_0.sum_signatures': 120, 'petitions_signatures_3_0.sum_new_members': 30, 'petitions_signatures_3_0.sum_reactivated_members': 4 },
  { 'petitions_signatures_3_0.utm_campaign': 'en_row-2026_10_14-tedros-rda-aa_na-gl-fr-19538-tw1', 'petitions_signatures_3_0.source': 'wa', 'petitions_signatures_3_0.sum_signatures': 40, 'petitions_signatures_3_0.sum_new_members': 10, 'petitions_signatures_3_0.sum_reactivated_members': 1 },
  { 'petitions_signatures_3_0.utm_campaign': 'en_row-2026_08_20-stop_unfpa-rda-aa_na-gl-fr-19035-l1', 'petitions_signatures_3_0.source': 'em', 'petitions_signatures_3_0.sum_signatures': 2367 },
  { 'petitions_signatures_3_0.utm_campaign': 'pt_br-2026_06_10-apoie-o-pl-liberdade', 'petitions_signatures_3_0.source': 'other', 'petitions_signatures_3_0.sum_signatures': 425 },
];
const sig = toSignatureRows(lookerRows, '2026-10-15T10:00:00Z');
eq('only social codes kept (email l1 and free text from "other" dropped)', sig.map((r) => `${r.series}|${r.source}`), ['tw1|tw', 'tw1|wa']);
const extra = toSignatureRows([
  { 'petitions_signatures_3_0.utm_campaign': 'en_gb-snp_cta_x_23/09', 'petitions_signatures_3_0.source': 'tw', 'petitions_signatures_3_0.sum_signatures': 12 },
  { 'petitions_signatures_3_0.utm_campaign': 'typage', 'petitions_signatures_3_0.source': 'fb', 'petitions_signatures_3_0.sum_signatures': 9000 },
  { 'petitions_signatures_3_0.utm_campaign': 'es_mx-', 'petitions_signatures_3_0.source': 'fb', 'petitions_signatures_3_0.sum_signatures': 50 },
  { 'petitions_signatures_3_0.utm_campaign': 'en_gb-snp_cta_x_23/09', 'petitions_signatures_3_0.source': 'wa', 'petitions_signatures_3_0.sum_signatures': 3 },
], 'x');
eq('hand-made code kept when signers came from a social platform; generic share values dropped', extra.map((r) => `${r.campaign_code}|${r.source}`), ['en_gb-snp_cta_x_23/09|tw']);
eq('owner and petition parsed onto the row', [sig[0].owner, sig[0].petition_id, sig[0].code_date], ['rda', '19538', '2026-10-14']);
const toolUse = { type: 'message', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__claude_ai_CitizenGO_Looker__query' }] } };
const inline = [JSON.stringify(toolUse), JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: JSON.stringify(lookerRows) }] }] } })].join('\n');
eq('rows read from an inline tool result', rowsFromStream(inline).length, 4);
const toolUse2 = { message: { content: [{ type: 'tool_use', id: 'tu2', name: 'mcp__claude_ai_CitizenGO_Looker__query' }] } };
const two = [inline, JSON.stringify(toolUse2), JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: JSON.stringify(lookerRows.slice(0, 1)) }] } })].join('\n');
eq('both queries read, with a row count for each (truncation is per query)', rowsFromStream(two).perQuery, [4, 1]);
const savedStream = [JSON.stringify(toolUse), JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Output too large. Full output saved to: /tmp/q.txt\nPreview...' }] } })].join('\n');
eq('rows read from the saved file when the result was persisted', rowsFromStream(savedStream, () => JSON.stringify([{ type: 'text', text: JSON.stringify(lookerRows) }])).length, 4);
let threw = false; try { rowsFromStream(JSON.stringify(toolUse)); } catch (e) { threw = /no Looker query result/.test(e.message); }
ok('a stream with no query result fails loudly (never loads nothing)', threw);

console.log('\nAggregation');
const posts = [
  { platform: 'x', post_id: 'x1', account_id: 'a9', account_label: '@rociodangelo6', posted_at: '2026-10-14', campaign_code: 'en_row-2026_10_14-tedros-rda-aa_na-gl-fr-19538-tw1', owner: 'rda', petition_id: '19538' },
  { platform: 'x', post_id: 'x2', account_id: 'a9', account_label: '@rociodangelo6', posted_at: '2026-10-14', campaign_code: 'en_row-2026_10_14-tedros-rda-aa_na-gl-fr-19538-tw1', owner: 'rda', petition_id: '19538' },
  { platform: 'x', post_id: 'x3', account_id: 'a9', account_label: '@rociodangelo6', posted_at: '2026-10-02', campaign_code: null },
];
const unposted = { ...sig[0], campaign_code: 'es_row-2026_07_14-onu-rda-aa_na-gl-ot-18162-ig1', source: 'ig', series: 'ig1', signatures: 171, new_members: 145, reactivated_members: 3 };
const ag = aggregate(posts, [...sig, unposted]);
eq('a code posted twice is one row with two posts', [ag.codes.length, ag.codes[0].posts.length], [1, 2]);
eq('totals across sources; direct = the platform the link was made for', [ag.codes[0].signatures, ag.codes[0].direct, ag.codes[0].via_shares, ag.codes[0].new_members], [160, 120, 40, 40]);
eq('links with no code are counted as untraced', ag.untraced.length, 1);
eq('unposted codes only with include_unposted', aggregate(posts, [...sig, unposted], { includeUnposted: true }).codes.length, 2);
const gb = groupBy(aggregate(posts, [...sig, unposted], { includeUnposted: true }).codes, 'account');
eq('group by account: unposted codes get their own row', gb.map((g) => g.key), ['(not seen in a post)', 'X @rociodangelo6']);

console.log('\nThe tool');
const store = {
  async linkPosts(f) { return f.owner && f.owner !== 'rda' ? [] : posts; },
  async linkSignatures(f) { return f.codes ? sig.filter((s) => f.codes.includes(s.campaign_code)) : [unposted]; },
  async linkFreshness() { return { pulledAt: '2026-10-15T10:00:00Z', registryAt: '2026-10-15T09:00:00Z' }; },
};
(async () => {
  const r = await linkPerformance(store, { owner: 'RDA', month: '2026-10' });
  ok('owner filter includes unposted codes by default', /2 campaign codes/.test(r.text) && /not in a post/.test(r.text), r.text.slice(0, 200));
  ok('says where signature figures come from and when', /Looker/.test(r.text) && /2026-10-15 10:00/.test(r.text));
  ok('names the untraced plain link', /1 post link\(s\) carried no campaign code/.test(r.text));
  const g = await linkPerformance(store, { account: '@rociodangelo6', group_by: 'account' });
  ok('account filter does not add unposted codes', /1 campaign codes/.test(g.text) && !/not seen in a post/.test(g.text), g.text.slice(0, 200));
  const none = await linkPerformance({ ...store, async linkPosts() { return []; }, async linkSignatures() { return []; }, async linkFreshness() { return { pulledAt: null, registryAt: null }; } }, { owner: 'zzz' });
  ok('empty answer says the registry is not built', /not been built/.test(none.text));
  const bad = await linkPerformance(store, { month: 'Smarch' });
  ok('bad month is explained, not thrown', /Give the month/.test(bad.text));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
