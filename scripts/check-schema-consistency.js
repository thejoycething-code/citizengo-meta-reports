#!/usr/bin/env node
'use strict';
// Guards against drift between sql/schema.sql and the column list the preflight
// checks. Those two plus the mock now describe the schema in three places; if
// they disagree, the preflight either passes over a missing column or fails on a
// column that was legitimately added.
//
// Run this after any schema change. Usage: node scripts/check-schema-consistency.js

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const sql = fs.readFileSync(path.join(root, 'sql/schema.sql'), 'utf8');

function parseDDL(text) {
  const tables = {};
  const re = /create table if not exists public\.(\w+)\s*\(([\s\S]*?)\n\);/g;
  let m;
  while ((m = re.exec(text))) {
    const [, name, body] = m;
    const cols = [];
    for (let line of body.split('\n')) {
      line = line.replace(/--.*$/, '').trim();
      if (!line) continue;
      const c = line.match(/^([a-z_][a-z0-9_]*)\s+/);
      if (c && !/^(primary|unique|foreign|constraint|check)$/i.test(c[1])) cols.push(c[1]);
    }
    tables[name] = cols;
  }
  return tables;
}

function parseExpected(file) {
  const src = fs.readFileSync(file, 'utf8');
  const m = src.match(/const EXPECTED = \{([\s\S]*?)\n\};/);
  if (!m) throw new Error(`no EXPECTED block in ${file}`);
  // eslint-disable-next-line no-eval
  return eval('({' + m[1] + '})');
}

const ddl = parseDDL(sql);
const expected = parseExpected(path.join(root, 'scripts/check-supabase.js'));

let bad = 0;
for (const [table, cols] of Object.entries(expected)) {
  const actual = ddl[table];
  if (!actual) { console.log(`FAIL  ${table} — not found in sql/schema.sql`); bad++; continue; }
  const missing = cols.filter((c) => !actual.includes(c));
  // `id` is a surrogate identity key the collector never writes, so it is
  // legitimately absent from the preflight's list.
  const extra = actual.filter((c) => !cols.includes(c) && c !== 'id');
  if (missing.length || extra.length) {
    console.log(`FAIL  ${table}`);
    if (missing.length) console.log(`        preflight expects columns absent from the DDL: ${missing.join(', ')}`);
    if (extra.length) console.log(`        DDL has columns the preflight does not check: ${extra.join(', ')}`);
    bad++;
  } else {
    console.log(`PASS  ${table.padEnd(22)} ${cols.length} columns match the DDL`);
  }
}
for (const table of Object.keys(ddl)) {
  if (!expected[table]) { console.log(`FAIL  ${table} — in the DDL but not checked by the preflight`); bad++; }
}

console.log(bad ? `\n${bad} inconsistency(ies)` : '\nPreflight expectations match sql/schema.sql exactly.');
process.exit(bad ? 1 : 0);
