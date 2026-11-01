'use strict';
// Sign in to the desk web app with Facebook (Nov 2026). Same Meta app and
// redirect URI as Connect Facebook (api/fb/callback.js handles both): signing
// in also refreshes the Pages the person can post to.
//
// GET /api/fb/login                 a Facebook account already linked to a desk name
// GET /api/fb/login?invite=<code>   first sign-in from an admin's invite link

const crypto = require('crypto');
const flow = require('../../lib/fbflow');

module.exports = async (req, res) => {
  const cfg = flow.config();
  if (!cfg.ok) return flow.page(res, 503, 'Sign-in not configured', '<h1>Not available yet</h1><p>Facebook sign-in has not been switched on for this deployment.</p>');
  if (req.method !== 'GET') { res.statusCode = 405; res.setHeader('Allow', 'GET'); return res.end('Method Not Allowed'); }
  const url = new URL(req.url, 'https://placeholder.invalid');
  const invite = String(url.searchParams.get('invite') || '').slice(0, 100) || null;
  const state = crypto.randomBytes(16).toString('base64url');
  // verifyLink needs a "who"; the real one is known only after Facebook answers.
  flow.setCookie(res, flow.cookieValue(cfg.secret, { who: '(sign-in)', mode: 'login', state, ...(invite ? { invite } : {}) }));
  res.statusCode = 302;
  res.setHeader('Location', flow.authorizeUrl({ appId: cfg.appId, redirectUri: cfg.redirectUri, state }));
  res.setHeader('Cache-Control', 'no-store');
  return res.end();
};
