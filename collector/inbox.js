#!/usr/bin/env node
'use strict';
// Content Engine Inbox collector (slice 3, Nov 2026). Runs on the Mini every
// few minutes: reads the comments on each team account's posts from the last
// 7 days (Facebook posts and ads, Instagram media) and its Messenger or
// Instagram DMs, with a sealed Page token from Connect Facebook, into
// engine_inbox. Read-only on Meta. Rules in lib/inbox.js.
//
//   node collector/inbox.js            # reads and saves
//   node collector/inbox.js --dry-run  # reads and counts, saves nothing
//
// Needs SUPABASE_URL, SUPABASE_SERVICE_KEY and ENGINE_TOKEN_PRIVATE_KEY.

const { loadEnv } = require('../lib/graph');
const { supabaseStore } = require('../lib/store');
const xauth = require('../lib/xauth');
const I = require('../lib/inbox');

const WINDOW_DAYS = 7;

// The token to read an account with: the most recently connected person's.
function readerTokens(tokens) {
  const best = {};
  for (const t of tokens || []) if (!best[t.account_key] || String(t.connected_at) > String(best[t.account_key].connected_at)) best[t.account_key] = t;
  return best;
}

async function readFacebook({ team, account, tok, token, since, fetchImpl }) {
  const rows = [];
  const fields = 'id,message,created_time,permalink_url';
  const posts = (await I.call('GET', `${tok.page_id}/posts`, { fields, since: String(Math.floor(since / 1000)), limit: '50' }, token, fetchImpl)).data || [];
  let ads = [];
  try { ads = ((await I.call('GET', `${tok.page_id}/ads_posts`, { fields, since: String(Math.floor(since / 1000)), limit: '50', include_inline_create: 'true' }, token, fetchImpl)).data || []).map((p) => ({ ...p, is_ad: true })); } catch (e) { /* ads need ads_read on some Pages; posts still come in */ }
  const seen = new Set();
  for (const post of posts.concat(ads)) {
    if (seen.has(post.id)) continue; seen.add(post.id);
    const comments = (await I.call('GET', `${post.id}/comments`, { fields: 'id,message,from{id,name},created_time,parent{id},is_hidden', filter: 'stream', order: 'reverse_chronological', limit: '100' }, token, fetchImpl)).data || [];
    for (const c of comments) rows.push(I.fbComment(c, { team, account, post }));
  }
  return rows;
}

async function readInstagram({ team, account, tok, token, since, fetchImpl }) {
  const rows = [];
  const media = ((await I.call('GET', `${tok.ig_id}/media`, { fields: 'id,caption,timestamp,permalink', limit: '50' }, token, fetchImpl)).data || []).filter((m) => Date.parse(m.timestamp) >= since);
  const f = 'id,text,username,timestamp,hidden,from{id,username}';
  for (const m of media) {
    const comments = (await I.call('GET', `${m.id}/comments`, { fields: `${f},replies{${f}}`, limit: '100' }, token, fetchImpl)).data || [];
    for (const c of comments) {
      rows.push(I.igComment(c, { team, account, media: m }));
      for (const r of (c.replies && c.replies.data) || []) rows.push(I.igComment(r, { team, account, media: m, parentId: c.id }));
    }
  }
  return rows;
}

async function readMessages({ team, account, tok, token, fetchImpl }) {
  const params = { fields: 'id,updated_time,messages.limit(10){id,message,from,created_time}', limit: '25' };
  if (account.platform === 'instagram') params.platform = 'instagram';
  const convs = (await I.call('GET', `${tok.page_id}/conversations`, params, token, fetchImpl)).data || [];
  const rows = [];
  for (const conversation of convs) for (const m of (conversation.messages && conversation.messages.data) || []) rows.push(I.dmMessage(m, { team, account: { ...account, page_id: tok.page_id, ig_id: tok.ig_id }, conversation }));
  return rows;
}

async function run({ store, privateKey, live, now = Date.now(), log = console.log, fetchImpl }) {
  const [teams, tokens] = await Promise.all([store.engineTeams(), store.engineConnectedTokens()]);
  const readers = readerTokens(tokens);
  const since = now - WINDOW_DAYS * 24 * 3600_000;
  const tally = { accounts: 0, comments: 0, messages: 0, skipped: 0, failed: 0 };
  for (const t of teams) {
    for (const acc of t.accounts || []) {
      if (!['facebook', 'instagram'].includes(acc.platform)) continue;
      const tok = readers[acc.key];
      if (!tok) { tally.skipped++; continue; }
      const account = { key: acc.key, platform: acc.platform, page_id: tok.page_id, ig_id: tok.ig_id };
      let token;
      try { token = xauth.open(privateKey, tok.sealed); } catch (e) { tally.failed++; log(`  ✗ ${acc.key}: the sealed token couldn't be opened with this key`); continue; }
      const parts = [
        ['comments', () => (acc.platform === 'facebook' ? readFacebook : readInstagram)({ team: t.id, account, tok, token, since, fetchImpl })],
        ['messages', () => readMessages({ team: t.id, account, tok, token, fetchImpl })],
      ];
      tally.accounts++;
      for (const [what, read] of parts) {
        try {
          const rows = await read();
          tally[what] += rows.length;
          if (live) {
            // Our own comments and messages arrive already done; everyone
            // else's keep whatever status people gave them.
            await store.engineInboxUpsert(rows.filter((r) => !r.from_us));
            await store.engineInboxUpsert(rows.filter((r) => r.from_us).map((r) => ({ ...r, status: 'done' })));
          }
        } catch (e) {
          tally.failed++;
          log(`  ✗ ${acc.key} ${what}: ${e.message}`);
        }
      }
    }
  }
  return tally;
}

if (require.main === module) {
  loadEnv();
  const live = !process.argv.includes('--dry-run');
  const privateKey = String(process.env.ENGINE_TOKEN_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!privateKey) { console.error('ENGINE_TOKEN_PRIVATE_KEY is not set: cannot open sealed Page tokens (scripts/engine-keygen.js).'); process.exit(1); }
  const store = supabaseStore({ url: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_KEY });
  console.log(`Content Engine inbox, ${live ? 'live' : 'dry run'}, ${new Date().toISOString()}`);
  run({ store, privateKey, live }).then((t) => console.log(JSON.stringify(t))).catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { run, readerTokens };
