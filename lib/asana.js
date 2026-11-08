'use strict';
// Hand-off mode → the Asana posting calendars (Chris, 8 Nov 2026). While the
// engine can't publish (lib/handoff.js), the publisher on the Mini turns each
// handed-off post into ONE open Asana task, multi-homed in the calendar of
// every account it goes to, so a person can post it by hand in Business Suite
// or on X. Then it keeps the task in step and closes the loop:
//
//   * New hand-off (status scheduled, posting.handoff, no task yet): create
//     the task, due at the post's time, Post Status "Ready to Post", with the
//     copy per platform, first comment, alt text, desk link and the media
//     attached (images, the Reel cover and the video itself when under
//     Asana's 100 MB limit).
//   * The post changed on the desk after the task was made: update the
//     task's name, notes and due time (new media is attached).
//   * The task was completed: the post is marked posted, with the Post link
//     field as its link, and the results check runs as for any posted post.
//   * The post left Handed off (sent back, binned): the open task gets Post
//     Status "Cancelled" and a comment, so nobody posts it.
//
// Needs ASANA_TOKEN (a personal access token) on the Mini; Chris allowed it on
// 8 Nov 2026. Without it this does nothing.
//
// Never twice: posting.asanaPending is claimed before a task is created, and
// posting.asanaTaskGid written after. A claim older than 15 minutes with no
// task is reported, not retried (the task may exist).

const crypto = require('crypto');

const API = 'https://app.asana.com/api/1.0';
const ASSIGNEE = process.env.ASANA_ASSIGNEE || '1205223723565335'; // Chris Joyce
const ASSIGNEE_SCOTLAND = '1213515026033145'; // Tobias Bailey, Scotland-only posts (DAILY.md 1a)
const CLAIM_MS = 15 * 60_000;
const MAX_TRIES = 3;
const ATTACH_MAX = 100 * 1048576; // Asana's attachment limit
const DESK = 'https://meta-organic-reporting.vercel.app/desk/';

