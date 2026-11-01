#!/usr/bin/env node
'use strict';
// Puts a private file for the desk (bucket desk-files), e.g. the Page Inviter zip:
//   SUPABASE_URL=… SUPABASE_SERVICE_KEY="$(pbpaste)" node scripts/desk-put-file.js page-inviter ~/Downloads/citizengo-page-inviter.zip
// Signed-in desk users download it through a 5-minute link (lib/desk.js fileLink).
const fs = require('fs');
const { FILES } = require('../lib/desk');
(async () => {
  const [name, file] = process.argv.slice(2);
  const base = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!base || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required.');
  if (!FILES[name] || !file || !fs.existsSync(file)) throw new Error(`Usage: desk-put-file.js <${Object.keys(FILES).join('|')}> <file>`);
  const r = await fetch(`${base}/storage/v1/object/desk-files/${FILES[name]}`, { method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/zip', 'x-upsert': 'true' }, body: fs.readFileSync(file) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  console.log(`${name}: uploaded (${Math.round(fs.statSync(file).size / 1024)} KB). The desk's Tools page can download it now.`);
})().catch((e) => { console.error(e.message); process.exit(1); });
