#!/usr/bin/env node
'use strict';
// Moves the review board's drafts (the claude.ai artifact's own store) into
// engine_posts, for the Phase 2 cutover. Re-runnable: a post already edited in
// the engine (updated_by is no longer 'import') is left alone, so running it
// again at cutover only refreshes posts nobody has touched there yet.
//
// It reads a dump of the board's "drafts" collection (one JSON file per draft,
// named <id>.json, as ArtifactData list with out_dir writes them) and prints
// SQL in batches (no credentials), or with --apply writes through the store
// using SUPABASE_URL and SUPABASE_SERVICE_KEY.
//
// Usage: node scripts/engine-import-board.js <dump dir> [--batch 10] [--out dir]
//        node scripts/engine-import-board.js <dump dir> --apply

const fs = require('fs');
const path = require('path');
const E = require('../lib/engine');

// Every board draft belongs to the UK team for now: uk-… and sc-… (Scotland
// is part of the UK team).
const teamFor = (id) => (/^(uk|sc)-/.test(id) ? 'uk' : null);

function toRow(id, board, now = Date.now()) {
  const team = teamFor(id);
  if (!team) return { skip: `${id}: no team for this id` };
  const { status, id: _id, ...doc } = board;
  if (status === 'archived') doc.archived = { ...(doc.archived || {}), boardStatus: 'archived' };
  const at = doc.posting && doc.posting.at;
  return {
    row: {
      id, team_id: team, status: E.fromBoardStatus(status, at, now), title: String(doc.title || ''),
      post_at: E.postAt(doc), doc, created_at: doc.createdAt || null, created_by: 'import', updated_by: 'import',
    },
  };
}

const lit = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
function jsonLit(obj) {
  const text = JSON.stringify(obj);
  let tag = 'j'; while (text.includes(`$${tag}$`)) tag += 'j';
  return `$${tag}$${text}$${tag}$::jsonb`;
}

function upsertSql(rows) {
  const values = rows.map((r) => `(${[lit(r.id), lit(r.team_id), lit(r.status), lit(r.title), r.post_at ? `${lit(r.post_at)}::timestamptz` : 'null',
    jsonLit(r.doc), r.created_at ? `${lit(r.created_at)}::timestamptz` : 'now()', lit(r.created_by), lit(r.updated_by)].join(', ')})`);
  return `insert into public.engine_posts (id, team_id, status, title, post_at, doc, created_at, created_by, updated_by) values\n${values.join(',\n')}
on conflict (id) do update set status = excluded.status, title = excluded.title, post_at = excluded.post_at, doc = excluded.doc,
  version = engine_posts.version + 1, updated_at = now()
where engine_posts.updated_by = 'import';\n`;
}

// The same rule as the SQL, through the store: insert new posts, refresh ones
// still untouched since the last import, leave the rest.
async function applyRows(store, rows) {
  const tally = { inserted: 0, refreshed: 0, kept: 0 };
  for (const r of rows) {
    const cur = await store.enginePost(r.id);
    if (!cur) { await store.engineInsertPost(r); tally.inserted++; continue; }
    if (cur.updated_by !== 'import') { tally.kept++; continue; }
    const { id, team_id, created_at, created_by, ...fields } = r;
    if (await store.engineUpdatePost(id, cur.version, fields)) tally.refreshed++; else tally.kept++;
  }
  return tally;
}

function readDump(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    return { id: path.basename(f, '.json'), doc: raw.data && typeof raw.data === 'object' && !raw.title ? raw.data : raw };
  });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir) { console.error('Usage: node scripts/engine-import-board.js <dump dir> [--batch 10] [--out dir]'); process.exit(2); }
  const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d; };
  const size = Number(opt('--batch', 10));
  const out = opt('--out', null);
  const rows = [];
  for (const { id, doc } of readDump(dir)) {
    const r = toRow(id, doc);
    if (r.skip) console.error(`skip ${r.skip}`); else rows.push(r.row);
  }
  const counts = rows.reduce((c, r) => ({ ...c, [r.status]: (c[r.status] || 0) + 1 }), {});
  console.error(`${rows.length} posts: ${JSON.stringify(counts)}`);
  if (args.includes('--apply')) {
    const { supabaseStore } = require('../lib/store');
    const store = supabaseStore({ url: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_KEY });
    applyRows(store, rows).then((t) => console.error(JSON.stringify(t))).catch((e) => { console.error(e.message); process.exit(1); });
    return;
  }
  for (let i = 0; i < rows.length; i += size) {
    const sql = upsertSql(rows.slice(i, i + size));
    if (out) { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, `batch-${String(i / size + 1).padStart(2, '0')}.sql`), sql); }
    else process.stdout.write(sql + '\n');
  }
}

module.exports = { toRow, upsertSql, applyRows, teamFor };
