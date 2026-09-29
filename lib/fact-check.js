'use strict';
// A fact check for breakout alerts that spends no Claude API tokens: no model
// at all, only free public sources and fixed rules. Built 29 Sept 2026, after
// an API-based check was built and reverted because Christopher ruled out API
// spend. The scheduled Claude task still does the full judgement check; this is
// what the webhook route (--post) can do on its own.
//
// WHAT IT CAN DO, and what it cannot, because the alert must say which:
//
//   1. FIGURES AGAINST COVERAGE. The caption's figures ("almost 60,000 voices")
//      are compared with the figures in news headlines about the same named
//      people, from Google News RSS (keyless). On the first live candidate it
//      caught the real problem: the post said "almost 60,000", the Express
//      headline said "40,000 are demanding he quits".
//   Published fact-checks (Google's ClaimReview feed, keyless) were tried and
//   dropped the same day: matched by names against the 60 past 100k posts, it
//   returned 55 "matches" and every one was wrong - "Supreme Court", "World
//   Cup" and "government" pulled in fact-checks from India, the Philippines and
//   New York. Whether a published check covers the same claim is a judgement
//   rules cannot make, so this does not pretend to.
//
//   It cannot read meaning. It does not know whether a quote is misattributed
//   or a law has passed; it only knows whether figures match what the press
//   printed. So its verdicts are "matches coverage" / "differs from coverage" /
//   "not found in coverage", never "true" or "false".
//
// Every link comes from a feed or API response, never from composed text, so
// none can be invented. Rules as for the scheduled task: a problem, or a check
// that could not run, never blocks an alert; it becomes a warning under the
// first line.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36';

// Google News editions by caption language. Detection is by stopwords, which
// is crude but enough to pick an edition; a wrong guess only costs recall.
const EDITIONS = {
  en: { hl: 'en-GB', gl: 'GB', ceid: 'GB:en', words: ['the', 'and', 'of', 'to', 'is', 'for', 'our', 'has'] },
  es: { hl: 'es', gl: 'ES', ceid: 'ES:es', words: ['el', 'la', 'los', 'las', 'que', 'por', 'una', 'del'] },
  it: { hl: 'it', gl: 'IT', ceid: 'IT:it', words: ['il', 'della', 'che', 'per', 'una', 'gli', 'sono', 'nel'] },
  pt: { hl: 'pt-BR', gl: 'BR', ceid: 'BR:pt-419', words: ['não', 'uma', 'para', 'com', 'dos', 'das', 'são', 'pelo'] },
  fr: { hl: 'fr', gl: 'FR', ceid: 'FR:fr', words: ['les', 'des', 'est', 'pour', 'une', 'dans', 'qui', 'pas'] },
  de: { hl: 'de', gl: 'DE', ceid: 'DE:de', words: ['der', 'die', 'und', 'das', 'ist', 'nicht', 'mit', 'für'] },
  pl: { hl: 'pl', gl: 'PL', ceid: 'PL:pl', words: ['nie', 'się', 'jest', 'oraz', 'dla', 'przez', 'jak', 'już'] },
  hr: { hl: 'hr', gl: 'HR', ceid: 'HR:hr', words: ['je', 'su', 'se', 'nije', 'koji', 'kao', 'ali', 'što'] },
};

function language(text) {
  const words = String(text).toLowerCase().split(/[^\p{L}]+/u);
  let best = 'en'; let score = 0;
  for (const [lang, ed] of Object.entries(EDITIONS)) {
    const s = words.filter((w) => ed.words.includes(w)).length;
    if (s > score) { best = lang; score = s; }
  }
  return best;
}

