#!/usr/bin/env node
'use strict';
// Content Engine Inbox actions (slice 3, Nov 2026). Runs on the Mini every
// minute: sends each queued reply, private reply, like, hide, unhide or
// delete whose 10-second undo window has passed, with the Page token of the
// person who did it, and records the result as moderation history.
//
//   node collector/inbox-actions.js            # dry run unless ENGINE_INBOX_LIVE=1
//   node collector/inbox-actions.js --dry-run  # always a dry run
//
// A dry run sends nothing and leaves every action queued.

const { loadEnv } = require('../lib/graph');
const { supabaseStore } = require('../lib/store');
const xauth = require('../lib/xauth');
const I = require('../lib/inbox');

const STUCK_MS = 10 * 60_000;

async function run({ store, privateKey, live, now = Date.now(), log = console.log, fetchImpl }) {
  const at = () => new Date(now).toISOString();
  const tally = { sent: 0, failed: 0, would: 0, stuck: 0 };
  // A run that died mid-send: don't guess whether it reached Meta.
  for (const a of await store.engineInboxActions({ statuses: ['running'], limit: 200 })) {
    if (now - Date.parse(a.run_after) < STUCK_MS) continue;
    if (live && await store.engineInboxUpdateAction(a.id, 'running', { status: 'failed', result: { error: 'Stopped mid-send: check on Facebook or Instagram whether it went, then do it again if not.' }, done_at: at() })) tally.stuck++;
  }
  const due = (await store.engineInboxActions({ statuses: ['queued'], due_before: at(), limit: 100 })).filter((a) => I.META_ACTIONS.includes(a.action));
  for (const a of due) {
    const label = `${a.action} ${a.item_id} by ${a.by}`;
    const fail = async (message) => {
      tally.failed++; log(`  ✗ ${label}: ${message}`);
      if (live) await store.engineInboxUpdateAction(a.id, 'running', { status: 'failed', result: { error: message }, done_at: at() });
    };
    if (!live) { tally.would++; log(`  → ${label}: would send`); continue; }
    if (!await store.engineInboxUpdateAction(a.id, 'queued', { status: 'running' })) continue; // undone, or another run took it
    const item = await store.engineInboxItem(a.item_id);
    if (!item) { await fail('The comment or message is no longer in the inbox.'); continue; }
    const rights = (await store.engineRights({ who: a.by, kind: ['reply', 'private_reply'].includes(a.action) ? 'reply' : 'moderate' })).map((r) => r.account_key);
    if (!rights.includes(a.account_key)) { await fail(`${a.by} can no longer act for ${a.account_key}.`); continue; }
    const tok = await store.enginePageToken({ who: a.by, account_key: a.account_key });
    if (!tok) { await fail(`${a.by} hasn't connected Facebook for ${a.account_key}.`); continue; }
    try {
      const token = xauth.open(privateKey, tok.sealed);
      const result = await I.perform({ action: a.action, item, account: { key: a.account_key, platform: item.platform, page_id: tok.page_id, ig_id: tok.ig_id }, token, text: a.text, recipient: a.detail && a.detail.recipient, fetchImpl });
      await store.engineInboxUpdateAction(a.id, 'running', { status: 'done', result, done_at: at() });
      const change = I.afterAction(a.action, at());
      if (Object.keys(change).length) await store.engineInboxUpdate(item.id, { ...change, updated_at: at(), updated_by: a.by });
      tally.sent++; log(`  ✓ ${label}`);
    } catch (e) {
      await fail(`Meta refused it: ${e.message}`);
    }
  }
  return tally;
}

if (require.main === module) {
  loadEnv();
  const live = process.env.ENGINE_INBOX_LIVE === '1' && !process.argv.includes('--dry-run');
  const privateKey = String(process.env.ENGINE_TOKEN_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!privateKey) { console.error('ENGINE_TOKEN_PRIVATE_KEY is not set: cannot open sealed Page tokens (scripts/engine-keygen.js).'); process.exit(1); }
  const store = supabaseStore({ url: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_KEY });
  console.log(`Content Engine inbox actions, ${live ? 'LIVE' : 'dry run'}, ${new Date().toISOString()}`);
  run({ store, privateKey, live }).then((t) => console.log(JSON.stringify(t))).catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { run };
