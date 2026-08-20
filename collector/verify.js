#!/usr/bin/env node
'use strict';
// Verifies the collector is idempotent by diffing two NDJSON snapshots.
//
// "Idempotent" here means a rerun produces the same ROWS, not byte-identical
// files: collected_at and the run id legitimately differ, and metric VALUES can
// legitimately move because engagement keeps accruing between runs. What must
// never change is the key set — a rerun that duplicates rows is the bug this
// guards against.
//
// Usage: node collector/verify.js <dirA> <dirB>

const fs = require('fs');
const path = require('path');

const VOLATILE = new Set(['collected_at', 'run_id', 'started_at', 'finished_at', 'last_seen_at', 'first_seen_at']);
const KEYS = {
  'meta_pages': (r) => r.page_id,
  'meta_posts': (r) => r.post_id,
  'meta_post_metrics': (r) => `${r.post_id}|${r.collected_date}`,
};

function read(dir, table) {
  const f = path.join(dir, `${table}.ndjson`);
  if (!fs.existsSync(f)) return null;
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function stable(row) {
  const out = {};
  for (const k of Object.keys(row).sort()) if (!VOLATILE.has(k)) out[k] = row[k];
  return JSON.stringify(out);
}

const [dirA, dirB] = process.argv.slice(2);
if (!dirA || !dirB) { console.error('Usage: node collector/verify.js <dirA> <dirB>'); process.exit(2); }

let failures = 0;
for (const [table, keyFn] of Object.entries(KEYS)) {
  const a = read(dirA, table);
  const b = read(dirB, table);
  if (!a || !b) { console.log(`  SKIP  ${table} (missing in one snapshot)`); continue; }

  const ka = new Set(a.map(keyFn));
  const kb = new Set(b.map(keyFn));
  const onlyA = [...ka].filter((k) => !kb.has(k));
  const onlyB = [...kb].filter((k) => !ka.has(k));
  const dupA = a.length - ka.size;
  const dupB = b.length - kb.size;

  const mapA = new Map(a.map((r) => [keyFn(r), r]));
  const changed = [...kb].filter((k) => mapA.has(k) && stable(mapA.get(k)) !== stable(b.find((r) => keyFn(r) === k)));

  const bad = dupA || dupB || onlyA.length || onlyB.length;
  if (bad) failures++;
  console.log(`  ${bad ? 'FAIL' : 'PASS'}  ${table.padEnd(20)} ${a.length} -> ${b.length} rows · dup ${dupA}/${dupB} · only-in-A ${onlyA.length} · only-in-B ${onlyB.length} · values moved ${changed.length}`);
  if (changed.length && changed.length <= 3) {
    for (const k of changed) console.log(`          value change on ${k} (expected if engagement accrued)`);
  }
}

console.log(failures ? `\n${failures} table(s) FAILED idempotency` : '\nIdempotent: no duplicates, no missing or extra rows.');
process.exit(failures ? 1 : 0);
