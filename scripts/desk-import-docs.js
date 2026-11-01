#!/usr/bin/env node
'use strict';
// One-off (Nov 2026): copies the old artifact desk's own documents (a dump made
// with ArtifactData list + out_dir, one JSON file per document) into
// engine_desk_docs, so the web app and the morning run keep them.
//
//   SUPABASE_URL=… SUPABASE_SERVICE_KEY="$(pbpaste)" node scripts/desk-import-docs.js <dump>/feedback [more dirs…]
//
// The collection is the directory's name (feedback, videoRequests,
// savedReplies, listenShares, analyticsGroups). Existing ids are left alone.
const fs = require('fs');
const path = require('path');
const { DOC_COLLECTIONS } = require('../lib/desk');

async function main() {
  const base = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!base || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required.');
  const dirs = process.argv.slice(2);
  if (!dirs.length) throw new Error('Give the dump folder(s), e.g. …/deskdocs/board/feedback');
  for (const dir of dirs) {
    const collection = path.basename(dir.replace(/\/+$/, ''));
    if (!DOC_COLLECTIONS.includes(collection)) { console.log(`skipped ${dir}: not a desk collection`); continue; }
    const rows = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
      let d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (d && d.data && typeof d.data === 'object' && !Array.isArray(d.data)) d = d.data;
      delete d.version;
      return { collection, id: f.slice(0, -5), team: d.team || null, data: d, created_by: String(d.by || 'board'), created_at: d.at || new Date().toISOString() };
    });
    const r = await fetch(`${base}/rest/v1/engine_desk_docs?on_conflict=collection,id`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify(rows),
    });
    if (!r.ok) throw new Error(`${collection}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    console.log(`${collection}: ${rows.length} documents copied (existing ones left alone)`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
