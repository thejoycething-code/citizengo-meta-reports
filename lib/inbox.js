'use strict';
// Content Engine Inbox (slice 3, Nov 2026): comments and DMs on the teams'
// Facebook Pages and Instagram accounts. Rules for what can be done to which
// item, how Meta's answers become inbox rows, and how each queued action is
// sent to Meta. Read by collector/inbox.js, collector/inbox-actions.js and the
// engine_inbox* tools.

const VERSION = process.env.GRAPH_VERSION || 'v23.0';
const UNDO_MS = 10_000;
const BULK_UNDO_MS = 30_000;
const META_ACTIONS = ['reply', 'private_reply', 'like', 'hide', 'unhide', 'delete', 'ban', 'unban'];
const DESK_ACTIONS = ['done', 'reopen', 'assign', 'label'];
const REPLY_MAX = 2000;
const DM_WINDOW_MS = 24 * 3600_000; // Messenger and Instagram: replies only within 24 hours of their last message

// What Meta lets us do to an item. Returns { ok } or { ok: false, error }.
function allowed(item, action, { text, now = Date.now(), lastIncomingAt, attachment } = {}) {
  const fail = (error) => ({ ok: false, error });
  if (DESK_ACTIONS.includes(action)) return { ok: true };
  if (!META_ACTIONS.includes(action)) return fail(`Unknown action: ${action}.`);
  if (item.deleted_at) return fail('That comment has been deleted.');
  if (attachment) {
    // 18A (Priority Three, 4 Nov): Facebook lets a Page reply to a comment with
    // one picture or GIF. Instagram replies and messages stay text only.
    if (action !== 'reply' || item.platform !== 'facebook' || item.kind !== 'comment') return fail('Pictures and GIFs can only go on a public reply to a Facebook comment.');
    const a = attachmentOk(attachment);
    if (!a.ok) return a;
  }
  if (['reply', 'private_reply'].includes(action)) {
    const t = String(text || '').trim();
    if (!t && !(attachment && action === 'reply')) return fail('Write the reply first.');
    if (t.length > REPLY_MAX) return fail(`Replies are at most ${REPLY_MAX} characters.`);
  }
  if (item.kind === 'mention') return fail("A mention is someone else's post: open it on Facebook or Instagram to reply.");
  if (action === 'ban' || action === 'unban') {
    if (item.platform !== 'facebook') return fail("Instagram doesn't let apps ban accounts: restrict or block them in the Instagram app.");
    if (item.from_us || !item.author_id) return fail("Can't tell who wrote it, so there's no one to ban.");
    return { ok: true };
  }
  if (action === 'delete' && (item.labels || []).some((l) => /^threat/i.test(l))) return fail('Threats are hidden, never deleted, so a copy is kept for safeguarding. Hide it instead.');
  if (item.kind === 'message') {
    if (action !== 'reply') return fail('Messages can only be answered.');
    const last = Date.parse(lastIncomingAt || item.created_at);
    if (now - last > DM_WINDOW_MS) return fail('More than 24 hours since their last message: Meta only allows a reply within 24 hours.');
    return { ok: true };
  }
  if (item.from_us && ['hide', 'unhide', 'private_reply', 'like'].includes(action)) return fail('That comment is ours.');
  if (action === 'like' && item.platform === 'instagram') return fail("Instagram doesn't let apps like comments.");
  if (action === 'private_reply' && now - Date.parse(item.created_at) > 7 * 24 * 3600_000) return fail('Meta only allows a private reply within 7 days of the comment.');
  if (action === 'hide' && item.hidden) return fail('Already hidden.');
  if (action === 'unhide' && !item.hidden) return fail("It isn't hidden.");
  return { ok: true };
}

