'use strict';
// Post now → the UK Asana posting calendars (Chris, 3 Nov 2026). When a post
// sent with the desk's "Post now" is live, the publisher on the Mini writes one
// Asana task noting what went out, where and when, in each UK calendar it went
// to: completed, Post Status "Scheduled // Posted", the post link, the real time
// and the exact text. Same task format as the daily run (content-engine/DAILY.md
// steps 1a and 1c), so the run's backfill recognises it and leaves it alone.
//
// Rules:
//   * UK accounts only (uk-fb, uk-ig, uk-x). Scotland and global get no task.
//   * Only posts with posting.postNow, and only once every UK Facebook and
//     Instagram destination is published. X is posted by hand: its calendar
//     gets the task too, left at Ready to Post and not completed, so the run
//     marks it once the X post is found.
//   * Never twice: posting.asanaPending is claimed before the call, and
//     posting.asanaTaskGid written after it. A claim older than 15 minutes with
//     no task is reported, not retried (the task may exist).
//   * Needs ASANA_TOKEN (a personal access token) on the Mini. Without it this
//     does nothing and the daily run's backfill makes the task as before.

const API = 'https://app.asana.com/api/1.0';
const ASSIGNEE = '1205223723565335'; // Chris Joyce, every UK posting task.
const CLAIM_MS = 15 * 60_000;
const MAX_TRIES = 3;
const WINDOW_MS = 48 * 3600_000; // Post now older than this is left to the daily run.

// The UK posting calendars, with the section a task lands in when nothing by
// name fits (DAILY.md step 1a).
const CALENDARS = {
  'uk-fb': { project: '1213654674026029', section: '1213654674026055', label: 'UK Facebook', platform: 'facebook' },
  'uk-ig': { project: '1214467025312064', section: '1214467222329334', label: 'UK Instagram', platform: 'instagram' },
  'uk-x': { project: '1216302259837664', section: '1216302259837691', label: 'UK X', platform: 'x' },
};

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function when(iso) {
  const d = new Date(iso);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute}`;
}

// X text as the desk shows it: the edit wins; one string or a thread.
function xPosts(doc) {
  const e = doc.edited && doc.edited.x;
  const v = e != null ? e : doc.platforms && doc.platforms.x;
  return (Array.isArray(v) ? v : [v]).map((x) => (typeof x === 'string' ? x : (x && x.text) || '')).filter((x) => x !== '');
}
function formatOf(doc, platform) {
  const f = (doc.final && doc.final[platform]) || {};
  const media = Array.isArray(f.media) ? f.media.filter(Boolean) : [];
  if (f.video || (doc.card && doc.card.template === 'reel')) return 'video';
  if (platform === 'x') { const posts = xPosts(doc); return posts.length > 1 ? 'thread' : 'image'; }
  if (media.length > 1) return 'carousel';
  if (media.length === 1) return 'image';
  return /https?:\/\//.test(String(f.text || '')) ? 'link' : 'text';
}
const EMOJI = { image: '🖼️', carousel: '🖼️', video: '📼', link: '🔗', thread: '🧵', text: '🖼️' };
// Content Type option names to try, in order, per format.
const TYPE_NAMES = { image: ['Image'], carousel: ['Carousel', 'Image'], video: ['Reel', 'Video'], link: ['Link', 'Image'], thread: ['Thread'], text: ['Text Only', 'Image'] };

// The UK destinations a Post now post needs a task for, or null when it
// doesn't qualify (yet). Returns { keys, out, waiting }.
function ukDue(post, now = Date.now()) {
  const doc = (post && post.doc) || {};
  const p = doc.posting || {};
  if (!p.postNow || !p.postNow.at || p.asanaTaskGid) return null;
  if (now - Date.parse(p.postNow.at) > WINDOW_MS) return null;
  const keys = (Array.isArray(p.destinations) ? p.destinations : []).filter((k) => CALENDARS[k]);
  if (!keys.length) return null;
  const meta = keys.filter((k) => CALENDARS[k].platform !== 'x');
  const pub = doc.published || {};
  if (meta.some((k) => !pub[k])) return null; // still going out
  return { keys, out: meta, waiting: keys.filter((k) => !meta.includes(k)) };
}

// What the task says: name, html_notes, due time, and per calendar its format
// and post link. Channels with the same text share one Post Text block.
function taskFor(post, due) {
  const doc = post.doc || {};
  const pub = doc.published || {};
  const fmt = Object.fromEntries(due.keys.map((k) => [k, formatOf(doc, CALENDARS[k].platform)]));
  const emoji = [...new Set(due.keys.map((k) => EMOJI[fmt[k]]))].join('');
  const title = String(doc.title || doc.headline || post.id).replace(/^Scotland:\s*/i, '').trim().slice(0, 140);
  const times = due.out.map((k) => pub[k].at).filter(Boolean).sort();
  const at = times[0] || doc.posting.postNow.at;
  const groups = [];
  for (const k of due.keys) {
    const platform = CALENDARS[k].platform;
    const f = (doc.final && doc.final[platform]) || {};
    let text = String(f.text || '');
    if (platform === 'x') { const xs = xPosts(doc); text = xs.map((x, i) => (xs.length > 1 ? `Post ${i + 1}: ` : '') + x).join('\n'); }
    const comment = String(f.comment || '');
    const r = pub[k];
    const source = r
      ? `<strong><u>Source:</u></strong> ${esc(CALENDARS[k].label)}, ${esc(when(r.at || at))}: ${r.url ? `<a href="${esc(r.url)}">${esc(r.url)}</a>` : 'posted'}`
      : `<strong><u>Source:</u></strong> ${esc(CALENDARS[k].label)}, to post by hand (sent with Post now ${esc(when(doc.posting.postNow.at))})`;
    const g = groups.find((x) => x.text === text && x.comment === comment);
    if (g) g.sources.push(source); else groups.push({ text, comment, sources: [source] });
  }
  const html = groups.map((g) => [...g.sources, `<strong><u>Post Text:</u></strong> ${esc(g.text)}`, ...(g.comment ? [`<strong><u>First comment:</u></strong> ${esc(g.comment)}`] : [])].join('\n')).join('\n\n');
  return {
    name: `${emoji} ${title}`.trim(),
    html_notes: `<body>${html}</body>`,
    due_at: new Date(at).toISOString(),
    completed: !due.waiting.length,
    calendars: due.keys.map((k) => ({ key: k, ...CALENDARS[k], format: fmt[k], posted: !!pub[k], url: (pub[k] && pub[k].url) || null })),
  };
}

function client(token, fetchImpl = fetch) {
  async function call(method, path, data) {
    const res = await fetchImpl(`${API}${path}`, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify({ data }) } : {}) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Asana ${res.status}: ${((body.errors || [])[0] || {}).message || 'request failed'}`);
    return body.data;
  }
  return { call };
}

