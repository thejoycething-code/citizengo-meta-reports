#!/usr/bin/env node
'use strict';
// How much of the Reel catalogue has been transcribed, and what went wrong
// with the rest. Printed at the end of every transcription run, including a
// failed one: a run that transcribed 40 and quietly failed 10 looks identical
// to a clean run without this.
//
//   node scripts/transcript-coverage.js

const { loadEnv } = require('../lib/graph');

loadEnv();

const SB = String(process.env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY;

async function q(pathname) {
  const res = await fetch(`${SB}/rest/v1/${pathname}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : [];
}

async function main() {
  if (!SB || !KEY) { console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required'); process.exit(2); }

  const videos = await q('meta_ig_media?select=media_id&media_type=eq.VIDEO&limit=100000');
  const rows = await q('meta_ig_media_transcript?select=media_id,language,duration_seconds,error,model&limit=100000');

  const good = rows.filter((r) => !r.error);
  const bad = rows.filter((r) => r.error);
  const untried = videos.length - rows.length;
  const pct = videos.length ? ((good.length / videos.length) * 100).toFixed(1) : '0.0';
  const mins = Math.round(good.reduce((a, r) => a + (Number(r.duration_seconds) || 0), 0) / 60);

  console.log('\nTranscript coverage');
  console.log(`  ${good.length} of ${videos.length} Reels transcribed (${pct}%) · ${mins} min of audio`);
  console.log(`  ${bad.length} failed · ${untried} not yet attempted`);

  const byModel = {};
  for (const r of good) byModel[r.model] = (byModel[r.model] || 0) + 1;
  if (Object.keys(byModel).length) {
    console.log(`  by model: ${Object.entries(byModel).map(([m, c]) => `${m} ${c}`).join(', ')}`);
  }

  const byLang = {};
  for (const r of good) byLang[r.language || '??'] = (byLang[r.language || '??'] || 0) + 1;
  const langs = Object.entries(byLang).sort((a, b) => b[1] - a[1]);
  if (langs.length) console.log(`  by language: ${langs.map(([l, c]) => `${l} ${c}`).join(', ')}`);

  // Grouped, because 40 rows of the same message is one problem, not forty.
  if (bad.length) {
    const byErr = {};
    for (const r of bad) {
      const k = String(r.error).replace(/\d+/g, 'N').slice(0, 70);
      byErr[k] = (byErr[k] || 0) + 1;
    }
    console.log('\n  Failures by reason:');
    for (const [e, c] of Object.entries(byErr).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(c).padStart(4)}  ${e}`);
    }
  }
  console.log();
}

main().catch((e) => { console.error(e); process.exit(1); });