// A reply's picture or GIF: our own desk pictures (Supabase storage, public
// desk-assets bucket) or a GIPHY GIF, https only. Facebook fetches it itself.
const GIF_HOSTS = /^media\d*\.giphy\.com$|^i\.giphy\.com$/i;
function attachmentOk(a) {
  const fail = (error) => ({ ok: false, error });
  if (!a || typeof a !== 'object') return fail('Bad picture.');
  let u;
  try { u = new URL(String(a.url || '')); } catch (e) { return fail('Bad picture address.'); }
  if (u.protocol !== 'https:') return fail('Pictures must be https.');
  const kind = a.kind === 'gif' ? 'gif' : 'image';
  const ours = /\/storage\/v1\/object\/public\/desk-assets\//.test(u.pathname) && /\.supabase\.co$/i.test(u.hostname);
  if (kind === 'gif' && !(GIF_HOSTS.test(u.hostname) || ours)) return fail('GIFs come from the GIF search or our own uploads.');
  if (kind === 'image' && !ours) return fail('Pictures come from the desk library or an upload.');
  return { ok: true, attachment: { url: u.toString(), kind } };
}

// Meta answers → inbox rows. account: {key, platform, page_id | ig_id}.
function fbComment(c, { team, account, post }) {
  const from = c.from || {};
  return {
    id: `fbc_${c.id}`, team_id: team, account_key: account.key, platform: 'facebook', kind: 'comment',
    thread_id: post.id, object_id: c.id, parent_id: (c.parent && c.parent.id) || null,
    post_text: String(post.message || '').slice(0, 200) || null, post_url: post.permalink_url || null, is_ad: !!post.is_ad,
    author_id: from.id || null, author_name: from.name || null, text: c.message || '',
    created_at: c.created_time, from_us: String(from.id || '') === String(account.page_id), hidden: !!c.is_hidden,
  };
}
function igComment(c, { team, account, media, parentId = null }) {
  const from = c.from || {};
  return {
    id: `igc_${c.id}`, team_id: team, account_key: account.key, platform: 'instagram', kind: 'comment',
    thread_id: media.id, object_id: c.id, parent_id: parentId,
    post_text: String(media.caption || '').slice(0, 200) || null, post_url: media.permalink || null, is_ad: false,
    author_id: from.id || null, author_name: c.username || from.username || null, text: c.text || '',
    created_at: c.timestamp, from_us: String(from.id || '') === String(account.ig_id), hidden: !!c.hidden,
  };
}
function dmMessage(m, { team, account, conversation }) {
  const from = m.from || {};
  const ours = account.platform === 'instagram' ? String(from.id || '') === String(account.ig_id) : String(from.id || '') === String(account.page_id);
  const prefix = account.platform === 'instagram' ? 'igm' : 'fbm';
  return {
    id: `${prefix}_${m.id}`, team_id: team, account_key: account.key, platform: account.platform, kind: 'message',
    thread_id: conversation.id, object_id: m.id, parent_id: null, post_text: null, post_url: null, is_ad: false,
    author_id: from.id || null, author_name: from.name || from.username || null, text: m.message || '',
    created_at: m.created_time, from_us: ours, hidden: false,
  };
}

// Someone else's post that tags our Page or Instagram account.
function mention(m, { team, account }) {
  const from = m.from || {};
  const ig = account.platform === 'instagram';
  return {
    id: `${ig ? 'igt' : 'fbt'}_${m.id}`, team_id: team, account_key: account.key, platform: account.platform, kind: 'mention',
    thread_id: m.id, object_id: m.id, parent_id: null, post_text: null, post_url: m.permalink_url || m.permalink || null, is_ad: false,
    author_id: from.id || null, author_name: ig ? (m.username || null) : (from.name || null), text: (ig ? m.caption : m.message) || '',
    created_at: ig ? m.timestamp : m.created_time, from_us: false, hidden: false,
  };
}

async function call(method, path, params, token, fetchImpl = fetch) {
  const url = `https://graph.facebook.com/${VERSION}/${path}`;
  const r = method === 'GET'
    ? await fetchImpl(`${url}?${new URLSearchParams({ ...params, access_token: token })}`)
    : await fetchImpl(url, { method, body: new URLSearchParams({ ...params, access_token: token }) });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || json.error) throw Object.assign(new Error((json.error && json.error.message) || `HTTP ${r.status}`), { code: json.error && json.error.code });
  return json;
}

