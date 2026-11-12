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
// key that opens sealed Page tokens; only on the Mini, scripts/engine-keygen.js).
// ASANA_TOKEN (Mini only, allowed by Chris 8 Nov 2026): in hand-off mode each
// handed-off post becomes an Asana task, kept in step, and closing the task
// marks the post posted (lib/asana.js). A dry run reads everything and changes
// nothing: it prints what it would publish, and why anything is held back.

const { loadEnv } = require('../lib/graph');
const { supabaseStore } = require('../lib/store');
const xauth = require('../lib/xauth');
const E = require('../lib/engine');
const P = require('../lib/publish');
const A = require('../lib/asana');
const H = require('../lib/handoff');

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

// Published Facebook videos whose first comment is waiting (comment_pending).
// Each is claimed before the comment goes up, so two runs can't both add it.
async function videoComments({ store, privateKey, now, log, fetchImpl, runner }) {
  const stamp = new Date(now).toISOString();
  const posts = await store.enginePosts({ statuses: ['scheduled', 'posted'], limit: 200 });
  for (const post of posts) {
    for (const [slot, r] of Object.entries((post.doc && post.doc.published) || {})) {
      if (!r || !r.comment_pending) continue;
      const platform = (post.doc.final && post.doc.final.facebook) ? 'facebook' : null;
      const comment = platform && post.doc.final.facebook.comment;
      const label = `${post.id} → ${slot} first comment`;
      const give = async (message) => { await patchDoc(store, post.id, () => ({ published: { [slot]: { comment_pending: null, comment_claim: null, comment_error: message } } })); log(`  ✗ ${label}: ${message}`); };
      if (!comment) { await give('No first comment in the snapshot.'); continue; }
      if (now - Date.parse(r.at) > P.COMMENT_WAIT_MS) { await give("Facebook was still processing the video after 2 hours, so the first comment wasn't added. Add it by hand."); continue; }
      if (r.comment_claim && now - Date.parse(r.comment_claim.at) < P.CLAIM_MS) continue;
      if (r.comment_claim) { await give('Adding the first comment got no answer. Check the video before adding it by hand: it may already be there.'); continue; }
      const tok = await store.enginePageToken({ who: r.by, account_key: slot });
      if (!tok) { await give(`${r.by}'s Facebook connection is gone, so the first comment wasn't added. Add it by hand.`); continue; }
      const claimed = await patchDoc(store, post.id, (cur) => {
        const c = ((cur.doc.published || {})[slot]) || {};
        return c.comment_pending && !(c.comment_claim && now - Date.parse(c.comment_claim.at) < P.CLAIM_MS) ? { published: { [slot]: { comment_claim: { at: stamp, by: runner } } } } : {};
      });
      const mine = claimed && (((claimed.doc.published || {})[slot] || {}).comment_claim || {}).at === stamp;
      if (!mine) continue;
      let out;
      try { out = await P.videoComment({ videoId: r.id, token: xauth.open(privateKey, tok.sealed), comment, fetchImpl }); }
      catch (e) { out = { done: false, error: e.message }; }
      if (!out.done) {
        await patchDoc(store, post.id, () => ({ published: { [slot]: { comment_claim: null } } }));
        log(`  … ${label}: ${out.error ? `couldn't check the video (${out.error})` : 'Facebook is still processing the video'}`);
        continue;
      }
      const { done, ...fields } = out;
      await patchDoc(store, post.id, () => ({ published: { [slot]: { comment_pending: null, comment_claim: null, ...fields } } }));
      log(fields.comment_id ? `  ✓ ${label}: added` : `  ✗ ${label}: ${fields.comment_error}`);
    }
  }
}

// Hand-off mode: Asana tasks for handed-off posts (lib/asana.js).
async function asanaPass({ store, live, now, log, token, fetchImpl, tally }) {
  const posts = await store.enginePosts({ statuses: ['scheduled', 'hold', 'changes', 'review', 'rejected'], limit: 500 });
  const stamp = new Date(now).toISOString();
  const api = A.client(token, fetchImpl);
  const handoffOn = H.on();
  for (const post of posts) {
    const step = A.stepFor(post, { handoffOn });
    if (!step) continue;
    const p = post.doc.posting || {};
    const err = p.asanaError || {};
    const label = `${post.id} → Asana`;
    try {
      if (step === 'create') {
        if ((err.tries || 0) >= A.MAX_TRIES) continue;
        if (p.asanaPending && now - Date.parse(p.asanaPending.at) < A.CLAIM_MS) continue;
        if (p.asanaPending) {
          log(`  ✗ ${label}: started over 15 minutes ago with no answer; check the calendars before trying again`);
          if (live) await patchDoc(store, post.id, () => ({ posting: { asanaPending: null, asanaError: { at: stamp, message: 'Making the Asana task got no answer. Check the posting calendars: it may already be there.', tries: A.MAX_TRIES } } }));
          continue;
        }
        const task = A.taskFor(post);
        if (!live) { tally.would++; log(`  → ${label}: would add "${task.name}" to ${task.calendars.map((c) => c.short).join(', ')}`); continue; }
        const claimed = await patchDoc(store, post.id, (cur) => {
          const cp = (cur.doc && cur.doc.posting) || {};
          return cp.asanaTaskGid || (cp.asanaPending && now - Date.parse(cp.asanaPending.at) < A.CLAIM_MS) ? {} : { posting: { asanaPending: { at: stamp } } };
        });
        if (!claimed || !(claimed.doc.posting.asanaPending && claimed.doc.posting.asanaPending.at === stamp)) continue;
        let out;
        try { out = await A.createTask(api, task); }
        catch (e) {
          if (e.task) {
            await patchDoc(store, post.id, () => ({ posting: { asanaPending: null, asanaTaskGid: e.task.gid, asanaUrl: e.task.url, syncedAt: stamp, asanaError: { at: stamp, message: `The task was made but not finished (${e.message}). Check its calendars and fields.`, tries: A.MAX_TRIES } } }));
            log(`  ✗ ${label}: task ${e.task.gid} made, but ${e.message}`);
            continue;
          }
          await patchDoc(store, post.id, () => ({ posting: { asanaPending: null, asanaError: { at: stamp, message: e.message, tries: (err.tries || 0) + 1 } } }));
          log(`  ✗ ${label}: ${e.message}`);
          continue;
        }
        const attached = await attachMedia({ store, api, gid: out.gid, post: claimed, done: [], log, label });
        await patchDoc(store, post.id, () => ({ posting: { asanaPending: null, asanaError: null, asanaTaskGid: out.gid, asanaUrl: out.url, syncedAt: stamp, asanaSig: A.sigOf(claimed), asanaMedia: attached, asanaStage: task.stage } }));
        await store.engineEvent({ post_id: post.id, team_id: post.team_id, who: 'publisher', action: 'asana_task', detail: { gid: out.gid, calendars: task.calendars.map((c) => c.key) } });
        tally.handed = (tally.handed || 0) + 1;
        log(`  ✓ ${label}: ${out.url}`);
      } else if (step === 'update') {
        if (!live) { tally.would++; log(`  → ${label}: would update task ${p.asanaTaskGid}`); continue; }
        const task = A.taskFor(post);
        const stageChanged = (p.asanaStage || 'ready') !== task.stage;
        await A.updateTask(api, p.asanaTaskGid, task, { stageChanged });
        const attached = await attachMedia({ store, api, gid: p.asanaTaskGid, post, done: p.asanaMedia || [], log, label });
        await patchDoc(store, post.id, () => ({ posting: { syncedAt: stamp, asanaSig: A.sigOf(post), asanaMedia: attached, asanaStage: task.stage } }));
        log(`  ✓ ${label}: task updated${stageChanged ? ` (now ${task.stage === 'ready' ? 'Ready to Post' : 'In Progress'})` : ''}`);
      } else if (step === 'check') {
        const t = await A.readTask(api, p.asanaTaskGid);
        if (!t.completed) continue;
        const keys = E.destinations(post.doc);
        const urls = A.linksByKey(keys, t.links);
        const at = t.completed_at || stamp;
        if (!live) { tally.would++; log(`  → ${label}: task completed, would mark posted (${Object.keys(urls).length} link${Object.keys(urls).length === 1 ? '' : 's'})`); continue; }
        const published = {};
        for (const k of keys) if (!(post.doc.published || {})[k]) published[k] = { at, by: 'hand', byHand: true, note: 'Posted by hand from its Asana task', ...(urls[k] ? { url: urls[k] } : {}) };
        await patchDoc(store, post.id, () => ({ published, posted: { at, by: 'asana', linksPending: keys.some((k) => !urls[k]) }, posting: { asanaClosedAt: stamp } }), () => ({ status: 'posted' }));
        await store.engineEvent({ post_id: post.id, team_id: post.team_id, who: 'publisher', action: 'posted', detail: { via: 'asana', task: p.asanaTaskGid } });
        tally.closed = (tally.closed || 0) + 1;
        log(`  ✓ ${post.id}: Asana task completed, marked Posted`);
      } else if (step === 'cancel') {
        if (!live) { tally.would++; log(`  → ${label}: would cancel task ${p.asanaTaskGid} (now ${post.status})`); continue; }
        const t = await A.readTask(api, p.asanaTaskGid);
        if (!t.completed) await A.cancelTask(api, p.asanaTaskGid, A.keysOf(post.doc).map((k) => ({ key: k, ...A.CALENDARS[k] })), `Don't post this: it was ${post.status === 'rejected' ? 'moved to the Bin' : 'sent back to To review'} on the desk. If it comes back, a new task is made.`);
        await patchDoc(store, post.id, () => ({ posting: { asanaCancelledAt: stamp, asanaTaskGid: null, asanaUrl: null, asanaSig: null, asanaMedia: null, asanaStage: null, handoff: null, asanaOldTask: p.asanaTaskGid } }));
        log(`  ✓ ${label}: task ${p.asanaTaskGid} marked Cancelled (post is ${post.status})`);
      }
    } catch (e) {
      log(`  ✗ ${label}: ${e.message}`);
      if (live && step !== 'check') await patchDoc(store, post.id, () => ({ posting: { asanaError: { at: stamp, message: e.message, tries: (err.tries || 0) + 1 } } })).catch(() => {});
    }
  }
}

// Attaches the post's media to its task, each file once. Returns the keys done.
async function attachMedia({ store, api, gid, post, done, log, label }) {
  const out = [...done];
  for (const m of A.mediaOf(post)) {
    if (out.includes(m.key)) continue;
    try {
      if (m.video && m.size > A.ATTACH_MAX) { log(`  ! ${label}: video is ${Math.round(m.size / 1048576)} MB, over Asana's 100 MB: download it from the desk`); out.push(m.key); continue; }
      const buf = m.text != null ? Buffer.from(m.text, 'utf8') : m.video ? await P.assembleVideo(store, m.video) : await store.engineMediaDownload(m.path);
      if (!buf) { log(`  ! ${label}: ${m.name} not found in storage`); continue; }
      await api.attach(gid, m.name, buf, m.mime);
      out.push(m.key);
    } catch (e) { log(`  ! ${label}: couldn't attach ${m.name} (${e.message})`); }
  }
  return out;
}

// runner: 'mini' (every 5 minutes) or 'cloud' (the Vercel backup, every 15).
// minLateMs: leave anything due more recently than this to the other runner,
// so the backup only steps in when the Mini hasn't.
async function run({ store, privateKey, live, now = Date.now(), log = console.log, fetchImpl, wait, runner = 'mini', minLateMs = 0, asanaToken = null, asanaFetch }) {
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
  // Facebook videos: their first comment, once Facebook has processed them.
  if (live) {
    try { await videoComments({ store, privateKey, now, log, fetchImpl, runner }); }
    catch (e) { log(`  ! video comments: ${e.message}`); }
  }
  // Hand-off mode: the Asana tasks (Mini only, where the token is).
  if (asanaToken) {
    try { await asanaPass({ store, live, now, log, token: asanaToken, fetchImpl: asanaFetch || fetch, tally }); }
    catch (e) { log(`  ! Asana: ${e.message}`); }
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
  run({ store, privateKey, live, asanaToken: process.env.ASANA_TOKEN || null }).then((t) => console.log(JSON.stringify(t))).catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { run };
