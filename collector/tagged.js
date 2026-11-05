'use strict';
// Facebook posts others tag our Pages in (5 Nov 2026): the Facebook half of
// "posts others tag us in" (the Instagram half is collectTags in
// instagram.js). Public posts by people, Pages and press that name the Page -
// earned reach we would otherwise never see. Needs pages_read_user_content,
// which the comment counts already use.

const FIELDS = 'id,message,created_time,permalink_url,from{name}';

async function collectTagged({ page, call, as, since, runStarted }) {
  const r = await call(`/${page.page_id}/tagged`, { fields: FIELDS, limit: 50 }, as);
  if (!r.ok) return { rows: [], error: r.error || { message: 'unknown' } };
  const rows = [];
  for (const x of (r.body && r.body.data) || []) {
    if (x.created_time && since && new Date(x.created_time) < since) continue;
    rows.push({
      platform: 'facebook', account_id: page.page_id, page_id: page.page_id, account_name: page.name || null,
      item_id: x.id, author: (x.from && x.from.name) || null, text: x.message || null,
      media_type: null, permalink: x.permalink_url || null, created_at: x.created_time || null,
      likes: null, comments: null, collected_at: runStarted.toISOString(),
    });
  }
  return { rows, error: null };
}

module.exports = { collectTagged };
