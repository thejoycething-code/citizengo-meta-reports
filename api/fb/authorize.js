'use strict';
// Connect Facebook for the Content Engine, step 1 of 2 (slice 2, Nov 2026).
// Answers 503 until the FB_* environment is configured, so deploying this file
// changes nothing live.
//
// GET /api/fb/authorize?t=<link from the engine_connect tool>
//
// Says plainly what will happen, then sends the person to facebook.com to
// choose the Pages CitizenGO may post to for them.

const crypto = require('crypto');
const flow = require('../../lib/fbflow');

module.exports = async (req, res) => {
  const cfg = flow.config();
  if (!cfg.ok) {
    return flow.page(res, 503, 'Connect Facebook not configured',
      `<h1>Not available yet</h1><p>Connecting Facebook for publishing has not been switched on for this deployment.</p>
       <p class="muted">Missing configuration: ${flow.esc(cfg.missing.join(', '))}. See docs/content-engine-phase2.md, slice 2.</p>`);
  }
  if (req.method !== 'GET') { res.statusCode = 405; res.setHeader('Allow', 'GET'); return res.end('Method Not Allowed'); }

  const url = new URL(req.url, 'https://placeholder.invalid');
  const link = flow.verifyLink(cfg.secret, url.searchParams.get('t'));
  if (!link) {
    return flow.page(res, 400, 'Link not valid',
      '<h1>This link has expired</h1><p>Links from the posts desk last ten minutes. Go back to the desk and choose Connect Facebook again.</p>');
  }

  const state = crypto.randomBytes(16).toString('base64url');
  flow.setCookie(res, flow.cookieValue(cfg.secret, { who: link.who, state }));
  const next = flow.authorizeUrl({ appId: cfg.appId, redirectUri: cfg.redirectUri, state });

  return flow.page(res, 200, 'Connect Facebook',
    `<h1>Connect your Facebook to the Content Engine</h1>
     <p>Signed in to the desk as <strong>${flow.esc(link.who)}</strong>. Facebook will ask which Pages to share: choose the CitizenGO Pages you post for.</p>
     <ul><li>The posts desk can then publish the posts <strong>you approve</strong> to those Pages and their Instagram accounts, at the time you set. Nothing goes out unless someone approves it.</li>
     <li>You can only approve posts for Pages you can post to on Facebook yourself. If you lose access there, you lose it here.</li>
     <li>Your Page access is stored sealed: the website that stores it can't read it back. Only the publisher uses it, to post what you approved.</li>
     <li>You can remove access any time: Facebook &rarr; Settings &rarr; Business integrations.</li></ul>
     <a class="btn" href="${flow.esc(next)}">Continue to Facebook</a>
     <p class="muted">Requested permissions: ${flow.esc(flow.SCOPES.join(', '))}. This link expires in ten minutes.</p>`);
};
