'use strict';
// Shared pieces of the X authorisation flow (api/x/authorize.js and
// api/x/callback.js): configuration, the signed cookie that carries the PKCE
// verifier between the two requests, and the page chrome.
//
// The cookie exists because Vercel functions share nothing between requests.
// It holds the verifier, the state and the invite payload, signed with
// X_INVITE_SECRET so the callback can trust what the authorise step decided.
// Ten minutes, HttpOnly, Secure, SameSite=Lax (the return from x.com is a
// top-level navigation, which Lax permits), scoped to /api/x.

const crypto = require('crypto');

function config() {
  const clientId = process.env.X_CLIENT_ID || '';
  const inviteSecret = process.env.X_INVITE_SECRET || '';
  const publicKey = String(process.env.X_TOKEN_PUBLIC_KEY || '').replace(/\\n/g, '\n');
  const redirectUri = process.env.X_REDIRECT_URI || '';
  const missing = [
    !clientId && 'X_CLIENT_ID', !inviteSecret && 'X_INVITE_SECRET',
    !publicKey && 'X_TOKEN_PUBLIC_KEY', !redirectUri && 'X_REDIRECT_URI',
  ].filter(Boolean);
  return {
    ok: missing.length === 0, missing,
    clientId, clientSecret: process.env.X_CLIENT_SECRET || '', inviteSecret, publicKey, redirectUri,
  };
}

const COOKIE = 'x_oauth_flow';
const b64url = (b) => Buffer.from(b).toString('base64url');

function signCookie(secret, payload) {
  const body = b64url(JSON.stringify({ ...payload, exp: Date.now() + 10 * 60_000 }));
  const mac = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  return `${body}.${mac}`;
}

function readCookie(secret, req) {
  const raw = String(req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(COOKIE + '='));
  if (!raw) return null;
  const [body, mac] = raw.slice(COOKIE.length + 1).split('.');
  if (!body || !mac) return null;
  const expect = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  const a = Buffer.from(mac); const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p && p.exp > Date.now() ? p : null;
  } catch (e) { return null; }
}

function setCookie(res, value) {
  res.setHeader('Set-Cookie', `${COOKIE}=${value}; Max-Age=600; Path=/api/x; HttpOnly; Secure; SameSite=Lax`);
}
function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Max-Age=0; Path=/api/x; HttpOnly; Secure; SameSite=Lax`);
}

// Same posture as api/oauth/authorize.js: never framed, no scripts, no
// external assets, never cached. The one form-action this flow has is the
// outbound link to x.com, which is a navigation, not a form.
function secureHeaders(res) {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy',
    "frame-ancestors 'none'; default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
}

const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(res, status, title, bodyHtml) {
  secureHeaders(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>body{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1.25rem;color:#111;line-height:1.45}
h1{font-size:1.35rem;margin:0 0 .75rem}p{margin:.5rem 0}ul{padding-left:1.2rem}
a.btn{display:inline-block;margin-top:1rem;padding:.7rem 1.1rem;background:#111;color:#fff;text-decoration:none;border-radius:6px;font-weight:600}
.muted{color:#555;font-size:.92rem}.err{color:#a00}</style></head><body>${bodyHtml}</body></html>`);
}

module.exports = { config, signCookie, readCookie, setCookie, clearCookie, secureHeaders, page, esc, COOKIE };
