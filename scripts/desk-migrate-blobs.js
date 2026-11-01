#!/usr/bin/env node
'use strict';
// One-off (Nov 2026): uploads the photos the old artifact desk kept in its own
// file store (cards point at /_blob/<id>) to the public desk-assets bucket as
// legacy/<id>, so the web desk can show them and the artifact can be deleted.
// The cards are repointed afterwards with one SQL update.
//
//   SUPABASE_URL=… SUPABASE_SERVICE_KEY="$(pbpaste)" node scripts/desk-migrate-blobs.js <folder of <id>.<ext> files>
const fs = require('fs');
const path = require('path');
const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

async function main() {
  const base = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!base || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required.');
  const dir = process.argv[2];
  if (!dir) throw new Error('Give the folder of downloaded photos.');
  let ok = 0; const failed = [];
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^([0-9a-f]{32})\.([a-z]+)$/);
    if (!m || !TYPES[m[2]]) continue;
    const r = await fetch(`${base}/storage/v1/object/desk-assets/legacy/${m[1]}`, {
      method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': TYPES[m[2]], 'x-upsert': 'true' }, body: fs.readFileSync(path.join(dir, f)),
    });
    if (r.ok) ok++; else failed.push(`${f}: HTTP ${r.status}`);
  }
  console.log(`${ok} photos uploaded${failed.length ? `; failed: ${failed.join(', ')}` : ''}`);
  if (failed.length) process.exit(1);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
