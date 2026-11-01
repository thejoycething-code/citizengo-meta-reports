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
const E = require('../lib/engine');

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

// The team's auto-hide list, on each new comment once: a match queues a hide
// (never a delete) as the person who made the rule, labelled auto-hidden, for
// the action worker to send. Anyone can unhide it from the desk.
async function autoHide({ store, team, live, now, log }) {
  const rules = await store.engineInboxRules({ team_ids: [team] });
  const fresh = await store.engineInboxUnchecked({ team_ids: [team], since: new Date(now - 2 * 24 * 3600_000).toISOString() });
  let hidden = 0;
  for (const item of fresh) {
    const m = rules.length ? I.matchRules(item.text, rules) : null;
    if (m && !item.hidden) {
      hidden++;
      log(`  ‖ ${item.id}: ${live ? 'hiding' : 'would hide'} (${m.why})`);
      if (live) {
        await store.engineInboxInsertAction({ item_id: item.id, team_id: item.team_id, account_key: item.account_key, action: 'hide', by: m.rule.created_by, detail: { auto: true, rule_id: m.rule.id, why: m.why }, run_after: new Date(now).toISOString(), status: 'queued' });
        await store.engineInboxUpdate(item.id, { labels: [...new Set([...(item.labels || []), 'auto-hidden'])], auto_checked_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(), updated_by: 'auto-hide' });
        continue;
      }
    }
    if (live) await store.engineInboxUpdate(item.id, { auto_checked_at: new Date(now).toISOString() });
  }
  return hidden;
}

// Comment-to-DM: each new top-level Facebook or Instagram comment checked once
// against the team's active automations (the most specific wins: this post,
// then its post type, then every post), plus the "SIGN" set on the draft
// itself. A match queues a private reply (and the public reply, taking turns)
// as the rule's maker, for the action worker to send; someone who already got
// this rule's message just gets a like. Paused accounts are left unchecked
// until they resume.
async function automations({ store, team, live, now, log }) {
  const autos = (await store.engineAutomations({ team_ids: [team] })).filter((a) => a.active);
  const fresh = await store.engineInboxAutomationUnchecked({ team_ids: [team], since: new Date(now - 2 * 24 * 3600_000).toISOString() });
  if (!fresh.length) return 0;
  const held = E.pausedKeys(await store.enginePauses(), now);
  // The engine's own posts, by the id Facebook or Instagram gave them.
  const byThread = {};
  for (const p of await store.enginePosts({ team_ids: [team], statuses: ['scheduled', 'posted'], limit: 500 })) {
    for (const [slot, pub] of Object.entries((p.doc && p.doc.published) || {})) if (pub && pub.id) byThread[pub.id] = { post: p, by: pub.by, slot };
  }
  const today = new Date(now).toISOString().slice(0, 10);
  const sentToday = {}, replies = {}, gotIt = {};
  for (const a of await store.engineInboxActions({ team_ids: [team], limit: 1000 })) {
    const id = a.detail && a.detail.automation_id;
    if (!id || a.status === 'cancelled') continue;
    if (a.action === 'private_reply') {
      if (String(a.created_at).slice(0, 10) === today) sentToday[id] = (sentToday[id] || 0) + 1;
      if (a.detail.author_id) (gotIt[id] = gotIt[id] || new Set()).add(a.detail.author_id);
    }
    if (a.action === 'reply') replies[id] = (replies[id] || 0) + 1;
  }
  let n = 0;
  const at = new Date(now).toISOString();
  for (const item of fresh) {
    if (held['*'] || held[item.account_key]) continue;
    const own = byThread[item.thread_id];
    const sign = own && E.draftCommentDm(own.post.doc);
    const fromDraft = sign && own.by ? [{ id: `post:${own.post.id}`, name: `${sign.keyword} on "${own.post.title || own.post.id}"`, active: true, thread_id: item.thread_id, keywords: [sign.keyword], dm_text: sign.dm, platforms: ['facebook', 'instagram'], skip_repeat: true, created_by: own.by }] : [];
    const a = I.automationFor(item, [...fromDraft, ...autos], { postType: own ? E.postType(own.post.doc) : null });
    if (a && (sentToday[a.id] || 0) < I.AUTOMATION_DAILY_MAX) {
      const repeat = a.skip_repeat !== false && item.author_id && gotIt[a.id] && gotIt[a.id].has(item.author_id);
      n++;
      log(`  ✉ ${item.id}: ${live ? 'queued' : 'would queue'} "${a.name}"${repeat ? ' (already has the link: like only)' : ''}`);
      if (live) {
        const base = { item_id: item.id, team_id: item.team_id, account_key: item.account_key, by: a.created_by, run_after: at, status: 'queued', detail: { automation_id: a.id, automation: a.name, author_id: item.author_id || null } };
        if (repeat) {
          if (item.platform === 'facebook') await store.engineInboxInsertAction({ ...base, action: 'like', detail: { ...base.detail, step: 'react' } });
        } else {
          sentToday[a.id] = (sentToday[a.id] || 0) + 1;
          (gotIt[a.id] = gotIt[a.id] || new Set()).add(item.author_id);
          await store.engineInboxInsertAction({ ...base, action: 'private_reply', text: a.dm_text, detail: { ...base.detail, step: 'dm' } });
          const reply = I.automationReply(a, replies[a.id] || 0);
          if (reply) { replies[a.id] = (replies[a.id] || 0) + 1; await store.engineInboxInsertAction({ ...base, action: 'reply', text: reply, detail: { ...base.detail, step: 'reply' } }); }
        }
        const fields = { automation_checked_at: at };
        if (a.tag) fields.labels = [...new Set([...(item.labels || []), a.tag])];
        if (a.hand_to && !item.assigned_to) fields.assigned_to = a.hand_to;
        await store.engineInboxUpdate(item.id, fields);
        continue;
      }
    }
    if (live) await store.engineInboxUpdate(item.id, { automation_checked_at: at });
  }
  return n;
}

