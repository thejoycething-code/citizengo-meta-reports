'use strict';
// The Content Engine publisher (slice 2, Nov 2026): what is due, what exactly
// goes out, and the Graph calls. Used by collector/publish.js on the Mini,
// which holds the private key that opens each person's sealed Page token.
//
// Rules:
//   * Only SCHEDULED posts, only their Facebook and Instagram destinations
//     (X is posted by hand), only once the account's own time has come.
//   * What goes out is the post's `final` snapshot, written by the desk when it
//     was approved (and again on any edit while scheduled): the exact text with
//     its tracked link, the first comment, and the finished images. Never the
//     working draft.
//   * It is published with the Page token of the person who approved it, and
//     only while they still hold the publishing right.
//   * Never twice: each destination is claimed before the call; a claim older
//     than 15 minutes with no result is reported, not retried, because the post
//     may already be up.
//   * More than 6 hours late, or 3 failed tries: reported for a person to act.

const E = require('./engine');
const H = require('./handoff');

const VERSION = process.env.GRAPH_VERSION || 'v23.0';
const CLAIM_MS = 15 * 60_000;
const LATE_MS = 6 * 3600_000;
const MAX_TRIES = 3;

function platformOf(team, key) {
  const acc = ((team && team.accounts) || []).find((a) => a.key === key);
  if (acc) return acc.platform;
  return /-fb$/.test(key) ? 'facebook' : /-ig$/.test(key) ? 'instagram' : 'x';
}

function approverOf(doc) {
  const r = (doc && doc.review) || {};
  return r.action === 'approve' && r.by ? r.by : null;
}

// Every Meta destination of every scheduled post, with what to do about it.
// pauses: open engine_pauses rows. A paused account is held (action
// 'paused') before any other check, so a long pause never turns its posts
// into "missed their time" while it lasts.
// Instagram collabs: up to three other accounts invited as collaborators on a
// feed post, carousel or Reel (not Stories). Handles without the @.
const COLLAB_MAX = 3;
function collaboratorsOf(f) {
  const list = [...new Set([].concat((f && f.collaborators) || []).map((h) => String(h).trim().replace(/^@/, '').toLowerCase()).filter(Boolean))];
  const bad = list.filter((h) => !/^[a-z0-9._]{1,30}$/.test(h));
  if (bad.length) return { ok: false, error: `Not an Instagram handle: ${bad.join(', ')}.` };
  if (list.length > COLLAB_MAX) return { ok: false, error: 'Instagram allows at most 3 collaborators.' };
  return { ok: true, list };
}

// What a post publishes, per account: the post itself, and on Instagram its
// Story frames when they were asked for (posting.story) and are in the
// snapshot. slot keys published / publishing / publishErrors; key is the
// account, for rights and tokens.
function slotsOf(doc, team) {
  const out = [];
  const story = !!(doc.posting && doc.posting.story) && !!(doc.final && doc.final.story && (doc.final.story.media || []).length);
  for (const key of E.destinations(doc)) {
    const platform = platformOf(team, key);
    if (platform !== 'facebook' && platform !== 'instagram') continue;
    out.push({ key, slot: key, platform, kind: 'post' });
    if (story) out.push({ key, slot: `${key}:story`, platform, kind: 'story' });
  }
  return out;
}

function plan(posts, teams, now = Date.now(), pauses = [], { handoff = H.on() } = {}) {
  // Hand-off mode: people post from the Asana task, so nothing is due here.
  if (handoff) return [];
  const held = E.pausedKeys(pauses, now);
  const out = [];
  for (const post of posts || []) {
    if (post.status !== 'scheduled') continue;
    const team = (teams || []).find((t) => t.id === post.team_id);
    const doc = post.doc || {};
    const times = E.postTimes(doc);
    for (const { key, slot, platform, kind } of slotsOf(doc, team)) {
      if (doc.published && doc.published[slot]) continue;
      const at = times[key];
      if (!at || Date.parse(at) > now) continue;
      const claim = doc.publishing && doc.publishing[slot];
      const err = doc.publishErrors && doc.publishErrors[slot];
      let action = 'publish';
      const pause = E.pauseFor(held, key);
      if (pause) action = 'paused';
      else if (claim && now - Date.parse(claim.at) < CLAIM_MS) action = 'busy';
      else if (claim) action = 'unsure';
      else if (err && (err.tries || 0) >= MAX_TRIES) action = 'gave_up';
      else if (now - Date.parse(at) > LATE_MS) action = 'late';
      out.push({ post, key, slot, kind, platform, at, action, approver: approverOf(doc), pause: pause || null });
    }
  }
  return out;
}

