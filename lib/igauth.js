'use strict';
// Instagram accounts connected by their holders (16 Oct 2026): spokespeople's
// personal professional accounts (Creator or Business), first Rocío D'Angelo.
// Uses Meta's "Instagram API with Instagram Login", which needs no Facebook
// Page - unlike our Page-linked Instagram collection (collector/instagram.js),
// which reaches only accounts in CitizenGO's Business Manager.
//
// Flow (mirrors the X source, lib/xauth.js):
//   1. invite link (signed, expiring; scripts/x-invite.js --platform instagram)
//   2. /api/ig/authorize -> instagram.com consent -> /api/ig/callback
//   3. code -> short-lived token (1 h) -> long-lived token (60 days)
//   4. the long-lived token is SEALED to the collector's public key (the same
//      key pair as X: X_TOKEN_PUBLIC_KEY / X_TOKEN_PRIVATE_KEY), so the
//      internet-facing deployment can store a credential it cannot read.
//   5. the collector refreshes it (allowed once it is 24 h old) and re-seals.
//
// Read-only by construction: the scopes are instagram_business_basic and
// instagram_business_manage_insights. Nothing that can post, comment or message.

const SCOPES = ['instagram_business_basic', 'instagram_business_manage_insights'];
const GRAPH = () => (process.env.IG_GRAPH_URL || 'https://graph.instagram.com').replace(/\/+$/, '');
const VERSION = 'v23.0';
const AUTHORIZE_URL = () => process.env.IG_AUTHORIZE_URL || 'https://www.instagram.com/oauth/authorize';
const TOKEN_URL = () => process.env.IG_TOKEN_URL || 'https://api.instagram.com/oauth/access_token';

function authorizeUrl({ appId, redirectUri, state, scopes = SCOPES }) {
  const u = new URL(AUTHORIZE_URL());
  u.searchParams.set('client_id', appId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', scopes.join(','));
  u.searchParams.set('state', state);
  // Always show the consent screen, so a holder signed into several accounts
  // sees which one is being connected.
  u.searchParams.set('force_reauth', 'true');
  return u.toString();
}

async function json(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) { return { raw: text.slice(0, 300) }; }
}
const why = (b, status) => (b && b.error && (b.error.message || b.error_message || b.error.type)) || (b && b.error_message) || `HTTP ${status}`;

// code -> short-lived token. Instagram returns either {access_token, user_id,
// permissions} or {data: [that]}; both are handled.
async function exchangeCode({ appId, appSecret, redirectUri, code, fetchImpl = fetch }) {
  const body = new URLSearchParams({ client_id: appId, client_secret: appSecret, grant_type: 'authorization_code', redirect_uri: redirectUri, code: String(code).replace(/#_$/, '') });
  const res = await fetchImpl(TOKEN_URL(), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const b = await json(res);
  const t = b && Array.isArray(b.data) ? b.data[0] : b;
  if (!res.ok || !t || !t.access_token) throw new Error(`Instagram refused the code: ${why(b, res.status)}`);
  const perms = Array.isArray(t.permissions) ? t.permissions : String(t.permissions || '').split(',').filter(Boolean);
  return { access_token: t.access_token, user_id: t.user_id ? String(t.user_id) : null, permissions: perms };
}

// short-lived -> long-lived (60 days).
async function longLived({ appSecret, shortToken, fetchImpl = fetch }) {
  const u = new URL(GRAPH() + '/access_token');
  u.searchParams.set('grant_type', 'ig_exchange_token');
  u.searchParams.set('client_secret', appSecret);
  u.searchParams.set('access_token', shortToken);
  const res = await fetchImpl(u.toString());
  const b = await json(res);
  if (!res.ok || !b.access_token) throw new Error(`Instagram did not issue a long-lived token: ${why(b, res.status)}`);
  return { access_token: b.access_token, expires_in: Number(b.expires_in) || 5184000 };
}

// A long-lived token at least 24 h old -> a fresh 60-day one. Needs no secret.
async function refresh({ token, fetchImpl = fetch }) {
  const u = new URL(GRAPH() + '/refresh_access_token');
  u.searchParams.set('grant_type', 'ig_refresh_token');
  u.searchParams.set('access_token', token);
  const res = await fetchImpl(u.toString());
  const b = await json(res);
  if (!res.ok || !b.access_token) {
    const e = new Error(`Instagram refused the refresh: ${why(b, res.status)}`);
    e.status = res.status; e.body = b;
    throw e;
  }
  return { access_token: b.access_token, expires_in: Number(b.expires_in) || 5184000 };
}

// Graph GET with the token, following paging when asked.
async function get(path, params, token, { fetchImpl = fetch } = {}) {
  const u = new URL(`${GRAPH()}/${VERSION}/${path.replace(/^\/+/, '')}`);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null) u.searchParams.set(k, v);
  u.searchParams.set('access_token', token);
  const res = await fetchImpl(u.toString());
  const body = await json(res);
  return { ok: res.ok, status: res.status, body };
}

const ME_FIELDS = 'user_id,username,name,account_type,followers_count,media_count';
const MEDIA_FIELDS = 'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count';
// Media insights served for feed posts and reels by the Instagram Login API.
// "views" replaced impressions/plays in 2025; asked for as one batch, and a
// metric the media type does not support is dropped and retried without.
const INSIGHT_METRICS = ['reach', 'views', 'likes', 'comments', 'shares', 'saved', 'total_interactions'];

module.exports = { SCOPES, VERSION, authorizeUrl, exchangeCode, longLived, refresh, get, ME_FIELDS, MEDIA_FIELDS, INSIGHT_METRICS };
