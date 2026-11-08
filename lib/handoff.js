'use strict';
// Hand-off mode (Chris, 8 Nov 2026). While the Meta app is stuck in
// Development mode, Facebook shows the posts it publishes only to people with
// a role on the app. So the engine publishes nothing itself: an approved post
// is "handed off" as an Asana task in the posting calendars, a person posts it
// in Business Suite or on X, and closing the task marks it posted.
// The Graph publishing code stays, behind this switch, so it can come back.
//
// config/handoff.json { on, since, why, overdue_minutes }. ENGINE_HANDOFF_MODE
// overrides it: 1 forces it on, 0 forces it off.

let FILE = {};
try { FILE = require('../config/handoff.json'); } catch (e) { FILE = {}; }

function on(env = process.env) {
  const v = env.ENGINE_HANDOFF_MODE;
  if (v === '1') return true;
  if (v === '0') return false;
  return !!FILE.on;
}

function overdueMs() { return (Number(FILE.overdue_minutes) || 30) * 60_000; }

// A handed-off post whose time passed this long ago and that isn't marked
// posted yet: chase the task.
function overdue(post, now = Date.now()) {
  if (!post || post.status !== 'scheduled') return false;
  const at = Date.parse(post.post_at || '');
  return Number.isFinite(at) && now - at > overdueMs();
}

function info(env = process.env) {
  return on(env) ? { on: true, since: FILE.since || null, why: FILE.why || null, overdue_minutes: overdueMs() / 60_000 } : { on: false };
}

module.exports = { on, overdue, overdueMs, info };
