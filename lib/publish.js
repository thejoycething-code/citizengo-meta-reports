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
function plan(posts, teams, now = Date.now()) {
  const out = [];
  for (const post of posts || []) {
    if (post.status !== 'scheduled') continue;
    const team = (teams || []).find((t) => t.id === post.team_id);
    const doc = post.doc || {};
    const times = E.postTimes(doc);
    for (const key of E.destinations(doc)) {
      const platform = platformOf(team, key);
      if (platform !== 'facebook' && platform !== 'instagram') continue;
      if (doc.published && doc.published[key]) continue;
      const at = times[key];
      if (!at || Date.parse(at) > now) continue;
      const claim = doc.publishing && doc.publishing[key];
      const err = doc.publishErrors && doc.publishErrors[key];
      let action = 'publish';
      if (claim && now - Date.parse(claim.at) < CLAIM_MS) action = 'busy';
      else if (claim) action = 'unsure';
      else if (err && (err.tries || 0) >= MAX_TRIES) action = 'gave_up';
      else if (now - Date.parse(at) > LATE_MS) action = 'late';
      out.push({ post, key, platform, at, action, approver: approverOf(doc) });
    }
  }
  return out;
}

// What goes out on one platform, from the approved snapshot.
function contentFor(doc, platform) {
  const f = doc && doc.final && doc.final[platform];
  if (!f) return { ok: false, error: 'Not ready to publish: open it on the desk and press "Update where and when" so the final text and images are saved.' };
  if (f.video) return { ok: false, error: 'Video posts are published by hand for now.' };
  const media = Array.isArray(f.media) ? f.media.filter(Boolean) : [];
  const text = String(f.text || '');
  if (platform === 'instagram' && !media.length) return { ok: false, error: 'Instagram needs an image.' };
  if (media.length > 10) return { ok: false, error: 'More than 10 images: Facebook and Instagram allow 10.' };
  if (platform === 'instagram' && text.length > 2200) return { ok: false, error: 'The Instagram caption is over 2,200 characters.' };
  return { ok: true, text, comment: f.comment ? String(f.comment) : '', media };
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

// Facebook: one image as a photo post, several as one post with attached
// photos, none as a text post. Then the first comment.
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
    postId = (await post(`${pageId}/feed`, { message: text }, token, fetchImpl)).id;
  }
  return { id: postId, url: `https://www.facebook.com/${postId}`, ...(await firstComment(postId, comment, token, fetchImpl)) };
}

// Instagram: a container (or a carousel of them), published, then the first
// comment.
async function publishInstagram({ igId, token, text, comment, urls, fetchImpl }) {
  let creation;
  if (urls.length === 1) {
    creation = (await post(`${igId}/media`, { image_url: urls[0], caption: text }, token, fetchImpl)).id;
  } else {
    const children = [];
    for (const url of urls) children.push((await post(`${igId}/media`, { image_url: url, is_carousel_item: 'true' }, token, fetchImpl)).id);
    creation = (await post(`${igId}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption: text }, token, fetchImpl)).id;
  }
  const id = (await post(`${igId}/media_publish`, { creation_id: creation }, token, fetchImpl)).id;
  let url = null;
  try { url = (await get(id, { fields: 'permalink' }, token, fetchImpl)).permalink || null; } catch (e) { /* the link is a nicety */ }
  return { id, url, ...(await firstComment(id, comment, token, fetchImpl)) };
}

// After a run: once every Meta destination is out and nothing is left for a
// person to post by hand on X, the post is Posted.
function allOut(post, teams) {
  const team = (teams || []).find((t) => t.id === post.team_id);
  const doc = post.doc || {};
  const dests = E.destinations(doc);
  const meta = dests.filter((k) => ['facebook', 'instagram'].includes(platformOf(team, k)));
  const done = meta.every((k) => doc.published && doc.published[k]);
  return { done, handOnly: dests.length > meta.length };
}

module.exports = { VERSION, CLAIM_MS, LATE_MS, MAX_TRIES, platformOf, approverOf, plan, contentFor, publishFacebook, publishInstagram, allOut };