// Sends one queued action. item: the engine_inbox row; account: its team
// account; who replies is the Page or Instagram account itself.
async function perform({ action, item, account, token, text, recipient, attachment, fetchImpl }) {
  const id = item.object_id;
  const fb = item.platform === 'facebook';
  switch (action) {
    case 'reply':
      if (item.kind === 'message') {
        const r = await call('POST', `${account.page_id}/messages`, { recipient: JSON.stringify({ id: recipient }), messaging_type: 'RESPONSE', message: JSON.stringify({ text }) }, token, fetchImpl);
        return { message_id: r.message_id || r.id || null };
      }
      if (attachment && fb && attachmentOk(attachment).ok) {
        // attachment_share_url keeps a GIF moving; attachment_url is for a still picture.
        const at = attachment.kind === 'gif' ? { attachment_share_url: attachment.url } : { attachment_url: attachment.url };
        return { reply_id: (await call('POST', `${id}/comments`, { ...(text ? { message: text } : {}), ...at }, token, fetchImpl)).id };
      }
      return { reply_id: (await call('POST', fb ? `${id}/comments` : `${id}/replies`, { message: text }, token, fetchImpl)).id };
    case 'private_reply': {
      const r = await call('POST', `${account.page_id}/messages`, { recipient: JSON.stringify({ comment_id: id }), message: JSON.stringify({ text }) }, token, fetchImpl);
      return { message_id: r.message_id || r.id || null };
    }
    case 'like': return { ok: !!(await call('POST', `${id}/likes`, {}, token, fetchImpl)).success };
    case 'hide': await call('POST', id, fb ? { is_hidden: 'true' } : { hide: 'true' }, token, fetchImpl); return { hidden: true };
    case 'unhide': await call('POST', id, fb ? { is_hidden: 'false' } : { hide: 'false' }, token, fetchImpl); return { hidden: false };
    case 'delete': await call('DELETE', id, {}, token, fetchImpl); return { deleted: true };
    case 'ban': await call('POST', `${account.page_id}/blocked`, { user: item.author_id }, token, fetchImpl); return { banned: item.author_id };
    case 'unban': await call('DELETE', `${account.page_id}/blocked`, { user: item.author_id }, token, fetchImpl); return { unbanned: item.author_id };
    default: throw new Error(`Unknown action: ${action}`);
  }
}

// What a finished action changes on the inbox row.
function afterAction(action, at) {
  return {
    reply: { replied_at: at, status: 'done' }, private_reply: { replied_at: at, status: 'done' }, like: {},
    hide: { hidden: true }, unhide: { hidden: false }, delete: { deleted_at: at, status: 'done' },
  }[action] || {};
}