// The posting calendars, with the section a new task lands in, matched by name
// first (the gid is the fallback).
const CALENDARS = {
  'uk-fb': { project: '1213654674026029', section: '1213654674026055', label: 'Citizen GO UK (Facebook)', short: 'UK Facebook', platform: 'facebook' },
  'sc-fb': { project: '1216370749028245', section: '1216370749028249', label: 'Citizen GO Scotland (Facebook)', short: 'Scotland Facebook', platform: 'facebook' },
  'uk-ig': { project: '1214467025312064', section: '1214467222329334', label: 'citizengo_uk (Instagram)', short: 'UK Instagram', platform: 'instagram' },
  'uk-x': { project: '1216302259837664', section: '1216302259837691', label: '@CitizenGO_GB (X)', short: 'UK X', platform: 'x' },
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
function formatOf(doc) {
  const f = (doc.final && (doc.final.facebook || doc.final.instagram)) || {};
  const media = Array.isArray(f.media) ? f.media.filter(Boolean) : [];
  if (f.video || (doc.card && doc.card.template === 'reel') || /video|reel/i.test(String(doc.type || ''))) return 'video';
  if (media.length > 1) return 'carousel';
  if (media.length === 1) return 'image';
  return /https?:\/\//.test(String(f.text || '')) ? 'link' : 'text';
}
const EMOJI = { image: '🖼️', carousel: '🖼️', video: '📼', link: '🔗', text: '📝' };
// Content Type option names to try, in order, per format (calendars differ).
const TYPE_NAMES = { image: ['Image', 'Single Post'], carousel: ['Carousel', 'Image'], video: ['Video', 'Reel'], link: ['Link', 'Image'], text: ['Text Only', 'Single Post', 'Image'] };

// The calendars a post's task belongs in, or [] when it has none.
function keysOf(doc) {
  const d = (doc && doc.posting && doc.posting.destinations) || [];
  return d.filter((k) => CALENDARS[k]);
}

// What to do for one post: create, update, close, cancel, or nothing.
function stepFor(post, { handoffOn = true } = {}) {
  const doc = (post && post.doc) || {};
  const p = doc.posting || {};
  if (p.asanaTaskGid) {
    if (p.asanaClosedAt) return null;
    if (post.status === 'scheduled') return sigOf(post) !== p.asanaSig ? 'update' : 'check';
    if (['hold', 'changes', 'review', 'rejected'].includes(post.status) && p.handoff && !p.asanaCancelledAt) return 'cancel';
    return null;
  }
  if (!handoffOn || post.status !== 'scheduled' || !p.handoff || !keysOf(doc).length) return null;
  return 'create';
}

// What the task says. Same layout as the daily run's tasks (DAILY.md 1a):
// Source / Post Text / First comment blocks, one per platform.
function taskFor(post) {
  const doc = post.doc || {};
  const keys = keysOf(doc);
  const fmt = formatOf(doc);
  const title = String(doc.title || doc.headline || post.id).replace(/^Scotland:\s*/i, '').trim().slice(0, 140);
  const times = Object.values((doc.posting && doc.posting.times) || {}).concat(doc.posting && doc.posting.at ? [doc.posting.at] : []).filter((t) => !Number.isNaN(Date.parse(t))).sort();
  const at = post.post_at || times[0] || null;
  const fbKeys = keys.filter((k) => CALENDARS[k].platform === 'facebook');
  const lines = [];
  lines.push(`<strong>Post on:</strong> ${keys.map((k) => esc(CALENDARS[k].label)).join(', ')}${at ? ` · <strong>${esc(when(at))}</strong> (UK time)` : ''}`);
  if (fbKeys.includes('uk-fb') && fbKeys.includes('sc-fb')) lines.push('<strong>Facebook:</strong> post once on Citizen GO UK with Citizen GO Scotland as collaborator.');
  const collab = doc.final && doc.final.instagram && doc.final.instagram.collaborators;
  if (collab && collab.length) lines.push(`<strong>Instagram collaborators:</strong> ${collab.map((h) => '@' + esc(h)).join(' ')}`);
  lines.push(`<strong>Desk:</strong> <a href="${DESK}#${encodeURIComponent(post.id)}">open the post on the desk</a> (facts, history, download)`);
  const blocks = [];
  const plats = [...new Set(keys.map((k) => CALENDARS[k].platform))];
  for (const platform of plats) {
    const label = { facebook: 'Facebook', instagram: 'Instagram', x: 'X' }[platform];
    let text, comment = '';
    if (platform === 'x') {
      const xs = xPosts(doc);
      text = xs.map((x, i) => (xs.length > 1 ? `Post ${i + 1}: ` : '') + x).join('\n\n');
    } else {
      const f = (doc.final && doc.final[platform]) || {};
      text = String(f.text || '');
      comment = String(f.comment || '');
    }
    blocks.push([`<strong><u>${label} copy:</u></strong>`, esc(text), ...(comment ? [`<strong><u>${label} first comment</u></strong> (post it straight after publishing):`, esc(comment)] : [])].join('\n'));
  }
  const alt = doc.altText ? `<strong>Alt text:</strong> ${esc(doc.altText)}` : '';
  const html = [lines.join('\n'), ...blocks, alt, '<em>Made by the Content Engine. When it is live: paste the link into Post link, set Post Status to Scheduled // Posted and complete the task.</em>'].filter(Boolean).join('\n\n');
  return {
    name: `${EMOJI[fmt]} ${title}`.trim(),
    html_notes: `<body>${html}</body>`,
    due_at: at ? new Date(at).toISOString() : null,
    format: fmt,
    calendars: keys.map((k) => ({ key: k, ...CALENDARS[k] })),
  };
}

// What the task depends on, so a change on the desk updates it.
function sigOf(post) {
  const t = taskFor(post);
  const f = (post.doc && post.doc.final) || {};
  const media = ['facebook', 'instagram'].map((p) => f[p] ? [...(f[p].media || []), f[p].cover || '', f[p].video ? f[p].video.sha256 : ''] : []);
  return crypto.createHash('sha1').update(JSON.stringify([t.name, t.html_notes, t.due_at, t.calendars.map((c) => c.key), media])).digest('hex').slice(0, 16);
}

// Media to attach: { name, path | video }, each once (by its storage path).
function mediaOf(post) {
  const f = (post.doc && post.doc.final) || {};
  const out = [];
  const seen = new Set();
  for (const p of ['facebook', 'instagram']) {
    const x = f[p];
    if (!x) continue;
    (x.media || []).forEach((m, i) => { if (m && !seen.has(m)) { seen.add(m); out.push({ key: m, name: `${p}-${i + 1}.jpg`, path: m, mime: 'image/jpeg' }); } });
    if (x.cover && !seen.has(x.cover)) { seen.add(x.cover); out.push({ key: x.cover, name: 'reel-cover.jpg', path: x.cover, mime: 'image/jpeg' }); }
    if (x.video && x.video.sha256 && !seen.has(x.video.sha256)) {
      seen.add(x.video.sha256);
      const ext = /quicktime/.test(String(x.video.mime || '')) ? 'mov' : 'mp4';
      out.push({ key: x.video.sha256, name: `video.${ext}`, video: x.video, mime: x.video.mime || 'video/mp4', size: x.video.size });
    }
  }
  return out;
}

function client(token, fetchImpl = fetch) {
  async function call(method, path, data) {
    const res = await fetchImpl(`${API}${path}`, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify({ data }) } : {}) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Asana ${res.status}: ${((body.errors || [])[0] || {}).message || 'request failed'}`);
    return body.data;
  }
  async function attach(taskGid, name, buffer, mime) {
    const form = new FormData();
    form.append('parent', taskGid);
    form.append('file', new Blob([buffer], { type: mime }), name);
    const res = await fetchImpl(`${API}/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, body: form });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Asana ${res.status}: ${((body.errors || [])[0] || {}).message || 'attachment failed'}`);
    return body.data;
  }
  return { call, attach };
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
function fieldValues(setup, { status, format }) {
  const f = setup.fields;
  const out = {};
  const st = f['post status'];
  const sv = option(st, status === 'cancelled' ? ['Cancelled'] : ['Ready to Post']);
  if (st && sv) out[st.gid] = sv;
  if (format) {
    const type = f['content type'];
    const ty = option(type, TYPE_NAMES[format] || ['Image']);
    if (type && ty) out[type.gid] = ty;
    const pr = f.priority;
    const pv = option(pr, ['Medium']);
    if (pr && pv) out[pr.gid] = pv;
  }
  return out;
}
function sectionFor(setup, cal) {
  const s = setup.sections.find((x) => /^(to schedule|this week|scheduled)$/i.test(x.name || ''));
  return (s && s.gid) || cal.section;
}

// Creates the task in every calendar and returns { gid, url }.
async function createTask(api, task) {
  const setups = [];
  for (const cal of task.calendars) setups.push(await calendarSetup(api, cal));
  const first = task.calendars[0];
  const created = await api.call('POST', '/tasks', { name: task.name, html_notes: task.html_notes, ...(task.due_at ? { due_at: task.due_at } : {}), assignee: task.calendars.every((c) => /^sc-/.test(c.key)) ? ASSIGNEE_SCOTLAND : ASSIGNEE, projects: [first.project] });
  const out = { gid: created.gid, url: created.permalink_url || `https://app.asana.com/0/${first.project}/${created.gid}` };
  // From here the task exists: a failure must still hand back its gid, so it
  // is recorded and never made a second time.
  try {
    const custom = {};
    setups.forEach((s) => Object.assign(custom, fieldValues(s, { status: 'ready', format: task.format })));
    for (let i = 0; i < task.calendars.length; i++) {
      await api.call('POST', `/tasks/${created.gid}/addProject`, { project: task.calendars[i].project, section: sectionFor(setups[i], task.calendars[i]) });
    }
    await api.call('PUT', `/tasks/${created.gid}`, { custom_fields: custom });
  } catch (e) { throw Object.assign(e, { task: out }); }
  return out;
}

