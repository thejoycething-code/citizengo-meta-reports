'use strict';
// Facebook Reels the posts list misses (5 Nov 2026).
//
// The nightly reads each Page's published_posts. In the 60 days to 5 Nov 2026
// not one post came back typed as a Reel, while several Pages publish Reels, so
// some Reels were either filed as "added_video" or not listed at all. Reels
// have their own edge, /video_reels. This reads it for the same window, matches
// each Reel to a listed post, and adds the ones with no match as posts of their
// own, with status_type 'added_reel' so they can always be told apart.
//
// A Reel counts as listed when a post's id ends in the Reel's id, or the post's
// link carries it (/reel/<id>, /videos/<id>) - the two ways a Reel's post points
// at its video. Anything matched is left alone: its post already has metrics.

const REEL_FIELDS = 'id,created_time,description,permalink_url,length';
const REEL_METRICS = {
  blue_reels_play_count: 'plays',
  fb_reels_total_plays: 'total_plays',
  post_impressions_unique: 'reach',
  post_video_avg_time_watched: 'avg_ms',
  post_video_view_time: 'view_time_ms',
  post_video_social_actions: 'social',
  post_video_likes_by_reaction_type: 'reactions',
};

function isListed(reelId, posts) {
  const id = String(reelId);
  return posts.some((p) => String(p.post_id || p.id || '').endsWith(`_${id}`)
    || new RegExp(`/(reel|videos)/${id}(\\b|/|$)`).test(String(p.permalink_url || '')));
}

function insightValue(res) {
  if (!res || !res.ok) return null;
  const d = res.body && res.body.data && res.body.data[0];
  const v = d && d.values && d.values[0];
  return v ? v.value : null;
}

// Returns { reels, missing, posts, metrics, error }. posts/metrics are rows for
// meta_posts / meta_post_metrics, for the missing Reels only.
async function collectMissingReels({ pageId, listed, call, as, since, collectedDate, runStarted }) {
  const reels = [];
  let after = null;
  for (let guard = 0; guard < 10; guard++) {
    const params = { fields: REEL_FIELDS, limit: 50, since: Math.floor(since.getTime() / 1000) };
    if (after) params.after = after;
    const r = await call(`/${pageId}/video_reels`, params, as);
    if (!r.ok) return { reels: reels.length, missing: 0, posts: [], metrics: [], error: r.error || { message: 'unknown' } };
    const rows = (r.body && r.body.data) || [];
    for (const x of rows) if (x.created_time && new Date(x.created_time) >= since) reels.push(x);
    after = r.body && r.body.paging && r.body.paging.cursors && r.body.paging.cursors.after;
    if (!after || !rows.length || rows.some((x) => new Date(x.created_time) < since)) break;
  }
  const missing = reels.filter((x) => !isListed(x.id, listed));
  const posts = []; const metrics = [];
  for (const reel of missing) {
    const postId = `${pageId}_${reel.id}`;
    posts.push({
      post_id: postId, page_id: pageId, created_time: reel.created_time,
      message: reel.description || null,
      permalink_url: reel.permalink_url ? (reel.permalink_url.startsWith('http') ? reel.permalink_url : `https://www.facebook.com${reel.permalink_url}`) : null,
      status_type: 'added_reel', media_type: 'video', full_picture: null, is_published: true, link_url: null,
    });
    metrics.push({
      post_id: postId, page_id: pageId, collected_date: collectedDate, collected_at: runStarted.toISOString(),
      ...await reelInsights(reel.id, call, as),
    });
  }
  return { reels: reels.length, missing: missing.length, posts, metrics, error: null };
}

// A Reel's own numbers, from its video object rather than its post.
async function reelInsights(reelId, call, as) {
  const v = {}; const errors = {};
  for (const [metric, key] of Object.entries(REEL_METRICS)) {
    const r = await call(`/${reelId}/video_insights`, { metric }, as);
    if (r.ok) v[key] = insightValue(r);
    else errors[metric] = { code: r.error ? r.error.code : null, message: r.error ? r.error.message : 'unknown' };
  }
  const num = (x) => (typeof x === 'number' ? x : null);
  const reactions = v.reactions && typeof v.reactions === 'object' ? v.reactions : null;
  const social = v.social && typeof v.social === 'object' ? v.social : null;
  const plays = num(v.plays) ?? num(v.total_plays);
  return {
    // A Reel's views are its plays; its reach is the unique accounts shown it.
    views_total: plays,
    views_unique: num(v.reach),
    video_views: plays,
    video_view_time_ms: num(v.view_time_ms),
    video_avg_seconds_watched: num(v.avg_ms) === null ? null : Math.round(v.avg_ms / 100) / 10,
    reactions_total: reactions ? Object.values(reactions).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0) : null,
    comments_total: social && typeof social.COMMENT === 'number' ? social.COMMENT : null,
    shares_total: social && typeof social.SHARE === 'number' ? social.SHARE : null,
    errors: Object.keys(errors).length ? errors : null,
  };
}

// Reels that ARE listed as posts but whose post insights Meta refused (#200).
// Found 6 Nov 2026: 5 of the last 7 posts with no metrics were Reels listed as
// added_video (UK, Latam, France). Their post object answers #200 on every
// metric; the Reel's video object is a different door and may still answer.
// Fills only the fields the post pass left empty, so a partial post row keeps
// what it had. Mutates `metrics` in place; returns how many were rescued.
const REEL_LINK = /\/reel\/(\d{6,})/;
async function rescueListedReels({ posts, metrics, call, as }) {
  const byId = new Map(posts.map((p) => [p.post_id, p]));
  let tried = 0; let rescued = 0;
  for (const m of metrics) {
    if (m.views_total !== null && m.views_total !== undefined) continue;
    const p = byId.get(m.post_id);
    const hit = p && REEL_LINK.exec(String(p.permalink_url || ''));
    if (!hit) continue;
    tried++;
    const r = await reelInsights(hit[1], call, as);
    if (r.views_total === null) continue;
    for (const [k, v] of Object.entries(r)) {
      if (k === 'errors') continue;
      if ((m[k] === null || m[k] === undefined) && v !== null) m[k] = v;
    }
    m.errors = { ...(m.errors || {}), reel_rescue: { from: `video ${hit[1]}` } };
    rescued++;
  }
  return { tried, rescued };
}

module.exports = { collectMissingReels, rescueListedReels, reelInsights, isListed, REEL_METRICS };
