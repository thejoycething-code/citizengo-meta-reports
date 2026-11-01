'use strict';
// Content Engine Inbox (slice 3, Nov 2026): comments and DMs on the teams'
// Facebook Pages and Instagram accounts. Rules for what can be done to which
// item, how Meta's answers become inbox rows, and how each queued action is
// sent to Meta. Read by collector/inbox.js, collector/inbox-actions.js and the
// engine_inbox* tools.

const VERSION = process.env.GRAPH_VERSION || 'v23.0';
const UNDO_MS = 10_000;
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

module.exports = { SCAM_PHRASES, matchRules, checkRule,  VERSION, UNDO_MS, META_ACTIONS, DESK_ACTIONS, REPLY_MAX, DM_WINDOW_MS, allowed, fbComment, igComment, dmMessage, call, perform, afterAction };