// A calendar's fields and sections, matched by name so new option gids don't
// break it.
async function calendarSetup(api, cal) {
  const [settings, sections] = await Promise.all([
    api.call('GET', `/projects/${cal.project}/custom_field_settings?opt_fields=custom_field.gid,custom_field.name,custom_field.resource_subtype,custom_field.enum_options.gid,custom_field.enum_options.name,custom_field.enum_options.enabled`),
    api.call('GET', `/projects/${cal.project}/sections?opt_fields=gid,name`),
  ]);
  const fields = {};
  for (const s of settings || []) { const f = s.custom_field || {}; fields[norm(f.name)] = f; }
  return { fields, sections: sections || [] };
}
function option(field, names) {
  const opts = ((field && field.enum_options) || []).filter((o) => o.enabled !== false);
  for (const n of names) { const o = opts.find((x) => norm(x.name) === norm(n)); if (o) return o.gid; }
  return null;
}
function fieldValues(setup, cal, completed) {
  const f = setup.fields;
  const out = {};
  const status = f['post status'];
  const st = option(status, cal.posted ? ['Scheduled // Posted', 'Scheduled Posted', 'Posted'] : ['Ready to Post']);
  if (status && st) out[status.gid] = st;
  const type = f['content type'];
  const ty = option(type, TYPE_NAMES[cal.format] || ['Image']);
  if (type && ty) out[type.gid] = ty;
  const pr = f.priority;
  const pv = option(pr, ['Medium']);
  if (pr && pv) out[pr.gid] = pv;
  const link = f['post link'];
  if (link && cal.url && link.resource_subtype === 'text') out[link.gid] = cal.url;
  return out;
}
function sectionFor(setup, cal) {
  const by = (re) => setup.sections.find((s) => re.test(s.name || ''));
  const s = cal.posted ? (by(/^(published|posted)/i) || by(/^scheduled/i)) : (by(/^scheduled/i) || null);
  return (s && s.gid) || cal.section;
}

// Creates the task in every calendar and returns { gid, url }.
async function createTask(api, task) {
  const setups = [];
  for (const cal of task.calendars) setups.push(await calendarSetup(api, cal));
  const first = task.calendars[0];
  const created = await api.call('POST', '/tasks', { name: task.name, html_notes: task.html_notes, due_at: task.due_at, assignee: ASSIGNEE, projects: [first.project] });
  const custom = {};
  task.calendars.forEach((cal, i) => Object.assign(custom, fieldValues(setups[i], cal, task.completed)));
  for (let i = 0; i < task.calendars.length; i++) {
    const cal = task.calendars[i];
    await api.call('POST', `/tasks/${created.gid}/addProject`, { project: cal.project, section: sectionFor(setups[i], cal) });
  }
  await api.call('PUT', `/tasks/${created.gid}`, { custom_fields: custom, completed: task.completed });
  return { gid: created.gid, url: created.permalink_url || `https://app.asana.com/0/${first.project}/${created.gid}` };
}

module.exports = { API, ASSIGNEE, CALENDARS, CLAIM_MS, MAX_TRIES, WINDOW_MS, ukDue, taskFor, client, createTask, calendarSetup, fieldValues, sectionFor, when };
