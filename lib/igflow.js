'use strict';
// Shared pieces of the Instagram authorisation flow (api/ig/authorize.js and
// api/ig/callback.js). Same design as lib/xflow.js: a ten-minute signed cookie
// carries the state and the invite between the two requests (scoped to
// /api/ig), and the page chrome is shared with the X flow.

const crypto = require('crypto');
const xflow = require('./xflow');

function config() {
  const appId = process.env.IG_APP_ID || '';
  const appSecret = process.env.IG_APP_SECRET || '';
  const redirectUri = process.env.IG_REDIRECT_URI || '';
  const inviteSecret = process.env.X_INVITE_SECRET || '';
  const publicKey = String(process.env.X_TOKEN_PUBLIC_KEY || '').replace(/\\n/g, '\n');
  const missing = [
    !appId && 'IG_APP_ID', !appSecret && 'IG_APP_SECRET', !redirectUri && 'IG_REDIRECT_URI',
    !inviteSecret && 'X_INVITE_SECRET', !publicKey && 'X_TOKEN_PUBLIC_KEY',
  ].filter(Boolean);
  return { ok: missing.length === 0, missing, appId, appSecret, redirectUri, inviteSecret, publicKey };
}

const COOKIE = 'ig_oauth_flow';

function readCookie(secret, req) {
  const raw = String(req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(COOKIE + '='));
  if (!raw) return null;
  const [body, mac] = raw.slice(COOKIE.length + 1).split('.');
  if (!body || !mac) return null;
  const expect = Buffer.from(crypto.createHmac('sha256', secret).update(body).digest()).toString('base64url');
  const a = Buffer.from(mac); const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p && p.exp > Date.now() ? p : null;
  } catch (e) { return null; }
}
function setCookie(res, value) {
  res.setHeader('Set-Cookie', `${COOKIE}=${value}; Max-Age=600; Path=/api/ig; HttpOnly; Secure; SameSite=Lax`);
}
function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Max-Age=0; Path=/api/ig; HttpOnly; Secure; SameSite=Lax`);
}

// Is this the account the invite was for? Same two refusals as the X flow
// (lib/xflow.js enrolmentConflict): the Instagram account is already connected
// under another label, or the label already belongs to another account.
function enrolmentConflict({ igUserId, username, invite, existing, holders }) {
  const norm = (v) => String(v || '').trim().toLowerCase();
  if (existing && existing.is_active !== false
    && (norm(existing.label) !== norm(invite.label) || (existing.kind || 'organisation') !== invite.kind)) {
    return { code: 'ACCOUNT_ALREADY_CONNECTED', title: 'Signed into a different account',
      message: `@${username} is already connected as "${existing.label}". This invite is for "${invite.label}". `
        + `You are probably signed into the wrong Instagram account. Switch to the ${invite.label} account on instagram.com, then open the invite link again.` };
  }
  const other = (holders || []).find((h) => String(h.ig_user_id) !== String(igUserId) && h.is_active !== false);
  if (other) {
    return { code: 'LABEL_ALREADY_CONNECTED', title: 'Already connected',
      message: `"${invite.label}" is already connected to @${other.username}. You are signed in as @${username}. `
        + `If ${invite.label} really has moved to @${username}, ask the person who sent the invite to retire the old connection first.` };
  }
  return null;
}

module.exports = { config, signCookie: xflow.signCookie, readCookie, setCookie, clearCookie, page: xflow.page, esc: xflow.esc, enrolmentConflict, COOKIE };