// Names to search on. Titlecase words NOT at the start of a sentence, because
// every sentence starts with a capital ("Khan has failed", "Girls as young",
// "Thank you"); a name survives because it recurs mid-sentence. Ranked by how
// often they appear, the organisation's own names dropped.
const OWN = new Set(['citizengo', 'citizen', 'hazteoir', 'actuall']);
// Once a word has appeared as a name mid-sentence, its sentence-initial uses
// count too ("Khan has failed"), and ties go to the name that appears first.
// Without both, a test caption ranked "Hall" (City Hall, Susan Hall) above
// "Khan" and searched for the wrong pair.
function entities(text, limit = 4) {
  const seen = []; const mid = new Set(); const counts = new Map(); const first = new Map();
  for (const sentence of String(text).split(/(?<=[.!?…])\s+|\n+/)) {
    sentence.replace(/^[^\p{L}]+/u, '').split(/\s+/).forEach((w, i) => {
      const clean = w.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '').replace(/['’]s$/, '');
      if (!/^\p{Lu}\p{Ll}{2,}$/u.test(clean) || OWN.has(clean.toLowerCase())) return;
      seen.push(clean);
      if (i > 0) mid.add(clean);
    });
  }
  seen.forEach((w, pos) => {
    if (!mid.has(w)) return;
    counts.set(w, (counts.get(w) || 0) + 1);
    if (!first.has(w)) first.set(w, pos);
  });
  return [...counts.keys()].sort((x, y) => counts.get(y) - counts.get(x) || first.get(x) - first.get(y)).slice(0, limit);
}

// "almost 60,000", "60.000", "1,2 millones", "40k", "12%". Returns the value
// and the word after it, which is what the figure counts.
const SCALE = { k: 1e3, thousand: 1e3, mil: 1e3, million: 1e6, millones: 1e6, milioni: 1e6, millions: 1e6, milhões: 1e6, mln: 1e6 };
function figures(text) {
  const out = [];
  const re = /(\d{1,3}(?:[.,\s]\d{3})+|\d+(?:[.,]\d+)?)\s*(%|k\b|thousand|million(?:s|es|i)?|millones|milhões|mln)?\s*([\p{L}]+)?/giu;
  for (const m of String(text).matchAll(re)) {
    const raw = m[1]; const scaleWord = (m[2] || '').toLowerCase();
    let value;
    if (/[.,\s]\d{3}$/.test(raw) && !/[.,]\d{1,2}$/.test(raw)) value = Number(raw.replace(/[.,\s]/g, ''));
    else value = Number(raw.replace(',', '.'));
    if (!Number.isFinite(value)) continue;
    if (scaleWord === '%') { out.push({ value, percent: true, text: m[0].trim(), unit: '%' }); continue; }
    if (SCALE[scaleWord]) value *= SCALE[scaleWord];
    // Small counts (ages, "13 girls") and years are not what press headlines
    // restate, so comparing them only produces noise.
    if (value < 100 || (value >= 1900 && value <= 2100 && !raw.includes(',') && !raw.includes('.'))) continue;
    out.push({ value, percent: false, text: m[0].trim(), unit: (m[3] || '').toLowerCase() });
  }
  return out;
}

const decode = (s) => String(s).replace(/<!\[CDATA\[|\]\]>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

async function newsSearch(terms, lang, doFetch) {
  const ed = EDITIONS[lang] || EDITIONS.en;
  const q = encodeURIComponent(terms.join(' '));
  const url = `https://news.google.com/rss/search?q=${q}&hl=${ed.hl}&gl=${ed.gl}&ceid=${ed.ceid}`;
  const res = await doFetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Google News HTTP ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => {
    const get = (tag) => decode((it.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1] || '');
    return { title: get('title'), link: get('link'), source: get('source'), date: get('pubDate') };
  }).filter((i) => i.title && i.link);
}

// Topic words: the lowercase words of five letters or more in the sentences
// around each figure. Names alone are not enough to search on: on the first
// live candidate "Khan Sadiq Hall" returned 82 headlines and missed the one
// that mattered, while "Sadiq Khan petition" found it. Short words and a small
// stoplist of filler ("almost", "earlier") are dropped; the rest are tried one
// query each.
const FILLER = new Set(['almost', 'nearly', 'earlier', 'month', 'today', 'there', 'their', 'which', 'these', 'those', 'about',
  'after', 'before', 'where', 'while', 'every', 'being', 'behalf', 'thank', 'still', 'other', 'would', 'could', 'should',
  'también', 'porque', 'desde', 'hasta', 'sobre', 'entre', 'mientras', 'ancora', 'perché', 'questo', 'questa', 'quando',
  'dopo', 'prima', 'porque', 'quando', 'depois', 'antes', 'aussi', 'depuis', 'avant', 'après']);
function topicWords(text, limit = 6) {
  const sentences = String(text).split(/(?<=[.!?…])\s+|\n+/);
  const near = new Set();
  sentences.forEach((sn, i) => { if (/\d/.test(sn)) [i - 1, i, i + 1].forEach((j) => j >= 0 && j < sentences.length && near.add(j)); });
  const out = [];
  for (const i of [...near].sort((a, b) => a - b)) {
    for (const w of sentences[i].split(/[^\p{L}]+/u)) {
      if (w.length >= 5 && w === w.toLowerCase() && !FILLER.has(w) && !out.includes(w)) out.push(w);
    }
  }
  return out.slice(0, limit);
}

// A headline "is about" the post when it names at least two of its entities
// (or its only one) AND shares a topic word with it. The second test stops a
// figure from another story about the same person being compared.
function about(item, names, topics = []) {
  const t = item.title.toLowerCase();
  const hits = names.filter((n) => t.includes(n.toLowerCase())).length;
  if (hits < Math.min(2, names.length)) return false;
  return !topics.length || topics.some((w) => t.includes(w.slice(0, Math.max(5, w.length - 2))));
}

// Compare each caption figure with figures in relevant headlines. A headline
// figure counts only when it is the same kind (percent with percent) and the
// same order of magnitude; within 15% is a match, since captions round and
// petitions keep growing.
//
// Only coverage from around the post's own date is compared (WINDOW_BEFORE
// days before it to a week after). Found on the first live candidate: the
// "40,000 are demanding he quits" headline was from March, six months before
// the petition was handed in at "almost 60,000" - a petition that grew, not a
// wrong figure - and "37,000 sign petition" was a different petition from
// December 2024. Without the window both would have been reported as errors.
const WINDOW_BEFORE = Number(process.env.FACT_CHECK_WINDOW_DAYS || 45);
function inWindow(item, published) {
  if (!published) return true;
  const t = Date.parse(item.date); const p = Date.parse(published);
  if (!Number.isFinite(t) || !Number.isFinite(p)) return false;
  return t >= p - WINDOW_BEFORE * 86400000 && t <= p + 7 * 86400000;
}

function compareFigures(captionFigures, items) {
  return captionFigures.map((f) => {
    let match = null; let conflict = null;
    for (const item of items) {
      for (const g of figures(item.title)) {
        if (g.percent !== f.percent) continue;
        const ratio = g.value / f.value;
        if (!f.percent && (ratio < 0.3 || ratio > 3)) continue;
        const close = f.percent ? Math.abs(g.value - f.value) <= 2 : Math.abs(ratio - 1) <= 0.15;
        if (close && !match) match = { item, figure: g };
        if (!close && !conflict) conflict = { item, figure: g };
      }
    }
    if (match) return { claim: f.text, verdict: 'matches', item: match.item };
    if (conflict) return { claim: f.text, verdict: 'differs', item: conflict.item, found: conflict.figure.text };
    return { claim: f.text, verdict: 'not_found' };
  });
}

// Returns { ok, figures: [...], searched, noClaims, error }.
// Never throws: the caller posts either way.
async function factCheck(post, opts = {}) {
  const doFetch = opts.fetch || fetch;
  const text = String(post.message || '').trim();
  if (!text) return { ok: true, figures: [], noClaims: true };
  const lang = language(text);
  const names = entities(text);
  const nums = figures(text);
  // Figures are the only thing this can check, so a caption without one has
  // nothing to compare (55 of the 60 past 100k posts).
  if (!nums.length) return { ok: true, figures: [], noClaims: true };

  try {
    let items = [];
    if (nums.length && names.length) {
      // The two leading names plus one topic word per query. Google News ANDs
      // its terms, so one long query finds almost nothing, and names alone find
      // too much. Stems (first letters) match "demanding" to "demands".
      const topics = topicWords(text);
      const lead = names.slice(0, 2);
      const seen = new Set();
      for (const w of topics.length ? topics : [null]) {
        for (const item of await newsSearch(w ? [...lead, w] : lead, lang, doFetch)) {
          if (!seen.has(item.link) && about(item, lead, topics) && inWindow(item, post.published)) { seen.add(item.link); items.push(item); }
        }
      }
    }
    return { ok: true, figures: compareFigures(nums, items), searched: items.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// The block, in the alert's two flavours (see render() in breakout-alerts.js).
// 'top' for a warning, which must be seen before anyone reuses the post.
function renderFactCheck(result, { flavour = 'mrkdwn' } = {}) {
  const md = flavour === 'markdown';
  const b = (t) => (md ? `**${t}**` : `*${t}*`);
  const link = (url, label) => (md ? `[${label}](${url})` : `<${url}|${label.replace(/[<>|]/g, '')}>`);
  const scope = '_Automated check, no AI: figures compared with news headlines only; quotes, names and laws were not checked._';

  if (!result.ok) return { where: 'top', text: b('⚠️ Fact check could not be run today. Verify before reusing.') };
  if (result.noClaims) return { where: 'bottom', text: `${b('Fact check:')} no figures in the caption to compare.\n${scope}` };

  const lines = [];
  const differs = result.figures.filter((f) => f.verdict === 'differs');
  for (const f of differs) lines.push(`• ❌ "${f.claim}": the press reported ${f.found} (${link(f.item.link, f.item.source || 'source')})`);
  for (const f of result.figures.filter((x) => x.verdict === 'not_found')) lines.push(`• ❓ "${f.claim}": not found in news coverage from around the post's date`);
  for (const f of result.figures.filter((x) => x.verdict === 'matches')) lines.push(`• ✅ "${f.claim}" matches ${link(f.item.link, f.item.source || 'coverage')}`);

  // "Not found" is a warning too, by the rule Christopher set for the
  // scheduled task: a claim that cannot be verified is flagged, not waved on.
  const unmatched = result.figures.filter((f) => f.verdict === 'not_found');
  if (differs.length || unmatched.length) {
    const why = differs.length ? 'a figure here differs from what the press reported'
      : 'a figure here could not be matched to news coverage';
    return { where: 'top', text: [`${b('⚠️ Check before reusing:')} ${why}.`, ...lines, scope].join('\n') };
  }
  return { where: 'bottom', text: [`${b('Fact check:')} the figures match news coverage.`, ...lines, scope].join('\n') };
}

// A warning goes directly under the first line (the "Automated alert" line),
// a clean result at the end.
function withFactCheck(body, block) {
  const nl = body.indexOf('\n');
  if (block.where === 'bottom' || nl === -1) return `${body}\n\n${block.text}`;
  return `${body.slice(0, nl)}\n\n${block.text}\n${body.slice(nl)}`;
}

module.exports = { factCheck, renderFactCheck, withFactCheck, entities, figures, language, compareFigures, about, topicWords, inWindow };
