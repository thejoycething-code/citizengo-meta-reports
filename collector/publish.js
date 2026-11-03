#!/usr/bin/env node
'use strict';
// Content Engine publisher (slice 2, Nov 2026). Runs on the Mini every few
// minutes: publishes each scheduled post's Facebook and Instagram destinations
// once their time comes, with the Page token of the person who approved it.
// Rules in lib/publish.js.
//
//   node collector/publish.js            # dry run unless ENGINE_PUBLISH_LIVE=1
//   node collector/publish.js --dry-run  # always a dry run
//
// Needs SUPABASE_URL, SUPABASE_SERVICE_KEY and ENGINE_TOKEN_PRIVATE_KEY (the
// key that opens sealed Page tokens; only on the Mini, scripts/engine-keygen.js). A dry run reads everything and changes
// nothing: it prints what it would publish, and why anything is held back.

const { loadEnv } = require('../lib/graph');
const { supabaseStore } = require('../lib/store');
const xauth = require('../lib/xauth');
const E = require('../lib/engine');
const P = require('../lib/publish');

async function patchDoc(store, id, change, extra = () => ({})) {
  for (let i = 0; i < 3; i++) {
    const cur = await store.enginePost(id);
    if (!cur) return null;
    const doc = E.mergeDoc(cur.doc, change(cur));
    const saved = await store.engineUpdatePost(id, cur.version, { doc, post_at: E.postAt(doc), updated_by: 'publisher', ...extra(cur) });
    if (saved) return saved;
  }
  throw new Error(`post ${id} kept changing; try again next run`);
}

// Claim one destination for this run. Only one run can win: the write is
// checked against the post's version, and a fresh claim by another run, or a
// destination already out, means hands off.
async function claimSlot(store, id, slot, at, runner, now) {
  for (let i = 0; i < 3; i++) {
    const cur = await store.enginePost(id);
    if (!cur || cur.status !== 'scheduled') return false;
    const d = cur.doc || {};
    if (d.published && d.published[slot]) return false;
    const c = d.publishing && d.publishing[slot];
    if (c && now - Date.parse(c.at) < P.CLAIM_MS) return false;
    const doc = E.mergeDoc(d, { publishing: { [slot]: { at, by: runner } } });
    if (await store.engineUpdatePost(id, cur.version, { doc, post_at: E.postAt(doc), updated_by: 'publisher' })) return true;
  }
  return false;
}

