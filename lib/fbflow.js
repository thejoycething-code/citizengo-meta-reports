'use strict';
// "Connect Facebook" for the Content Engine (slice 2, Nov 2026): each person
// signs in with their own Facebook account, and the Pages they can post to
// become their publishing rights. api/fb/authorize.js and api/fb/callback.js.
//
// Same design as lib/xflow.js and lib/igflow.js: a ten-minute signed cookie
// (scoped to /api/fb) carries the state between the two requests, and the
// shared page chrome. The link that starts it is minted by the engine_connect
// MCP tool, so it names the signed-in person (`who`) and lasts ten minutes.

const crypto = require('crypto');
const xflow = require('./xflow');

const VERSION = process.env.GRAPH_VERSION || 'v23.0';
// Read Pages, post to them, and post to their linked Instagram accounts.
const SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'instagram_basic', 'instagram_content_publish', 'business_management'];

function config() {
  const appId = process.env.FB_APP_ID || '';
  const appSecret = process.env.FB_APP_SECRET || '';
  const redirectUri = process.env.FB_REDIRECT_URI || '';
  const secret = process.env.OAUTH_SIGNING_SECRET || '';
  const publicKey = String(process.env.X_TOKEN_PUBLIC_KEY || '').replace(/\\n/g, '\n');
  const missing = [
    !appId && 'FB_APP_ID', !appSecret && 'FB_APP_SECRET', !redirectUri && 'FB_REDIRECT_URI',
    !secret && 'OAUTH_SIGNING_SECRET', !publicKey && 'X_TOKEN_PUBLIC_KEY',
  ].filter(Boolean);
  return { ok: missing.length === 0, missing, appId, appSecret, redirectUri, secret, publicKey };
}

const b64url = (b) => Buffer.from(b).toString('base64url');
const mac = (secret, body) => b64url(crypto.createHmac('sha256', secret).update(`fb-connect.${body}`).digest());

// The start link: who it is for, valid ten minutes.
function signLink(secret, who, now = Date.now()) {
  const body = b64url(JSON.stringify({ who: String(who), exp: now + 10 * 60_000 }));
  return `${body}.${mac(secret, body)}`;
}
function verifyLink(secret, token, now = Date.now()) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const a = Buffer.from(sig); const b = Buffer.from(mac(secret, body));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p && p.who && p.exp > now ? p : null;
  } catch (e) { return null; }
}

const COOKIE = 'fb_connect_flow';
function readCookie(secret, req) {
  const raw = String(req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(COOKIE + '='));
  if (!raw) return null;
  return verifyLink(secret, raw.slice(COOKIE.length + 1)); // same signed shape as the link, plus the state
}
function cookieValue(secret, payload, now = Date.now()) {
  const body = b64url(JSON.stringify({ ...payload, exp: now + 10 * 60_000 }));
  return `${body}.${mac(secret, body)}`;
}
function setCookie(res, value) {
  res.setHeader('Set-Cookie', `${COOKIE}=${value}; Max-Age=600; Path=/api/fb; HttpOnly; Secure; SameSite=Lax`);
}
function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Max-Age=0; Path=/api/fb; HttpOnly; Secure; SameSite=Lax`);
}

function authorizeUrl({ appId, redirectUri, state, scopes = SCOPES }) {
  const q = new URLSearchParams({ client_id: appId, redirect_uri: redirectUri, state, response_type: 'code', scope: scopes.join(',') });
  return `https://www.facebook.com/${VERSION}/dialog/oauth?${q}`;
}

async function graph(path, params, { fetchImpl = fetch } = {}) {
  const r = await fetchImpl(`https://graph.facebook.com/${VERSION}/${path}?${new URLSearchParams(params)}`);
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.error) {
    const m = (body.error && body.error.message) || `HTTP ${r.status}`;
    throw new Error(`Facebook said: ${m}`);
  }
  return body;
}

// code -> user token -> long-lived user token (Page tokens fetched with a
// long-lived user token do not expire).
async function userToken({ appId, appSecret, redirectUri, code, fetchImpl }) {
  const short = await graph('oauth/access_token', { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code }, { fetchImpl });
  const long = await graph('oauth/access_token', { grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: short.access_token }, { fetchImpl });
  return long.access_token;
}

async function me(token, { fetchImpl } = {}) {
  return graph('me', { fields: 'id,name', access_token: token }, { fetchImpl });
}

// Every Page the person manages, with its tasks, Page token and linked
// Instagram account. Follows paging (people in big Business Managers).
async function pages(token, { fetchImpl } = {}) {
  const out = [];
  let after = null;
  for (let i = 0; i < 20; i++) {
    const params = { fields: 'id,name,tasks,access_token,instagram_business_account{id,username}', limit: '100', access_token: token };
    if (after) params.after = after;
    const body = await graph('me/accounts', params, { fetchImpl });
    out.push(...(body.data || []));
    after = body.paging && body.paging.next && body.paging.cursors && body.paging.cursors.after;
    if (!after) break;
  }
  return out;
}

module.exports = {
  VERSION, SCOPES, config, signLink, verifyLink, readCookie, cookieValue, setCookie, clearCookie,
  authorizeUrl, userToken, me, pages, page: xflow.page, esc: xflow.esc,
};
