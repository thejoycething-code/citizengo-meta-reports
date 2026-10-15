#!/usr/bin/env node
'use strict';
// Loads one Looker pull into link_signatures (see scripts/link-signatures-mini.sh).
//
//   node scripts/load-link-signatures.js <stream.jsonl> [--dry-run]
//
// The input is Claude Code's stream-json output from that pull. The query
// result is in the tool_result of the Looker query call: inline when small,
// otherwise saved to a file whose path the tool_result names. Both are read.
//
// A pull replaces the table: rows are upserted with this run's pulled_at, then
// rows from older pulls are deleted - but only when the pull looks complete
// (rows came back and the row limit was not hit), so a broken or
// truncated pull never wipes good data.

const fs = require('fs');
const { loadEnv } = require('../lib/graph');
const links = require('../lib/links');
const { makeSink } = require('../collector/lib/sinks');

const LIMIT = 50000; // the limit both Looker queries ask for (link-signatures-mini.sh)
const SOCIAL_SERIES = /^(fb|ig|tw|tk|yt|tg)\d{1,2}$/;
const SOCIAL_SOURCES = new Set(['fb', 'ig', 'tw', 'tk', 'yt', 'tg']);
// Generic values that are not one post's link: the thank-you-page share
// ("typage"), share buttons that send only the list ("es_mx-"), placeholders.
const GENERIC = (c) => c === 'typage' || /-$/.test(c) || c.length < 8 || /\{\{/.test(c);
const F = 'petitions_signatures_3_0.';

// Pull the query rows out of a stream-json transcript. Pure, for the tests.
function rowsFromStream(text, readFile = (p) => fs.readFileSync(p, 'utf8')) {
  const queryIds = new Set();
  const results = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
    const content = ev && ev.message && Array.isArray(ev.message.content) ? ev.message.content : [];
    for (const c of content) {
      if (c.type === 'tool_use' && /Looker__query$/.test(c.name || '')) queryIds.add(c.id);
      if (c.type === 'tool_result' && queryIds.has(c.tool_use_id)) results.push(c);
    }
  }
  if (!results.length) throw new Error('no Looker query result in the stream (did Claude call the query tool?)');
  // Every query's rows, concatenated (the pull makes two; overlap is merged later).
  const perQuery = results.map((c) => {
    let body = Array.isArray(c.content) ? c.content.map((x) => x.text || '').join('') : String(c.content || '');
    const saved = body.match(/saved to:?\s*(\/\S+?\.(?:txt|json))/i);
    if (saved) body = readFile(saved[1]);
    return parseRows(body);
  });
  const all = perQuery.flat();
  all.perQuery = perQuery.map((r) => r.length);
  return all;
}

function parseRows(body) {
  let v = JSON.parse(body);
  // The connector may wrap the payload as [{type:'text', text:'<json>'}].
  if (Array.isArray(v) && v.length && v.every((x) => x && x.type === 'text' && typeof x.text === 'string')) {
    v = v.flatMap((x) => { const j = JSON.parse(x.text); return Array.isArray(j) ? j : [j]; });
  }
  if (!Array.isArray(v)) throw new Error('Looker result is not a list of rows');
  return v;
}

function toSignatureRows(lookerRows, pulledAt) {
  const out = new Map();
  for (const r of lookerRows) {
    const code = String(r[F + 'utm_campaign'] || '').trim().toLowerCase();
    if (!code) continue;
    const p = links.parseCode(code);
    const source = String(r[F + 'source'] || '(unassigned)').toLowerCase();
    // A Copilot social code (any arrival source), or any non-generic code
    // whose signers came straight from a social platform (hand-made codes).
    const socialCode = p.series && SOCIAL_SERIES.test(p.series);
    if (!socialCode && !(SOCIAL_SOURCES.has(source) && !GENERIC(code))) continue;
    const num = (k) => (r[F + k] === null || r[F + k] === undefined ? null : Number(r[F + k]));
    out.set(`${code}|${source}`, {
      campaign_code: code, source,
      signatures: num('sum_signatures'), new_members: num('sum_new_members'), reactivated_members: num('sum_reactivated_members'),
      owner: p.owner, petition_id: p.petition_id, series: p.series, code_date: p.code_date, pulled_at: pulledAt,
    });
  }
  return [...out.values()];
}

async function main() {
  loadEnv();
  const file = process.argv[2];
  const dry = process.argv.includes('--dry-run');
  if (!file) { console.error('Usage: node scripts/load-link-signatures.js <stream.jsonl> [--dry-run]'); process.exit(2); }
  const pulledAt = new Date().toISOString();
  const looker = rowsFromStream(fs.readFileSync(file, 'utf8'));
  const rows = toSignatureRows(looker, pulledAt);
  // Either query at its cap means rows are missing: keep the older rows.
  const truncated = (looker.perQuery || [looker.length]).some((c) => c >= LIMIT);
  console.log(`${pulledAt} Looker returned ${(looker.perQuery || [looker.length]).join(' + ')} rows; ${rows.length} social campaign-code rows${truncated ? ' (HIT THE ROW LIMIT: older rows kept)' : ''}`);
  if (!rows.length) { console.log('nothing to load; existing rows kept'); return; }
  const sink = makeSink({ dryRun: dry, dir: require('path').join(__dirname, '..', 'data') });
  for (let i = 0; i < rows.length; i += 500) await sink.upsert('link_signatures', rows.slice(i, i + 500));
  await sink.flush();
  if (!dry && !truncated) {
    const base = process.env.SUPABASE_URL.trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
    const key = process.env.SUPABASE_SERVICE_KEY;
    const r = await fetch(`${base}/rest/v1/link_signatures?pulled_at=lt.${encodeURIComponent(pulledAt)}`, { method: 'DELETE', headers: { apikey: key, Authorization: 'Bearer ' + key, Prefer: 'return=minimal' } });
    if (!r.ok) throw new Error(`clearing older rows failed: HTTP ${r.status}`);
  }
  console.log(`loaded ${rows.length} rows`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { rowsFromStream, parseRows, toSignatureRows };
