'use strict';
// Instagram collection.
//
// Kept separate from the Facebook path because the shapes genuinely differ:
// IG media has no share count on the object, has `saved` (which Facebook has no
// equivalent for and is the strongest intent signal on the platform), and uses
// different metric names. Forcing both through one code path would mean
// special-casing at every step.
//
// IG insights survived Meta's 2025-2026 deprecations far better than Facebook's,
// so reach and views are straightforwardly available here.
//
// Requires instagram_basic and instagram_manage_insights on the token, plus the
// IG account being linked to the Page. A page without a linked account is
// skipped silently — most Pages legitimately have none.

const IG_MEDIA_FIELDS = [
  'id', 'caption', 'media_type', 'media_product_type', 'permalink',
  'thumbnail_url', 'timestamp', 'like_count', 'comments_count',
].join(',');

// Probed one at a time, like the Facebook metrics, so one unavailable metric
// cannot fail the rest. Stories expire after 24h and expose a narrower set;
// anything unsupported records an error and leaves a null.
const IG_METRICS = ['reach', 'views', 'saved', 'total_interactions', 'likes', 'comments', 'shares'];

function firstValue(res) {
  if (!res || !res.ok) return null;
  const d = res.body && res.body.data && res.body.data[0];
  const v = d && d.values && d.values[0];
  return v && typeof v.value === 'number' ? v.value : null;
}

// call(pathname, params, opts) is injected so this module stays testable and
// shares the collector's API-call accounting.
async function collectInstagram({ page, as, call, lookbackDays, maxPosts, runStarted, collectedDate, log }) {
  // The linked account, if any.
  const info = await call(`/${page.page_id}`, {
    fields: 'instagram_business_account{id,username,followers_count,media_count}',
  }, as);

  const ig = info.ok && info.body && info.body.instagram_business_account;
  if (!ig || !ig.id) return { linked: false, media: [], metrics: [] };

  const cutoff = new Date(runStarted.getTime() - lookbackDays * 86400000);
  const media = [];
  let next = null;

  while (media.length < maxPosts) {
    const params = next
      ? { fields: IG_MEDIA_FIELDS, limit: 100, after: next }
      : { fields: IG_MEDIA_FIELDS, limit: 100 };
    const res = await call(`/${ig.id}/media`, params, as);
    if (!res.ok) {
      log(`   instagram: @${ig.username} — media listing failed (${res.error ? res.error.message.slice(0, 70) : 'unknown'})`);
      return { linked: true, username: ig.username, media: [], metrics: [], error: res.error };
    }
    const rows = (res.body && res.body.data) || [];
    if (!rows.length) break;

    let reachedCutoff = false;
    for (const r of rows) {
      if (new Date(r.timestamp) < cutoff) { reachedCutoff = true; break; }
      media.push({
        media_id: r.id,
        page_id: page.page_id,
        ig_user_id: ig.id,
        ig_username: ig.username || null,
        media_type: r.media_type || null,
        media_product_type: r.media_product_type || null,
        caption: r.caption || null,
        permalink: r.permalink || null,
        thumbnail_url: r.thumbnail_url || null,
        timestamp: r.timestamp,
        _like_count: typeof r.like_count === 'number' ? r.like_count : null,
        _comments_count: typeof r.comments_count === 'number' ? r.comments_count : null,
      });
      if (media.length >= maxPosts) break;
    }
    if (reachedCutoff) break;
    next = res.body && res.body.paging && res.body.paging.cursors && res.body.paging.cursors.after;
    if (!next) break;
  }

  const metrics = [];
  for (const m of media) {
    const errors = {};
    const values = {};
    for (const metric of IG_METRICS) {
      const r = await call(`/${m.media_id}/insights`, { metric }, as);
      if (r.ok) values[metric] = firstValue(r);
      else errors[metric] = { code: r.error ? r.error.code : null, message: r.error ? r.error.message : 'unknown' };
    }
    metrics.push({
      media_id: m.media_id,
      page_id: page.page_id,
      collected_date: collectedDate,
      collected_at: runStarted.toISOString(),
      reach: values.reach ?? null,
      views: values.views ?? null,
      saved: values.saved ?? null,
      total_interactions: values.total_interactions ?? null,
      // The media object carries like and comment counts directly, which is
      // cheaper and more reliable than the insights metric. Fall back only if
      // the object did not provide them.
      likes: m._like_count ?? values.likes ?? null,
      comments: m._comments_count ?? values.comments ?? null,
      shares: values.shares ?? null,
      errors: Object.keys(errors).length ? errors : null,
    });
  }

  media.forEach((m) => { delete m._like_count; delete m._comments_count; });
  return { linked: true, username: ig.username, ig_user_id: ig.id, media, metrics };
}

module.exports = { collectInstagram, IG_METRICS, IG_MEDIA_FIELDS };
