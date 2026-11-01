'use strict';
// Content Engine Inbox (slice 3, Nov 2026): comments and DMs on the teams'
// Facebook Pages and Instagram accounts. Rules for what can be done to which
// item, how Meta's answers become inbox rows, and how each queued action is
// sent to Meta. Read by collector/inbox.js, collector/inbox-actions.js and the
// engine_inbox* tools.

const VERSION = process.env.GRAPH_VERSION || 'v23.0';
const UNDO_MS = 10_000;
const BULK_UNDO_MS = 30_000;
const META_ACTIONS = ['reply', 'private_reply', 'like', 'hide', 'unhide', 'delete'];
const DESK_ACTIONS = ['done', 'reopen', 'assign', 'label'];
const REPLY_MAX = 2000;
const DM_WINDOW_MS = 24 * 3600_000; // Messenger and Instagram: replies only within 24 hours of their last message

// What Meta lets us do to an item. Returns { ok } or { ok: false, error }.
function allowed(item, action, { text, now = Date.now(), lastIncomingAt } = {}) {
  const fail = (error) => ({ ok: false, error });
  if (DESK_ACTIONS.includes(action)) return { ok: true };
  if (!META_ACTIONS.includes(action)) return fail(`Unknown action: ${action}.`);
  if (item.deleted_at) return fail('That comment has been deleted.');
  if (['reply', 'private_reply'].includes(action)) {
    const t = String(text || '').trim();
    if (!t) return fail('Write the reply first.');
    if (t.length > REPLY_MAX) return fail(`Replies are at most ${REPLY_MAX} characters.`);
  }
  if (item.kind === 'mention') return fail("A mention is someone else's post: open it on Facebook or Instagram to reply.");
  if (item.kind === 'message') {
    if (action !== 'reply') return fail('Messages can only be answered.');
    const last = Date.parse(lastIncomingAt || item.created_at);
    if (now - last > DM_WINDOW_MS) return fail('More than 24 hours since their last message: Meta only allows a reply within 24 hours.');
    return { ok: true };
  }
  if (item.from_us && ['hide', 'unhide', 'private_reply', 'like'].includes(action)) return fail('That comment is ours.');
  if (action === 'like' && item.platform === 'instagram') return fail("Instagram doesn't let apps like comments.");
  if (action === 'private_reply' && item.platform === 'instagram') return fail('Private replies to Instagram comments come later; reply publicly or open Instagram.');
  if (action === 'private_reply' && now - Date.parse(item.created_at) > 7 * 24 * 3600_000) return fail('Meta only allows a private reply within 7 days of the comment.');
  if (action === 'hide' && item.hidden) return fail('Already hidden.');
  if (action === 'unhide' && !item.hidden) return fail("It isn't hidden.");
  return { ok: true };
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
async function perform({ action, item, account, token, text, recipient, fetchImpl }) {
  const id = item.object_id;
  const fb = item.platform === 'facebook';
  switch (action) {
    case 'reply':
      if (item.kind === 'message') {
        const r = await call('POST', `${account.page_id}/messages`, { recipient: JSON.stringify({ id: recipient }), messaging_type: 'RESPONSE', message: JSON.stringify({ text }) }, token, fetchImpl);
        return { message_id: r.message_id || r.id || null };
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
function automationFor(item, automations) {
  if (item.kind !== 'comment' || item.from_us || item.platform !== 'facebook' || item.parent_id) return null;
  const words = new Set(fold(item.text).split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  return (automations || []).find((a) => a.active && (!a.thread_id || a.thread_id === item.thread_id)
    && (a.keywords || []).some((k) => { const f = fold(k).trim(); return f.includes(' ') ? fold(item.text).includes(f) : words.has(f); })) || null;
}
function checkAutomation({ name, keywords, dm_text, reply_text }) {
  const ks = [...new Set([].concat(keywords || []).map((k) => String(k).trim()).filter(Boolean))];
  if (!String(name || '').trim()) return { ok: false, error: 'Give the automation a name.' };
  if (!ks.length) return { ok: false, error: 'Give at least one keyword.' };
  if (ks.length > 10 || ks.some((k) => k.length > 40 || k.length < 2)) return { ok: false, error: 'Up to 10 keywords, each 2 to 40 characters.' };
  const dm = String(dm_text || '').trim();
  if (!dm) return { ok: false, error: 'Write the private message.' };
  if (dm.length > 1000 || String(reply_text || '').length > 500) return { ok: false, error: 'The message is at most 1,000 characters, the public reply 500.' };
  if (/\[ACTION LINK\]/.test(dm + (reply_text || ''))) return { ok: false, error: 'Put the real cgo.ac link in place of [ACTION LINK].' };
  return { ok: true, value: { name: String(name).trim().slice(0, 80), keywords: ks, dm_text: dm, reply_text: String(reply_text || '').trim() || null } };
}

module.exports = { AUTOMATION_DAILY_MAX, automationFor, checkAutomation, mention, PILE_MIN, PILE_X, PILE_SHARE, PILE_QUIET_MS, HOSTILE_WORDS, isHostile, pileOns, SCAM_PHRASES, matchRules, checkRule, VERSION, UNDO_MS, BULK_UNDO_MS, META_ACTIONS, DESK_ACTIONS, REPLY_MAX, DM_WINDOW_MS, allowed, fbComment, igComment, dmMessage, call, perform, afterAction };