// What goes out on one platform, from the approved snapshot.
function contentFor(doc, platform, kind = 'post') {
  if (kind === 'story') {
    const st = doc && doc.final && doc.final.story;
    const media = st && Array.isArray(st.media) ? st.media.filter(Boolean) : [];
    if (!media.length) return { ok: false, error: 'No Story frames in the snapshot: press "Update where and when" on the desk.' };
    if (media.length > 10) return { ok: false, error: 'More than 10 Story frames.' };
    return { ok: true, text: '', comment: '', media, story: true };
  }
  const f = doc && doc.final && doc.final[platform];
  if (!f) return { ok: false, error: 'Not ready to publish: open it on the desk and press "Update where and when" so the final text and images are saved.' };
  const media = Array.isArray(f.media) ? f.media.filter(Boolean) : [];
  const text = String(f.text || '');
  if (f.video) {
    const v = f.video;
    if (!(v && typeof v === 'object' && v.prefix && v.parts > 0 && v.size > 0 && /^[a-f0-9]{64}$/.test(String(v.sha256 || '')))) {
      return { ok: false, error: 'This is a video post with no video uploaded: open it on the desk and upload the video under "Video to publish".' };
    }
    if (platform === 'instagram' && text.length > 2200) return { ok: false, error: 'The Instagram caption is over 2,200 characters.' };
    const cv = platform === 'instagram' ? collaboratorsOf(f) : { ok: true, list: [] };
    if (!cv.ok) return cv;
    return { ok: true, text, comment: f.comment ? String(f.comment) : '', media: [], video: v, collaborators: cv.list, cover: platform === 'instagram' && f.cover ? String(f.cover) : null };
  }
  if (platform === 'instagram' && !media.length) return { ok: false, error: 'Instagram needs an image.' };
  if (media.length > 10) return { ok: false, error: 'More than 10 images: Facebook and Instagram allow 10.' };
  if (platform === 'instagram' && text.length > 2200) return { ok: false, error: 'The Instagram caption is over 2,200 characters.' };
  const c = platform === 'instagram' ? collaboratorsOf(f) : { ok: true, list: [] };
  if (!c.ok) return c;
  return { ok: true, text, comment: f.comment ? String(f.comment) : '', media, collaborators: c.list };
}

async function post(path, params, token, fetchImpl = fetch) {
  const body = new URLSearchParams({ ...params, access_token: token });
  const r = await fetchImpl(`https://graph.facebook.com/${VERSION}/${path}`, { method: 'POST', body });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || json.error) throw new Error((json.error && json.error.message) || `HTTP ${r.status}`);
  return json;
}
async function get(path, params, token, fetchImpl = fetch) {
  const r = await fetchImpl(`https://graph.facebook.com/${VERSION}/${path}?${new URLSearchParams({ ...params, access_token: token })}`);
  const json = await r.json().catch(() => ({}));
  if (!r.ok || json.error) throw new Error((json.error && json.error.message) || `HTTP ${r.status}`);
  return json;
}

// The post is already up by now, so a failed comment must never make the
// publisher try the whole post again: it is recorded for a person to add.
async function firstComment(objectId, comment, token, fetchImpl) {
  if (!comment) return { comment_id: null };
  try { return { comment_id: (await post(`${objectId}/comments`, { message: comment }, token, fetchImpl)).id }; }
  catch (e) { return { comment_id: null, comment_error: `The first comment didn't post (${e.message}). Add it by hand.` }; }
}

// The link a picture-less Facebook post is shared as: the last web address in
// its text (the tracked petition link the desk puts at the end), without any
// full stop or bracket after it. None means a plain text post.
function linkOf(text) {
  const all = String(text || '').match(/https?:\/\/[^\s<>"]+/g);
  return all ? all[all.length - 1].replace(/[.,;:!?)\]'"]+$/, '') : null;
}

// Facebook: one image as a photo post, several as one post with attached
// photos, none as a link post (Facebook draws the link's preview card) or, with
// no link in the text, a text post. Then the first comment.
async function publishFacebook({ pageId, token, text, comment, urls, fetchImpl }) {
  let postId;
  if (urls.length === 1) {
    const r = await post(`${pageId}/photos`, { url: urls[0], message: text, published: 'true' }, token, fetchImpl);
    postId = r.post_id || r.id;
  } else if (urls.length > 1) {
    const ids = [];
    for (const url of urls) ids.push((await post(`${pageId}/photos`, { url, published: 'false' }, token, fetchImpl)).id);
    const params = { message: text };
    ids.forEach((id, i) => { params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id }); });
    postId = (await post(`${pageId}/feed`, params, token, fetchImpl)).id;
  } else {
    const link = linkOf(text);
    postId = (await post(`${pageId}/feed`, link ? { message: text, link } : { message: text }, token, fetchImpl)).id;
  }
  return { id: postId, url: `https://www.facebook.com/${postId}`, ...(await firstComment(postId, comment, token, fetchImpl)) };
}

