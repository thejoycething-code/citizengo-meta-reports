#!/usr/bin/env node
'use strict';
// Moves the laptop's Campaign Copilot sign-in (content-engine/copilot_mcp.py,
// ~/.config/content-engine/copilot.json) into the engine, so there is one
// copy: Copilot replaces the refresh token on every use, so two copies would
// lock each other out. After this the laptop's morning link run asks the
// engine for links (make_links.py --via-engine) and the local file is kept
// only as copilot.json.moved-to-engine. Run on the laptop:
//
//   SUPABASE_URL=… SUPABASE_SERVICE_KEY="$(pbpaste)" npm run -s copilot:adopt
const fs = require('fs');
const os = require('os');
const path = require('path');
const { requireSupabaseStore } = require('../lib/store');
const C = require('../lib/copilot');

async function main() {
  const file = path.join(os.homedir(), '.config', 'content-engine', 'copilot.json');
  if (!fs.existsSync(file)) throw new Error(`No laptop sign-in at ${file} (already moved?).`);
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!s.client_id || !s.refresh_token) throw new Error('The laptop sign-in has no client or refresh token: run `python3 copilot_mcp.py login` in content-engine first.');
  const store = requireSupabaseStore();
  await store.engineSaveCopilotAuth({
    client_id: s.client_id, access_token: s.access_token || null, refresh_token: s.refresh_token,
    expires_at: new Date((Number(s.expires_at) || 0) * 1000).toISOString(), owner: 'CJO', signed_in_by: `${os.userInfo().username} (laptop sign-in)`, updated_at: new Date().toISOString(),
  });
  // Prove the engine can use it before retiring the local copy.
  await C.call(store, 'get_reference_data', { type: 'social-platforms' });
  fs.renameSync(file, file + '.moved-to-engine');
  console.log('Moved: the engine now holds the Copilot sign-in and it works. The laptop copy is retired (copilot.json.moved-to-engine).');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
