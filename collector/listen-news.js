#!/usr/bin/env node
'use strict';
// Listening › Beyond our list: news headlines for each campaign topic, from
// Google News's public RSS search: the UK edition (en-GB) and, since 3 Nov
// 2026 for the México team, the Mexico edition in Spanish (es-419, approved by
// Chris). Headline, source, link and time only, newest three days; rows
// deleted after 30 days. Free, no key. Each row says which edition it is from.
//
// Usage: node collector/listen-news.js [--dry-run]
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY.

const { loadEnv } = require('../lib/graph');
const { makePg } = require('./peers-ig');
const { topicsOf } = require('../lib/listen-topics');

// One search per topic (lib/listen-topics.js keys).
const QUERIES = {
  'assisted-dying': '"assisted dying" OR "assisted suicide" OR "euthanasia bill" OR "terminally ill adults"',
  abortion: 'abortion OR "buffer zone" OR "pro-life"',
  gender: '"puberty blockers" OR transgender OR "gender identity"',
  'sex-education': '"sex education" OR "relationships education" OR "RSE guidance" OR "RSHE"',
  hospices: 'hospice OR "palliative care"',
  'free-speech': '"free speech" OR "silent prayer" OR "religious freedom"',
  family: 'surrogacy OR "family policy" OR "two-child limit"',
};
// The Mexico edition, in Spanish (lib/listen-topics.js reads Spanish too).
const QUERIES_MX = {
  'assisted-dying': 'eutanasia OR "muerte digna" OR "suicidio asistido" OR "muerte asistida"',
  abortion: 'aborto OR provida OR "pro vida" OR "por nacer"',
  gender: '"ideología de género" OR transgénero OR "bloqueadores de la pubertad" OR "infancias trans"',
  'sex-education': '"educación sexual" OR "libros de texto" OR "pin parental"',
  hospices: '"cuidados paliativos"',
  'free-speech': '"libertad religiosa" OR "libertad de expresión" OR "persecución religiosa"',
  family: '"gestación subrogada" OR "vientres de alquiler" OR "matrimonio igualitario" OR "familia natural"',
};
// Which feeds to read: the edition key is what the desk filters on.
const EDITIONS = [
  { edition: 'uk', queries: QUERIES, params: 'hl=en-GB&gl=GB&ceid=GB:en', suffix: (topic) => (topic === 'hospices' ? '' : UK) },
  { edition: 'mx', queries: QUERIES_MX, params: 'hl=es-419&gl=MX&ceid=MX:es-419', suffix: () => '' },
];
const KEEP_DAYS = 30;
// Google News's UK edition still returns US and Indian stories, so each search
// (hospices aside: those are mostly UK local news already) asks for a UK word.
const UK = ' (UK OR Britain OR British OR England OR Scotland OR Wales OR Westminster OR Lords OR MPs)';

const decode = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n))).trim();
const tag = (xml, t) => { const m = xml.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return m ? decode(m[1]) : ''; };

// Pure: RSS text -> rows for one topic, newest three days.
function parseFeed(xml, topic, now = Date.now(), edition = 'uk') {
  const out = [];
  for (const m of String(xml).match(/<item>[\s\S]*?<\/item>/g) || []) {
    const url = tag(m, 'link'); const source = tag(m, 'source');
    let title = tag(m, 'title');
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    const at = Date.parse(tag(m, 'pubDate'));
    if (!url || !/^https:\/\//.test(url) || !title || !(at > now - 72 * 3600e3)) continue;
    // Keep a headline only when its own words put it in the topic (searches
    // also return pet "euthanasia" and stray matches).
    if (!topicsOf(title).includes(topic) || /\b(dog|cat|horse|pet|vet|animal|otter|zoo)s?\b/i.test(title)) continue;
    out.push({ url, topic, edition, title: title.slice(0, 300), source: source.slice(0, 120) || null, published_at: new Date(at).toISOString() });
  }
  return out.slice(0, 25);
}

async function main() {
  loadEnv();
  const dryRun = process.argv.includes('--dry-run');
  const pg = dryRun ? null : makePg();
  let stored = 0;
  for (const ed of EDITIONS) for (const [topic, q] of Object.entries(ed.queries)) {
    const u = `https://news.google.com/rss/search?q=${encodeURIComponent(`(${q})${ed.suffix(topic)} when:3d`)}&${ed.params}`;
    const r = await fetch(u, { headers: { 'User-Agent': 'CitizenGO-ContentDesk/1.0 (+https://meta-organic-reporting.vercel.app)' } }).catch((e) => ({ ok: false, status: e.message }));
    if (!r.ok) { console.log(`  ${ed.edition} ${topic}: HTTP ${r.status}`); continue; }
    const rows = parseFeed(await r.text(), topic, Date.now(), ed.edition);
    console.log(`  ${ed.edition} ${topic}: ${rows.length} headline(s)`);
    if (pg && rows.length) await pg.upsert('listen_news', rows, 'url');
    stored += rows.length;
    await new Promise((res) => setTimeout(res, 1500));
  }
  if (pg) {
    const base = String(process.env.SUPABASE_URL).trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
    const key = process.env.SUPABASE_SERVICE_KEY;
    const cut = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString();
    await fetch(`${base}/rest/v1/listen_news?collected_at=lt.${encodeURIComponent(cut)}`, { method: 'DELETE', headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'return=minimal' } });
  }
  console.log(`done: ${stored} headline(s)`);
}

if (require.main === module) main().catch((e) => { console.error(`news watch failed: ${e.message}`); process.exit(1); });

module.exports = { parseFeed, QUERIES, QUERIES_MX, EDITIONS };