// Pile-on alerts: at most one per post every 6 hours.
async function pileOnAlerts({ store, team, live, now, log }) {
  const [rows, rules, recent] = await Promise.all([
    store.engineInbox({ team_ids: [team], kind: 'comment', since: new Date(now - 7 * 24 * 3600_000).toISOString(), limit: 1000 }),
    store.engineInboxRules({ team_ids: [team] }),
    store.engineInboxAlerts({ team_ids: [team], since: new Date(now - I.PILE_QUIET_MS).toISOString() }),
  ]);
  const quiet = new Set(recent.map((a) => a.thread_id));
  let n = 0;
  for (const a of I.pileOns(rows, rules, now)) {
    if (quiet.has(a.thread_id)) continue;
    n++;
    log(`  ! pile-on on ${a.account_key} ${a.thread_id}: ${a.comments_hour} comments in an hour, ${a.hostile_hour} hostile (usual ${a.baseline})`);
    if (live) await store.engineInsertInboxAlert({ ...a, at: new Date(now).toISOString() });
  }
  return n;
}

// Posts by others that tag the Page (Facebook) or the account (Instagram).
async function readMentions({ team, account, tok, token, since, fetchImpl }) {
  const ig = account.platform === 'instagram';
  const data = ig
    ? (await I.call('GET', `${tok.ig_id}/tags`, { fields: 'id,caption,username,timestamp,permalink', limit: '25' }, token, fetchImpl)).data || []
    : (await I.call('GET', `${tok.page_id}/tagged`, { fields: 'id,message,from{id,name},created_time,permalink_url', limit: '25' }, token, fetchImpl)).data || [];
  return data.filter((m) => Date.parse(ig ? m.timestamp : m.created_time) >= since).map((m) => I.mention(m, { team, account }));
}

async function run({ store, privateKey, live, now = Date.now(), log = console.log, fetchImpl }) {
  const [teams, tokens] = await Promise.all([store.engineTeams(), store.engineConnectedTokens()]);
  const readers = readerTokens(tokens);
  const since = now - WINDOW_DAYS * 24 * 3600_000;
  const tally = { accounts: 0, comments: 0, messages: 0, mentions: 0, skipped: 0, failed: 0, auto_hidden: 0, automations: 0, pile_ons: 0 };
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
        ['mentions', () => readMentions({ team: t.id, account, tok, token, since, fetchImpl })],
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
  for (const t of teams) {
    try { tally.auto_hidden += await autoHide({ store, team: t.id, live, now, log }); } catch (e) { tally.failed++; log(`  ✗ auto-hide ${t.id}: ${e.message}`); }
    try { tally.automations += await automations({ store, team: t.id, live, now, log }); } catch (e) { tally.failed++; log(`  ✗ automations ${t.id}: ${e.message}`); }
    try { tally.pile_ons += await pileOnAlerts({ store, team: t.id, live, now, log }); } catch (e) { tally.failed++; log(`  ✗ pile-on check ${t.id}: ${e.message}`); }
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