async function updateTask(api, gid, task) {
  await api.call('PUT', `/tasks/${gid}`, { name: task.name, html_notes: task.html_notes, ...(task.due_at ? { due_at: task.due_at } : {}) });
  // A calendar added on the desk: put the task in it too.
  const now = await api.call('GET', `/tasks/${gid}?opt_fields=memberships.project.gid`);
  const have = new Set(((now && now.memberships) || []).map((m) => m.project && m.project.gid));
  for (const cal of task.calendars) {
    if (have.has(cal.project)) continue;
    const setup = await calendarSetup(api, cal);
    await api.call('POST', `/tasks/${gid}/addProject`, { project: cal.project, section: sectionFor(setup, cal) });
    await api.call('PUT', `/tasks/${gid}`, { custom_fields: fieldValues(setup, { status: 'ready', format: task.format }) });
  }
}

// The task's state: completed, when, and every Post link field filled in
// (each calendar has its own Post link field, so a multi-homed task can carry
// one per platform).
async function readTask(api, gid) {
  const t = await api.call('GET', `/tasks/${gid}?opt_fields=completed,completed_at,custom_fields.name,custom_fields.text_value,custom_fields.display_value`);
  const links = [...new Set(((t && t.custom_fields) || []).filter((f) => norm(f.name) === 'post link')
    .map((f) => String(f.text_value || f.display_value || '').trim()).filter((u) => /^https?:\/\//.test(u)))];
  return { completed: !!(t && t.completed), completed_at: (t && t.completed_at) || null, links };
}

// Which account each pasted link is for, by its address.
function linksByKey(keys, links) {
  const out = {};
  const pick = (re) => links.find((u) => re.test(u));
  for (const k of keys) {
    const platform = CALENDARS[k] && CALENDARS[k].platform;
    const u = platform === 'facebook' ? pick(/facebook\.com|fb\.watch|fb\.me/i) : platform === 'instagram' ? pick(/instagram\.com/i) : platform === 'x' ? pick(/(^https?:\/\/(www\.)?(x|twitter)\.com)/i) : null;
    if (u) out[k] = u;
  }
  return out;
}

async function cancelTask(api, gid, calendars, why) {
  for (const cal of calendars) {
    try {
      const setup = await calendarSetup(api, cal);
      const v = fieldValues(setup, { status: 'cancelled' });
      if (Object.keys(v).length) await api.call('PUT', `/tasks/${gid}`, { custom_fields: v });
    } catch (e) { /* the comment below still says it */ }
  }
  await api.call('POST', `/tasks/${gid}/stories`, { text: why });
}

module.exports = { CALENDARS, CLAIM_MS, MAX_TRIES, ATTACH_MAX, ASSIGNEE, keysOf, stepFor, taskFor, sigOf, mediaOf, formatOf, xPosts, client, calendarSetup, fieldValues, sectionFor, createTask, updateTask, readTask, linksByKey, cancelTask, when };