// runner: 'mini' (every 5 minutes) or 'cloud' (the Vercel backup, every 15).
// minLateMs: leave anything due more recently than this to the other runner,
// so the backup only steps in when the Mini hasn't.
async function run({ store, privateKey, live, now = Date.now(), log = console.log, fetchImpl, wait, runner = 'mini', minLateMs = 0 }) {
  const [teams, posts, pauses] = await Promise.all([store.engineTeams(), store.enginePosts({ statuses: ['scheduled'], limit: 500 }), store.enginePauses()]);
  const items = P.plan(posts, teams, now, pauses);
  const tally = { published: 0, held: 0, failed: 0, would: 0 };
  const stamp = () => new Date(now).toISOString();
  const event = (item, action, detail) => store.engineEvent({ post_id: item.post.id, team_id: item.post.team_id, who: 'publisher', action, detail: { account: item.slot, ...detail } });
  const fail = async (item, message, { final = false } = {}) => {
    tally.failed++;
    log(`  ✗ ${item.post.id} → ${item.slot}: ${message}`);
    if (!live) return;
    await patchDoc(store, item.post.id, (cur) => {
      const prev = ((cur.doc.publishErrors || {})[item.slot]) || {};
      return { publishing: { [item.slot]: null }, publishErrors: { [item.slot]: { at: stamp(), message, tries: final ? P.MAX_TRIES : (prev.tries || 0) + 1 } } };
    });
    await event(item, 'publish_failed', { message });
  };

  for (const item of items) {
    if (minLateMs && now - Date.parse(item.at) < minLateMs) continue;
    const label = `${item.post.id} → ${item.slot}`;
    if (item.action === 'paused') { tally.held++; log(`  ‖ ${label}: paused by ${item.pause.paused_by} (${item.pause.reason})`); continue; }
    if (item.action === 'busy' || item.action === 'gave_up') { tally.held++; log(`  … ${label}: ${item.action === 'busy' ? 'being published by another run' : 'stopped after 3 tries; waiting for a person'}`); continue; }
    if (item.action === 'unsure') { await fail(item, 'Publishing started over 15 minutes ago with no answer. Check the Page before trying again: it may already be up.', { final: true }); continue; }
    if (item.action === 'late') { await fail(item, 'Missed its time by more than 6 hours. Pick a new time on the desk.', { final: true }); continue; }

    const who = item.approver;
    if (!who) { await fail(item, 'Nobody is recorded as approving it.', { final: true }); continue; }
    const rights = (await store.engineRights({ who, kind: 'post' })).map((r) => r.account_key);
    if (!rights.includes(item.key)) { await fail(item, `${who} can no longer post to ${item.key}. Someone who can should approve it again.`, { final: true }); continue; }
    const tok = await store.enginePageToken({ who, account_key: item.key });
    if (!tok) { await fail(item, `${who} hasn't connected Facebook for ${item.key}, so there is nothing to publish with. Connect Facebook on the desk, then approve again.`, { final: true }); continue; }
    const content = P.contentFor(item.post.doc, item.platform, item.kind);
    if (!content.ok) { await fail(item, content.error, { final: true }); continue; }

    if (!live) { tally.would++; log(`  → ${label}: would publish as ${who} (${content.story ? `Story, ${content.media.length} frame${content.media.length === 1 ? '' : 's'}` : content.video ? `video, ${Math.round(content.video.size / 1048576)} MB` : `${content.media.length} image${content.media.length === 1 ? '' : 's'}`}${content.comment ? ', first comment' : ''}${(content.collaborators || []).length ? `, collab with ${content.collaborators.map((h) => '@' + h).join(' ')}` : ''})`); continue; }

    // Claim it, so a second run (the other runner) can't publish it too.
    if (!(await claimSlot(store, item.post.id, item.slot, stamp(), runner, now))) { tally.held++; log(`  … ${label}: taken by another run`); continue; }
    try {
      const token = xauth.open(privateKey, tok.sealed);
      let out;
      if (content.story) {
        const urls = [];
        for (const m of content.media) { const u = await store.engineMediaUrl(m, 3600); if (!u) throw new Error(`Story frame ${m} could not be found`); urls.push(u); }
        out = item.platform === 'facebook'
          ? await P.publishFacebookStory({ pageId: tok.page_id, token, urls, fetchImpl })
          : await P.publishInstagramStory({ igId: tok.ig_id, token, urls, fetchImpl });
      } else if (content.video) {
        const buffer = await P.assembleVideo(store, content.video);
        out = item.platform === 'facebook'
          ? await P.publishFacebookVideo({ pageId: tok.page_id, token, text: content.text, comment: content.comment, buffer, mime: content.video.mime, fetchImpl })
          : await P.publishInstagramReel({ igId: tok.ig_id, token, text: content.text, comment: content.comment, buffer, collaborators: content.collaborators, coverUrl: content.cover ? await store.engineMediaUrl(content.cover, 3600) : null, fetchImpl, wait });
      } else {
        const urls = [];
        for (const m of content.media) { const u = await store.engineMediaUrl(m, 3600); if (!u) throw new Error(`image ${m} could not be found`); urls.push(u); }
        out = item.platform === 'facebook'
          ? await P.publishFacebook({ pageId: tok.page_id, token, text: content.text, comment: content.comment, urls, fetchImpl })
          : await P.publishInstagram({ igId: tok.ig_id, token, text: content.text, comment: content.comment, urls, collaborators: content.collaborators, fetchImpl });
      }
      await patchDoc(store, item.post.id, () => ({ publishing: { [item.slot]: null }, publishErrors: { [item.slot]: null }, published: { [item.slot]: { ...out, at: stamp(), by: who } } }));
      await event(item, 'published', { id: out.id, url: out.url, via: runner });
      tally.published++;
      log(`  ✓ ${label}: ${out.url || out.id}`);
    } catch (e) {
      await fail(item, e.partial ? e.message : `Facebook refused it: ${e.message}`, { final: !!e.partial });
    }
  }

  // Posted once every Facebook and Instagram destination is out, unless
  // something is still to be posted by hand on X.
  if (live) {
    for (const id of [...new Set(items.map((i) => i.post.id))]) {
      const cur = await store.enginePost(id);
      if (!cur || cur.status !== 'scheduled') continue;
      const { done, handOnly } = P.allOut(cur, teams);
      if (done && !(cur.doc.videoPieces && cur.doc.videoPieces.clearedAt) && ['facebook', 'instagram'].some((p) => cur.doc.final && cur.doc.final[p] && cur.doc.final[p].video)) {
        try {
          const n = await P.clearVideoPieces(store, cur);
          await patchDoc(store, id, () => ({ videoPieces: { clearedAt: stamp(), removed: n } }));
          log(`  · ${id}: video is out, ${n} stored piece${n === 1 ? '' : 's'} removed`);
        } catch (e) { log(`  ! ${id}: couldn't remove the video pieces (${e.message}); they stay in storage under ${cur.team_id}/${id}`); }
      }
      if (!done || handOnly) continue;
      await patchDoc(store, id, () => ({ posted: { at: stamp(), by: 'publisher', linksPending: true } }), () => ({ status: 'posted' }));
      await store.engineEvent({ post_id: id, team_id: cur.team_id, who: 'publisher', action: 'posted', detail: {} });
      log(`  ✓ ${id}: everything is out, marked Posted`);
    }
  }
  // Heartbeat: when each runner last checked, for the desk's warning.
  try { await store.engineCacheSet(`publisher:${runner}`, { at: stamp(), live: !!live, tally }); } catch (e) { log(`  ! heartbeat not saved (${e.message})`); }
  return tally;
}

if (require.main === module) {
  loadEnv();
  const live = process.env.ENGINE_PUBLISH_LIVE === '1' && !process.argv.includes('--dry-run');
  const privateKey = String(process.env.ENGINE_TOKEN_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!privateKey) { console.error('ENGINE_TOKEN_PRIVATE_KEY is not set: cannot open sealed Page tokens (scripts/engine-keygen.js).'); process.exit(1); }
  const store = supabaseStore({ url: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_KEY });
  console.log(`Content Engine publisher, ${live ? 'LIVE' : 'dry run'}, ${new Date().toISOString()}`);
  run({ store, privateKey, live }).then((t) => console.log(JSON.stringify(t))).catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { run };