// Auto-hide list. Plain matching, no regular expressions from people, so a
// rule can't stall the collector. kinds: word (whole word), phrase (anywhere),
// links (any link that isn't ours), scams (the built-in phrases below).
const SCAM_PHRASES = [
  'whatsapp me', 'message me on whatsapp', 'text me on whatsapp', 'dm me for', 'inbox me for', 'check my bio', 'click my profile',
  'investment opportunity', 'invest with', 'forex', 'bitcoin', 'crypto trading', 'binary options', 'account manager',
  'earn $', 'earn £', 'make $', 'make £', 'per week from home', 'work from home and earn', 'sugar daddy', 'claim your prize',
  'you have won', 'recover your account', 'hacked account', 'telegram me',
];
const OUR_HOSTS = /(^|\.)(citizengo\.org|cgo\.ac)$/i;
const LINK_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|uk|xyz|info|biz|me|ly|link|click|top|site|online|shop|live|app)\b(?:\/[^\s<>"']*)?/gi;
const norm = (t) => String(t || '').toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ').trim();
function hostOf(link) {
  try { return new URL(/^https?:\/\//i.test(link) ? link : `http://${link}`).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}
// rules: engine_inbox_rules rows. Returns { rule, why } for the first match, or null.
function matchRules(text, rules) {
  const t = norm(text);
  if (!t) return null;
  const words = new Set(t.split(/[^\p{L}\p{N}']+/u).filter(Boolean));
  for (const r of rules || []) {
    const v = norm(r.value);
    if (r.kind === 'word' && v && (v.includes(' ') ? t.includes(v) : words.has(v))) return { rule: r, why: `the word "${r.value}"` };
    if (r.kind === 'phrase' && v && t.includes(v)) return { rule: r, why: `the phrase "${r.value}"` };
    if (r.kind === 'scams') { const hit = SCAM_PHRASES.find((p) => t.includes(p)); if (hit) return { rule: r, why: `a scam phrase ("${hit}")` }; }
    if (r.kind === 'links') {
      const outside = (String(text || '').match(LINK_RE) || []).map(hostOf).filter((h) => h && !OUR_HOSTS.test(h));
      if (outside.length) return { rule: r, why: `a link to ${outside[0]}` };
    }
  }
  return null;
}
function checkRule({ kind, value }) {
  if (!['word', 'phrase', 'links', 'scams'].includes(kind)) return { ok: false, error: 'kind is word, phrase, links or scams.' };
  const v = String(value || '').trim();
  if (['word', 'phrase'].includes(kind)) {
    if (!v) return { ok: false, error: `Give the ${kind}.` };
    if (v.length > 80) return { ok: false, error: 'At most 80 characters.' };
    if (kind === 'word' && v.length < 2) return { ok: false, error: 'A word needs at least 2 letters.' };
  }
  return { ok: true, value: ['links', 'scams'].includes(kind) ? '' : v };
}

// Pile-on alert: a post getting at least PILE_MIN comments in the last hour,
// PILE_X times its account's normal pace (comments per post per active hour,
// last 7 days), with at least PILE_SHARE of them hostile: a plain word list,
// or anything the auto-hide rules catch. No paid AI.
const PILE_MIN = 10, PILE_X = 3, PILE_SHARE = 0.3, PILE_QUIET_MS = 6 * 3600_000;
const HOSTILE_WORDS = ['bigot', 'bigots', 'bigoted', 'hate', 'hateful', 'disgusting', 'disgrace', 'shame', 'shameful', 'evil', 'nazi', 'nazis',
  'fascist', 'fascists', 'idiot', 'idiots', 'stupid', 'liar', 'liars', 'lies', 'vile', 'sick', 'pathetic', 'backwards', 'extremist', 'extremists',
  'cult', 'bullshit', 'scum', 'hypocrite', 'hypocrites', 'gross', 'moron', 'morons', 'clowns', 'delusional', 'brainwashed', 'misogynist', 'homophobic', 'transphobic'];
function isHostile(text, rules = []) {
  const words = new Set(norm(text).split(/[^\p{L}\p{N}']+/u).filter(Boolean));
  return HOSTILE_WORDS.some((w) => words.has(w)) || !!matchRules(text, rules);
}
// rows: the team's comments from the last 7 days (any status). Returns the
// posts that look like a pile-on right now.
function pileOns(rows, rules, now = Date.now()) {
  const hour = now - 3600_000, theirs = (rows || []).filter((r) => r.kind === 'comment' && !r.from_us);
  const buckets = {}, totals = {};
  for (const r of theirs) {
    const t = Date.parse(r.created_at);
    if (t >= hour) continue;
    const b = `${r.thread_id}|${Math.floor(t / 3600_000)}`;
    buckets[r.account_key] = buckets[r.account_key] || new Set(); buckets[r.account_key].add(b);
    totals[r.account_key] = (totals[r.account_key] || 0) + 1;
  }
  const baseline = (acc) => Math.max(1, (totals[acc] || 0) / Math.max(1, (buckets[acc] || new Set()).size));
  const byThread = {};
  for (const r of theirs) if (Date.parse(r.created_at) >= hour) (byThread[r.thread_id] = byThread[r.thread_id] || []).push(r);
  const out = [];
  for (const [thread_id, list] of Object.entries(byThread)) {
    const first = list[0], base = baseline(first.account_key), hostile = list.filter((r) => isHostile(r.text, rules)).length;
    if (list.length >= PILE_MIN && list.length >= PILE_X * base && hostile / list.length >= PILE_SHARE) {
      out.push({ team_id: first.team_id, account_key: first.account_key, thread_id, post_text: first.post_text || null, post_url: first.post_url || null, is_ad: !!first.is_ad, comments_hour: list.length, hostile_hour: hostile, baseline: Math.round(base * 10) / 10 });
    }
  }
  return out;
}

// Comment-to-DM automations. A keyword matches as a whole word, case and
// accents aside ("sign" matches "Sign!" but not "signal").
const AUTOMATION_DAILY_MAX = 200;
const fold = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const POST_TYPES = ['petition', 'prayer', 'reel', 'wins', 'news'];
// What a rule applies to: one post (thread_id), a post type, or every post.
// The most specific matching rule wins: post, then type, then all.
function automationScope(a) { return a.thread_id ? 'post' : a.scope === 'type' && a.post_type ? 'type' : 'all'; }
function automationFor(item, automations, { postType } = {}) {
  if (item.kind !== 'comment' || item.from_us || item.parent_id) return null;
  const words = new Set(fold(item.text).split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const rank = { post: 0, type: 1, all: 2 };
  return (automations || []).filter((a) => a.active && (a.platforms && a.platforms.length ? a.platforms : ['facebook']).includes(item.platform)
    && (automationScope(a) === 'post' ? a.thread_id === item.thread_id : automationScope(a) === 'type' ? a.post_type === postType : true)
    && (a.keywords || []).some((k) => { const f = fold(k).trim(); return f.includes(' ') ? fold(item.text).includes(f) : words.has(f); }))
    .sort((x, y) => rank[automationScope(x)] - rank[automationScope(y)])[0] || null;
}
// The public reply for this match: the rule's replies take turns.
function automationReply(a, n) {
  const list = (a.reply_texts || []).filter(Boolean);
  if (list.length) return list[Math.abs(Number(n) || 0) % list.length];
  return a.reply_text || null;
}
function checkAutomation({ name, keywords, dm_text, reply_text, reply_texts, scope, post_type, thread_id, platforms, skip_repeat, tag, hand_to }) {
  const ks = [...new Set([].concat(keywords || []).map((k) => String(k).trim()).filter(Boolean))];
  if (!String(name || '').trim()) return { ok: false, error: 'Give the automation a name.' };
  if (!ks.length) return { ok: false, error: 'Give at least one keyword.' };
  if (ks.length > 10 || ks.some((k) => k.length > 40 || k.length < 2)) return { ok: false, error: 'Up to 10 keywords, each 2 to 40 characters.' };
  const dm = String(dm_text || '').trim();
  if (!dm) return { ok: false, error: 'Write the private message.' };
  if (dm.length > 1000 || String(reply_text || '').length > 500) return { ok: false, error: 'The message is at most 1,000 characters, the public reply 500.' };
  const replies = [...new Set([].concat(reply_texts || []).map((t) => String(t).trim()).filter(Boolean))];
  if (replies.length > 5 || replies.some((t) => t.length > 500)) return { ok: false, error: 'Up to 5 public replies, each at most 500 characters.' };
  if (/\[ACTION LINK\]/.test(dm + (reply_text || '') + replies.join(''))) return { ok: false, error: 'Put the real cgo.ac link in place of [ACTION LINK].' };
  const sc = thread_id ? 'post' : scope || 'all';
  if (!['all', 'type', 'post'].includes(sc)) return { ok: false, error: 'It applies to one post, a post type or every post.' };
  if (sc === 'post' && !thread_id) return { ok: false, error: 'Pick the post it applies to.' };
  if (sc === 'type' && !POST_TYPES.includes(post_type)) return { ok: false, error: `Pick the post type: ${POST_TYPES.join(', ')}.` };
  const plats = [...new Set([].concat(platforms || ['facebook']))];
  if (!plats.length || plats.some((p) => !['facebook', 'instagram'].includes(p))) return { ok: false, error: 'It runs on Facebook, Instagram or both.' };
  const tg = String(tag || '').trim();
  if (tg.length > 40) return { ok: false, error: 'A tag is at most 40 characters.' };
  return { ok: true, value: { name: String(name).trim().slice(0, 80), keywords: ks, dm_text: dm, reply_text: String(reply_text || '').trim() || null, reply_texts: replies,
    scope: sc, post_type: sc === 'type' ? post_type : null, platforms: plats, skip_repeat: skip_repeat !== false, tag: tg || null, hand_to: String(hand_to || '').trim() || null } };
}


// Inbox › Team [Phase 3, chosen 2 Nov]: who has what, how fast each person
// answers, and when comments arrive against when we answer. Pure: items are
// the team's inbox rows for the window, actions its history, people the
// members who can reply. Reply time = the reply action's time minus the
// item's arrival, for items we have; nothing is guessed for the rest.
const minsBetween = (a, b) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60000));
const midOf = (xs) => { const v = xs.slice().sort((a, b) => a - b); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2); };
function teamStats({ items = [], actions = [], people = [], now = Date.now(), tz = 'Europe/London', hostile = () => false } = {}) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
  const key = (w) => String(w || '').toLowerCase();
  const P = new Map();
  const person = (w) => { const k = key(w); if (!P.has(k)) P.set(k, { who: w, assigned_open: 0, replies_today: 0, replies: 0, done: 0, times: [] }); return P.get(k); };
  for (const p of people) person(p.who || p);
  const open = items.filter((i) => i.status === 'open' && !i.from_us && !i.deleted_at);
  let unassigned = 0, oldest = null, over2h = 0, hostileOpen = 0;
  for (const i of open) {
    if (i.assigned_to) person(i.assigned_to).assigned_open++;
    else { unassigned++; if (!oldest || i.created_at < oldest) oldest = i.created_at; if (hostile(i)) hostileOpen++; }
    if (now - Date.parse(i.created_at) > 2 * 3600e3) over2h++;
  }
  const hourOf = (t) => Number(new Date(t).toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: tz })) % 24;
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, arrived: 0, replied: 0, times: [] }));
  for (const i of items) if (!i.from_us) hours[hourOf(i.created_at)].arrived++;
  const seen = new Set();
  // Oldest first, so the first reply to an item is the one timed (the store gives newest first).
  for (const a of (actions || []).slice().sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)))) {
    if (a.status && a.status !== 'done') continue;
    const p = person(a.by);
    if (a.action === 'done') { p.done++; continue; }
    if (a.action !== 'reply' && a.action !== 'private_reply') continue;
    p.replies++; if (Date.parse(a.created_at) >= dayStart.getTime()) p.replies_today++;
    const it = byId.get(a.item_id);
    if (!it || seen.has(a.item_id)) continue; // first reply to an item only
    seen.add(a.item_id);
    const m = minsBetween(it.created_at, a.created_at);
    p.times.push(m); const h = hours[hourOf(it.created_at)]; h.replied++; h.times.push(m);
  }
  const list = [...P.values()].map(({ times, ...p }) => ({ ...p, median_reply_min: midOf(times), replied_items: times.length }))
    .sort((a, b) => b.replies - a.replies || b.assigned_open - a.assigned_open || a.who.localeCompare(b.who));
  return {
    people: list,
    unassigned: { count: unassigned, oldest_at: oldest },
    waiting: { over_2h: over2h, hostile_unassigned: hostileOpen },
    open: open.length,
    median_reply_min: midOf([].concat(...[...P.values()].map((p) => p.times))),
    hours: hours.map(({ times, ...h }) => ({ ...h, median_reply_min: midOf(times) })),
  };
}

module.exports = { teamStats, AUTOMATION_DAILY_MAX, POST_TYPES, automationScope, automationFor, automationReply, checkAutomation, mention, PILE_MIN, PILE_X, PILE_SHARE, PILE_QUIET_MS, HOSTILE_WORDS, isHostile, pileOns, SCAM_PHRASES, matchRules, checkRule, VERSION, UNDO_MS, BULK_UNDO_MS, META_ACTIONS, DESK_ACTIONS, REPLY_MAX, DM_WINDOW_MS, allowed, attachmentOk, fbComment, igComment, dmMessage, call, perform, afterAction };
