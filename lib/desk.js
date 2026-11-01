'use strict';
// The Content Engine desk as a web app (/desk), Nov 2026: sign-in sessions,
// invites and the desk's own shared documents. People sign in with Facebook
// (api/fb/login.js -> api/fb/callback.js); a Facebook account is let in only
// when it is linked to a desk name (engine_people.fb_user_id), either by
// connecting Facebook from the old desk or by an admin's invite link.
//
// Sessions: a random 32-byte cookie (HttpOnly, Secure, SameSite=Lax); only its
// SHA-256 is stored, so a database read can't be replayed as a cookie.

const crypto = require('crypto');

const SESSION_COOKIE = 'cgo_desk';
const SESSION_DAYS = 30;
const INVITE_DAYS = 7;
const DOC_COLLECTIONS = ['savedReplies', 'listenShares', 'analyticsGroups', 'feedback', 'videoRequests'];

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');

async function pg(method, pathAndQuery, body, prefer) {
  const base = String(process.env.SUPABASE_URL || '').trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!base || !key) throw Object.assign(new Error('database not configured'), { code: 'CONFIG' });
  const r = await fetch(`${base}/rest/v1/${pathAndQuery}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    console.error(`desk: ${method} ${pathAndQuery.split('?')[0]} -> HTTP ${r.status} ${text.slice(0, 300)}`);
    throw Object.assign(new Error(`database request failed (HTTP ${r.status})`), { status: r.status });
  }
  return text ? JSON.parse(text) : null;
}
const q = encodeURIComponent;

function cookieOf(req, name) {
  const raw = String(req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  return raw ? decodeURIComponent(raw.slice(name.length + 1)) : null;
}
function sessionCookie(value, maxAge) {
  return `${SESSION_COOKIE}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

async function createSession({ who, fbUserId, userAgent }, now = Date.now()) {
  const t = token();
  await pg('POST', 'engine_desk_sessions', {
    id_hash: sha(t), who, fb_user_id: fbUserId || null, user_agent: String(userAgent || '').slice(0, 200),
    expires_at: new Date(now + SESSION_DAYS * 864e5).toISOString(), last_seen_at: new Date(now).toISOString(),
  }, 'return=minimal');
  return { cookie: sessionCookie(t, SESSION_DAYS * 86400) };
}
// The signed-in desk name, or null. Touches last_seen at most every 10 minutes.
async function readSession(req, now = Date.now()) {
  const t = cookieOf(req, SESSION_COOKIE);
  if (!t || t.length < 20) return null;
  const rows = await pg('GET', `engine_desk_sessions?select=id_hash,who,fb_user_id,expires_at,last_seen_at&id_hash=eq.${sha(t)}`);
  const s = rows && rows[0];
  if (!s || Date.parse(s.expires_at) <= now) return null;
  if (!s.last_seen_at || now - Date.parse(s.last_seen_at) > 10 * 60e3) {
    pg('PATCH', `engine_desk_sessions?id_hash=eq.${s.id_hash}`, { last_seen_at: new Date(now).toISOString() }, 'return=minimal').catch(() => {});
  }
  return { who: s.who, fbUserId: s.fb_user_id, idHash: s.id_hash };
}
async function endSession(req) {
  const t = cookieOf(req, SESSION_COOKIE);
  if (t) await pg('DELETE', `engine_desk_sessions?id_hash=eq.${sha(t)}`, undefined, 'return=minimal').catch(() => {});
  return { cookie: sessionCookie('', 0) };
}

// Facebook account -> desk name.
async function whoForFacebook(fbUserId) {
  const rows = await pg('GET', `engine_people?select=who&fb_user_id=eq.${q(fbUserId)}`);
  return (rows && rows[0] && rows[0].who) || null;
}
async function linkFacebook(who, fbUserId, fbName) {
  // One Facebook account belongs to one desk name: unlink it elsewhere first.
  await pg('PATCH', `engine_people?fb_user_id=eq.${q(fbUserId)}&who=neq.${q(who)}`, { fb_user_id: null }, 'return=minimal');
  await pg('POST', 'engine_people?on_conflict=who', { who, fb_user_id: fbUserId, fb_name: fbName || null, updated_at: new Date().toISOString(), updated_by: 'facebook' }, 'resolution=merge-duplicates,return=minimal');
}

// Invites: an admin names the person (and optionally adds them to a team);
// the link works once, for 7 days, and links whichever Facebook account uses it.
async function createInvite({ who, team_id, role, by }, now = Date.now()) {
  const t = token();
  await pg('POST', 'engine_desk_invites', { code_hash: sha(t), who, team_id: team_id || null, role: role === 'admin' ? 'admin' : 'editor', created_by: by, expires_at: new Date(now + INVITE_DAYS * 864e5).toISOString() }, 'return=minimal');
  return { code: t, expires_at: new Date(now + INVITE_DAYS * 864e5).toISOString() };
}
async function useInvite(code, fbUserId, now = Date.now()) {
  const rows = await pg('GET', `engine_desk_invites?select=code_hash,who,team_id,role,expires_at,used_at&code_hash=eq.${sha(code)}`);
  const inv = rows && rows[0];
  if (!inv || inv.used_at || Date.parse(inv.expires_at) <= now) return null;
  const done = await pg('PATCH', `engine_desk_invites?code_hash=eq.${inv.code_hash}&used_at=is.null`, { used_at: new Date(now).toISOString(), used_fb_user_id: fbUserId }, 'return=representation');
  if (!done || !done.length) return null; // someone used it a moment ago
  if (inv.team_id) await pg('POST', 'engine_members?on_conflict=team_id,who', { team_id: inv.team_id, who: inv.who, role: inv.role, added_by: 'invite' }, 'resolution=ignore-duplicates,return=minimal');
  return inv;
}

// The desk's own shared documents (were the artifact's database).
async function docsList(collection, { team } = {}) {
  if (!DOC_COLLECTIONS.includes(collection)) throw Object.assign(new Error('Unknown collection.'), { status: 400 });
  return pg('GET', `engine_desk_docs?select=id,team,data,created_by,created_at,updated_at&collection=eq.${q(collection)}${team ? `&or=(team.eq.${q(team)},team.is.null)` : ''}&order=created_at.desc&limit=500`);
}
async function docsPut(collection, id, data, by, { merge = false } = {}) {
  if (!DOC_COLLECTIONS.includes(collection)) throw Object.assign(new Error('Unknown collection.'), { status: 400 });
  const did = String(id || crypto.randomUUID()).slice(0, 200);
  const clean = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  if (JSON.stringify(clean).length > 200000) throw Object.assign(new Error('Too big.'), { status: 413 });
  let doc = clean;
  if (merge) {
    const cur = await pg('GET', `engine_desk_docs?select=data&collection=eq.${q(collection)}&id=eq.${q(did)}`);
    doc = { ...((cur && cur[0] && cur[0].data) || {}), ...clean };
  }
  await pg('POST', 'engine_desk_docs?on_conflict=collection,id', { collection, id: did, team: doc.team || null, data: doc, created_by: by, updated_at: new Date().toISOString() }, 'resolution=merge-duplicates,return=minimal');
  return { id: did };
}

// Only the desk's own pages may call the desk API with the session cookie.
function sameOrigin(req) {
  const origin = req.headers.origin || '';
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  return !!origin && !!host && origin === `https://${host}` && req.headers['x-desk'] === '1';
}

module.exports = { SESSION_COOKIE, SESSION_DAYS, INVITE_DAYS, DOC_COLLECTIONS, sha, pg, cookieOf, createSession, readSession, endSession, whoForFacebook, linkFacebook, createInvite, useInvite, docsList, docsPut, sameOrigin };
