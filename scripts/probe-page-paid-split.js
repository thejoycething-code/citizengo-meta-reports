#!/usr/bin/env node
'use strict';
// Does the PAGE-level views metric include ads?
//
// The question that prompted this: Business Suite reported 787,058 views for
// the UK page in August, our page_media_view sums to 807,299 for the same
// month, and the two clearly describe the same thing. But that page ran £906 of
// ads in August (167,676 impressions), so whether the figure is organic-only
// changes how it should be read - and whether it can be compared with our
// organic post totals at all.
//
// Settles it by asking Meta for page_media_view twice: once plain, once broken
// down by is_from_ads, the same breakdown the collector already uses per post.
// If the segments sum to the plain total, the plain total includes ads.
//
// READ-ONLY. Writes nothing.
//   META_TOKENS=... node scripts/probe-page-paid-split.js [page_id] [since] [until]

const { loadEnv, makeClient } = require('../lib/graph');
const { makePageTokens } = require('../lib/pagetokens');
loadEnv();

const VERSION = process.env.GRAPH_VERSION || 'v23.0';
const TOKENS = String(process.env.META_TOKENS || process.env.META_TOKEN || '')
  .split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
if (!TOKENS.length) { console.error('No token. Set META_TOKENS or META_TOKEN.'); process.exit(2); }

const PAGE = process.argv[2] || '105872884133170';       // Citizen GO UK
const SINCE = process.argv[3] || '2026-08-01';
const UNTIL = process.argv[4] || '2026-09-01';

const client = makeClient({ token: TOKENS[0], version: VERSION });
const { enumeratePages, tokenFor } = makePageTokens(client, TOKENS);

// Same shape the collector's breakdown() expects: values[] carry the breakdown
// key alongside the value.
function segments(res, key) {
  const out = {};
  if (!res || !res.ok) return out;
  const d = res.body && res.body.data && res.body.data[0];
  for (const v of (d && d.values) || []) {
    if (v && v[key] !== undefined) {
      const k = String(v[key]);
      out[k] = (out[k] || 0) + (typeof v.value === 'number' ? v.value : 0);
    }
  }
  return out;
}

function plainTotal(res) {
  if (!res || !res.ok) return null;
  const d = res.body && res.body.data && res.body.data[0];
  return ((d && d.values) || []).reduce((a, v) => a + (typeof v.value === 'number' ? v.value : 0), 0);
}

(async () => {
  console.log(`Graph ${VERSION} · page ${PAGE} · ${SINCE} to ${UNTIL}\n`);
  await enumeratePages();
  const token = await tokenFor(PAGE);
  if (!token) { console.error(`No page token for ${PAGE}.`); process.exit(1); }

  const range = {
    period: 'day',
    since: Math.floor(Date.parse(SINCE) / 1000),
    until: Math.floor(Date.parse(UNTIL) / 1000),
  };

  for (const metric of ['page_media_view', 'page_total_media_view_unique', 'page_post_engagements']) {
    const plain = await client.get(`/${PAGE}/insights`, { metric, ...range }, { token });
    const total = plainTotal(plain);
    console.log(`${metric}`);
    console.log(`  plain total over the window: ${total === null ? 'ERROR ' + JSON.stringify(plain.error && plain.error.message) : total.toLocaleString('en-GB')}`);

    for (const key of ['is_from_ads', 'is_from_followers']) {
      const res = await client.get(`/${PAGE}/insights`, { metric, breakdown: key, ...range }, { token });
      if (!res.ok) {
        const m = res.error && res.error.message ? res.error.message : `HTTP ${res.status}`;
        console.log(`  breakdown ${key}: NOT AVAILABLE — ${String(m).slice(0, 90)}`);
        continue;
      }
      const seg = segments(res, key);
      const parts = Object.entries(seg).map(([k, v]) => `${k}=${v.toLocaleString('en-GB')}`).join('  ');
      const segSum = Object.values(seg).reduce((a, b) => a + b, 0);
      console.log(`  breakdown ${key}: ${parts || '(no segments returned)'}`);
      if (segSum && total) {
        const pct = ((segSum / total) * 100).toFixed(1);
        console.log(`      segments sum to ${segSum.toLocaleString('en-GB')} = ${pct}% of the plain total`
          + (Math.abs(segSum - total) / total < 0.02 ? '  -> the plain total INCLUDES these segments' : '  -> does NOT reconcile; treat with care'));
      }
    }
    console.log('');
  }

  console.log('Reading this: for is_from_ads, "1" (or true) is the paid segment.');
  console.log('If paid is non-zero and the segments reconcile with the plain total, then the');
  console.log('page-level views figure - and Business Suite, which matches it - includes ads.');
})().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