// Instagram: a container (or a carousel of them), published, then the first
// comment.
async function publishInstagram({ igId, token, text, comment, urls, collaborators = [], fetchImpl }) {
  let creation;
  const collab = collaborators.length ? { collaborators: JSON.stringify(collaborators) } : {};
  if (urls.length === 1) {
    creation = (await post(`${igId}/media`, { image_url: urls[0], caption: text, ...collab }, token, fetchImpl)).id;
  } else {
    const children = [];
    for (const url of urls) children.push((await post(`${igId}/media`, { image_url: url, is_carousel_item: 'true' }, token, fetchImpl)).id);
    creation = (await post(`${igId}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption: text, ...collab }, token, fetchImpl)).id;
  }
  const id = (await post(`${igId}/media_publish`, { creation_id: creation }, token, fetchImpl)).id;
  let url = null;
  try { url = (await get(id, { fields: 'permalink' }, token, fetchImpl)).permalink || null; } catch (e) { /* the link is a nicety */ }
  return { id, url, ...(await firstComment(id, comment, token, fetchImpl)) };
}

// Videos [1 Nov]. The file (joined from its pieces on the Mini) goes straight
// to Meta, never through a public link. Facebook: a Page video with the post
// text as its description. Instagram: a Reel through a resumable upload, then
// wait until Instagram has processed it before publishing.
async function publishFacebookVideo({ pageId, token, text, comment, buffer, mime, fetchImpl = fetch }) {
  const form = new FormData();
  form.append('access_token', token);
  form.append('description', text);
  form.append('source', new Blob([buffer], { type: mime || 'video/mp4' }), mime === 'video/quicktime' ? 'video.mov' : 'video.mp4');
  const r = await fetchImpl(`https://graph-video.facebook.com/${VERSION}/${pageId}/videos`, { method: 'POST', body: form });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || json.error || !json.id) throw new Error((json.error && json.error.message) || `HTTP ${r.status}`);
  // Facebook is still processing the video for a few minutes, and refuses a
  // comment until it's ready: the comment waits for a later run (videoComment).
  return { id: json.id, url: `https://www.facebook.com/${pageId}/videos/${json.id}`, comment_id: null, ...(comment ? { comment_pending: true } : {}) };
}

// A Facebook video's first comment, once Facebook has finished processing it.
// Returns { done: false } while it's still processing, else the comment fields.
const COMMENT_WAIT_MS = 2 * 3600_000;
async function videoComment({ videoId, token, comment, fetchImpl = fetch }) {
  const v = await get(videoId, { fields: 'status' }, token, fetchImpl);
  const st = (v.status && v.status.video_status) || '';
  if (st === 'error') return { done: true, comment_id: null, comment_error: "Facebook couldn't process the video, so the first comment wasn't added. Check the Page." };
  if (st && st !== 'ready') return { done: false };
  return { done: true, ...(await firstComment(videoId, comment, token, fetchImpl)) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function publishInstagramReel({ igId, token, text, comment, buffer, collaborators = [], coverUrl = null, fetchImpl = fetch, wait = sleep, pollMs = 10_000, maxPolls = 27 }) {
  const container = await post(`${igId}/media`, {
    media_type: 'REELS', upload_type: 'resumable', caption: text, share_to_feed: 'true',
    ...(collaborators.length ? { collaborators: JSON.stringify(collaborators) } : {}), ...(coverUrl ? { cover_url: coverUrl } : {}),
  }, token, fetchImpl);
  const up = await fetchImpl(`https://rupload.facebook.com/ig-api-upload/${VERSION}/${container.id}`, {
    method: 'POST', headers: { Authorization: `OAuth ${token}`, offset: '0', file_size: String(buffer.length) }, body: buffer,
  });
  const upJson = await up.json().catch(() => ({}));
  if (!up.ok || upJson.error || upJson.success === false) throw new Error((upJson.error && (upJson.error.message || upJson.error)) || upJson.debug_info?.message || `upload HTTP ${up.status}`);
  let status = 'IN_PROGRESS';
  for (let i = 0; i < maxPolls; i++) {
    status = (await get(container.id, { fields: 'status_code' }, token, fetchImpl)).status_code;
    if (status === 'FINISHED') break;
    if (status === 'ERROR' || status === 'EXPIRED') throw new Error(`Instagram couldn't process the video (${status}).`);
    await wait(pollMs);
  }
  if (status !== 'FINISHED') throw new Error('Instagram is still processing the video; it will be tried again.');
  const id = (await post(`${igId}/media_publish`, { creation_id: container.id }, token, fetchImpl)).id;
  let url = null;
  try { url = (await get(id, { fields: 'permalink' }, token, fetchImpl)).permalink || null; } catch (e) { /* the link is a nicety */ }
  return { id, url, ...(await firstComment(id, comment, token, fetchImpl)) };
}

// Instagram Stories: each frame is its own Story, in order. Stickers (polls)
// can't be added through the API, so poll frames are left out by the desk.
// A failure after some frames are up says how many, and is never retried, so
// nothing goes up twice.
async function publishInstagramStory({ igId, token, urls, fetchImpl }) {
  const ids = [];
  for (const url of urls) {
    try {
      const creation = (await post(`${igId}/media`, { media_type: 'STORIES', image_url: url }, token, fetchImpl)).id;
      ids.push((await post(`${igId}/media_publish`, { creation_id: creation }, token, fetchImpl)).id);
    } catch (e) {
      if (!ids.length) throw e;
      throw Object.assign(new Error(`${ids.length} of ${urls.length} Story frames went up, then Instagram refused the next (${e.message}). Post the rest by hand.`), { partial: ids.length });
    }
  }
  return { id: ids[0], ids, url: null, frames: ids.length };
}

// Once a post's Facebook and Instagram are all out, its video pieces have done
// their job: every video-* folder under the post goes (replaced uploads too).
async function clearVideoPieces(store, post) {
  const base = `${post.team_id}/${String(post.id).replace(/[^a-z0-9-]/gi, '-')}`;
  const folders = (await store.engineMediaFolders(base)).filter((n) => /^video-[a-z0-9]{8,32}$/.test(n));
  let removed = 0;
  for (const f of folders) {
    const names = (await store.engineMediaList(`${base}/${f}`)).map((o) => `${base}/${f}/${o.name}`);
    await store.engineMediaRemove(names);
    removed += names.length;
  }
  return removed;
}

// Facebook Page Stories: each frame is uploaded as an unpublished photo, then
// posted as a Story (Page Stories API). Same rule as Instagram: a failure after
// some frames are up is final and says how many.
async function publishFacebookStory({ pageId, token, urls, fetchImpl }) {
  const ids = [];
  for (const url of urls) {
    try {
      const photo = (await post(`${pageId}/photos`, { url, published: 'false' }, token, fetchImpl)).id;
      const r = await post(`${pageId}/photo_stories`, { photo_id: photo }, token, fetchImpl);
      if (r.success === false || !r.post_id) throw new Error('Facebook did not confirm the Story');
      ids.push(r.post_id);
    } catch (e) {
      if (!ids.length) throw e;
      throw Object.assign(new Error(`${ids.length} of ${urls.length} Story frames went up, then Facebook refused the next (${e.message}). Post the rest by hand.`), { partial: ids.length });
    }
  }
  return { id: ids[0], ids, url: null, frames: ids.length };
}

// Joins a video's pieces and checks it is exactly the file the desk sent.
async function assembleVideo(store, video) {
  const crypto = require('crypto');
  const bufs = [];
  for (let i = 0; i < video.parts; i++) {
    const b = await store.engineMediaDownload(`${video.prefix}/${String(i).padStart(3, '0')}.part`);
    if (!b) throw new Error(`piece ${i + 1} of the video is missing; upload it again on the desk`);
    bufs.push(b);
  }
  const buf = Buffer.concat(bufs);
  if (buf.length !== video.size) throw new Error('the video is not the size the desk sent; upload it again');
  if (crypto.createHash('sha256').update(buf).digest('hex') !== video.sha256) throw new Error("the video doesn't match what the desk sent; upload it again");
  if (buf.slice(4, 8).toString('latin1') !== 'ftyp') throw new Error("that file isn't an MP4 or MOV video");
  return buf;
}

// After a run: once every Meta destination is out and nothing is left for a
// person to post by hand on X, the post is Posted.
function allOut(post, teams) {
  const team = (teams || []).find((t) => t.id === post.team_id);
  const doc = post.doc || {};
  const dests = E.destinations(doc);
  const slots = slotsOf(doc, team);
  const done = slots.every((x) => doc.published && doc.published[x.slot]);
  return { done, handOnly: dests.some((k) => !['facebook', 'instagram'].includes(platformOf(team, k))) };
}

module.exports = { linkOf, COMMENT_WAIT_MS, videoComment, VERSION, CLAIM_MS, LATE_MS, MAX_TRIES, platformOf, approverOf, plan, contentFor, publishFacebook, publishInstagram, publishFacebookVideo, publishInstagramReel, publishInstagramStory, publishFacebookStory, assembleVideo, clearVideoPieces, slotsOf, allOut, collaboratorsOf, COLLAB_MAX };
