#!/usr/bin/env node
'use strict';
// Seeds engine_key_dates: the CitizenGO-wide international days below, plus a
// team's own dates from its evergreen calendar (content-engine/evergreen-calendar.md
// for the UK). Parliament days (second readings, recesses, conferences) are left
// out [1 Nov], and so are rows without a firm date ("Mid-Jan", "Early Sep").
// Prints SQL; re-runnable (on conflict do nothing).
// Usage: node scripts/engine-key-dates.js [<evergreen-calendar.md> <team>]

const fs = require('fs');

// Fixed-date days observed CitizenGO-wide, and the moveable feasts for 2027.
const GLOBAL_FIXED = [
  ['03-08', "International Women's Day"],
  ['03-21', 'World Down Syndrome Day'],
  ['03-25', 'International Day of the Unborn Child'],
  ['05-15', 'International Day of Families'],
  ['06-01', 'Global Day of Parents'],
  ['08-22', 'UN Day for Victims of Religion-based Violence'],
  ['11-20', "Universal Children's Day"],
  ['12-03', 'International Day of Persons with Disabilities'],
  ['12-10', 'Human Rights Day'],
  ['12-25', 'Christmas Day'],
];
const GLOBAL_DATED = [
  ['2026-11-01', 'International Day of Prayer for the Persecuted Church'],
  ['2027-02-10', 'Ash Wednesday'],
  ['2027-03-26', 'Good Friday'],
  ['2027-03-28', 'Easter Sunday'],
  ['2027-05-16', 'Pentecost'],
];

function globalDates(fromYear = 2026, toYear = 2027, from = '2026-11-01') {
  const out = GLOBAL_DATED.map(([starts, title]) => ({ starts, title }));
  for (let y = fromYear; y <= toYear; y++) for (const [md, title] of GLOBAL_FIXED) out.push({ starts: `${y}-${md}`, title });
  return out.filter((d) => d.starts >= from).map((d) => ({ ...d, team_id: null, kind: 'key', confidence: 'calendar', source: 'CitizenGO-wide list' }));
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const PARLIAMENT = /second reading|recess|party conference/i; // sittings, not anniversaries

// "Sun 8 Nov 2026", "15–22 Nov 2026", "18 Dec 2026 – 4 Jan 2027", "Thu 15 Oct 2026, 7pm".
function parseWhen(text) {
  const t = String(text).replace(/\*\*/g, '').replace(/,.*$/, '').trim();
  if (/^(mid|early|late|~)/i.test(t) || /\(month\)/i.test(t)) return null;
  let m = t.match(/^(?:\w{3} )?(\d{1,2}) (\w{3}) (\d{4}) [–-] (\d{1,2}) (\w{3}) (\d{4})$/);
  if (m) return { starts: iso(m[3], MONTHS[m[2].toLowerCase()], m[1]), ends: iso(m[6], MONTHS[m[5].toLowerCase()], m[4]) };
  m = t.match(/^(\d{1,2})[–-](\d{1,2}) (\w{3}) (\d{4})$/);
  if (m) return { starts: iso(m[4], MONTHS[m[3].toLowerCase()], m[1]), ends: iso(m[4], MONTHS[m[3].toLowerCase()], m[2]) };
  m = t.match(/^(?:\w{3} )?(\d{1,2}) (\w{3}) (\d{4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return { starts: iso(m[3], MONTHS[m[2].toLowerCase()], m[1]), ends: null };
  return null;
}

function teamDates(markdown, team) {
  const out = [];
  for (const line of String(markdown).split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 6 || !/\d{4}/.test(cells[1]) || /^-+$/.test(cells[1])) continue;
    const when = parseWhen(cells[1]);
    const title = cells[2].replace(/\*\*/g, '');
    if (!when || PARLIAMENT.test(title)) continue;
    out.push({ team_id: team, ...when, title, kind: /mother/i.test(title) ? 'mothers_day' : 'key', confidence: cells[5] || null, angle: [cells[3], cells[4]].filter(Boolean).join(' · ') || null, source: 'evergreen-calendar.md' });
  }
  return out;
}

const lit = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
function sql(rows) {
  return `insert into public.engine_key_dates (team_id, starts, ends, title, kind, confidence, angle, source) values\n${rows
    .map((r) => `(${[lit(r.team_id), lit(r.starts), lit(r.ends), lit(r.title), lit(r.kind), lit(r.confidence), lit(r.angle), lit(r.source)].join(', ')})`)
    .join(',\n')}\non conflict do nothing;\n`;
}

if (require.main === module) {
  const [file, team] = process.argv.slice(2);
  const rows = globalDates().concat(file ? teamDates(fs.readFileSync(file, 'utf8'), team || 'uk') : []);
  console.error(`${rows.length} key dates`);
  process.stdout.write(sql(rows));
}

module.exports = { parseWhen, teamDates, globalDates, sql };
