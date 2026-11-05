'use strict';
// Facebook Page Stories (5 Nov 2026). Instagram Stories are collected in
// instagram.js; this is the Facebook half. The Page's /stories edge lists each
// Story with its status and time. Meta offers no per-Story insights for Pages,
// so this records what was posted and when: how often each Page uses Stories,
// which no other figure shows.

const FIELDS = 'post_id,status,creation_time,media_type,media_id,url';

async function collectFbStories({ page, call, as, since, runStarted }) {
  const rows = [];
  let after = null;
  for (let guard = 0; guard < 10; guard++) {
    const params = { fields: FIELDS, limit: 50 };
    if (since) params.since = Math.floor(since.getTime() / 1000);
    if (after) params.after = after;
    const r = await call(`/${page.page_id}/stories`, params, as);
    if (!r.ok) {
      if (!rows.length) return { rows: [], error: r.error || { message: 'unknown' } };
      break;
    }
    const data = (r.body && r.body.data) || [];
    for (const x of data) {
      const created = x.creation_time ? new Date(Number(x.creation_time) * 1000 || x.creation_time) : null;
      if (since && created && created < since) continue;
      if (!x.post_id) continue;
      rows.push({
        post_id: String(x.post_id), page_id: page.page_id, status: x.status || null,
        media_type: x.media_type || null, media_id: x.media_id ? String(x.media_id) : null,
        url: x.url || null, created_at: created && !isNaN(created) ? created.toISOString() : null,
        collected_at: runStarted.toISOString(),
      });
    }
    after = r.body && r.body.paging && r.body.paging.cursors && r.body.paging.cursors.after;
    if (!after || !data.length) break;
  }
  return { rows, error: null };
}

module.exports = { collectFbStories };
