'use strict';
// X account authorisation, step 1 of 2. GROUNDWORK - answers 503 until the X_*
// environment is configured, so deploying this file changes nothing live.
//
// GET /api/x/authorize?t=<invite>
//
// The operator mints an invite (scripts/x-invite.js) naming the account being
// connected and its kind, and sends the link to whoever holds that X account.
// This page tells them exactly what will be read, then sends them to x.com to
// click Allow. There is no login here: the invite IS the authorisation to
// enrol, and it expires.
//
// Read-only by construction: the scopes requested are tweet.read, users.read
// and offline.access. Nothing that can post, follow, like or message.

const xauth = require('../../lib/xauth');
const flow = require('../../lib/xflow');

module.exports = async (req, res) => {
  const cfg = flow.config();
  if (!cfg.ok) {
    return flow.page(res, 503, 'X source not configured',
      `<h1>Not available yet</h1><p>The X data source has not been switched on for this deployment.</p>
       <p class="muted">Missing configuration: ${flow.esc(cfg.missing.join(', '))}. See README.md, "X (Twitter) source".</p>`);
  }
  if (req.method !== 'GET') {
    flow.secureHeaders(res);
    res.statusCode = 405; res.setHeader('Allow', 'GET');
    return res.end('Method Not Allowed');
  }

  const url = new URL(req.url, 'https://placeholder.invalid');
  const invite = xauth.verifyInvite(cfg.inviteSecret, url.searchParams.get('t'));
  if (!invite) {
    return flow.page(res, 400, 'Invite not valid',
      '<h1>This link is not valid</h1><p>It may have expired (invites last seven days) or been altered. Ask for a fresh one.</p>');
  }

  const { verifier, challenge } = xauth.pkcePair();
  const state = require('crypto').randomBytes(16).toString('base64url');
  flow.setCookie(res, flow.signCookie(cfg.inviteSecret, { verifier, state, invite }));

  const next = xauth.authorizeUrl({ clientId: cfg.clientId, redirectUri: cfg.redirectUri, state, challenge });
  const what = invite.kind === 'spokesperson'
    ? 'Only posts that contain a CitizenGO link (citizengo.org, hazteoir.org or cgo.ac) will be stored, with their impressions, engagement and link clicks. Nothing else you post is kept.'
    : 'Your posts from the last 30 days, and their impressions, engagement and link clicks, will be collected each night and kept for reporting.';

  return flow.page(res, 200, 'Connect an X account',
    `<h1>Connect <strong>${flow.esc(invite.label)}</strong> to CitizenGO reporting</h1>
     <p>You are about to let CitizenGO's reporting tool <strong>read</strong> the X account you are signed into. It cannot post, reply, like, follow or message.</p>
     <ul><li>${what}</li>
     <li>Access is read-only and you can withdraw it at any time from your X settings (Security and account access &rarr; Apps and sessions).</li>
     <li>Connected as: <strong>${flow.esc(invite.kind)}</strong>${invite.country ? ` &middot; ${flow.esc(invite.country)}` : ''}</li></ul>
     <p>Make sure you are signed into the right X account before continuing.</p>
     <a class="btn" href="${flow.esc(next)}">Continue to X</a>
     <p class="muted">Requested permissions: ${flow.esc(xauth.SCOPES.join(', '))}. This link expires in ten minutes.</p>`);
};
