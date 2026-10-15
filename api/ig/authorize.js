'use strict';
// Instagram account authorisation, step 1 of 2 (16 Oct 2026). Answers 503 until
// the IG_* environment is configured, so deploying this file changes nothing live.
//
// GET /api/ig/authorize?t=<invite>   (scripts/x-invite.js --platform instagram)
//
// Tells the holder exactly what will be read, then sends them to instagram.com
// to allow it. Read-only scopes: instagram_business_basic and
// instagram_business_manage_insights. Works for professional accounts
// (Creator or Business); a personal account is told how to switch.

const crypto = require('crypto');
const xauth = require('../../lib/xauth');
const igauth = require('../../lib/igauth');
const flow = require('../../lib/igflow');

module.exports = async (req, res) => {
  const cfg = flow.config();
  if (!cfg.ok) {
    return flow.page(res, 503, 'Instagram source not configured',
      `<h1>Not available yet</h1><p>Connecting Instagram accounts has not been switched on for this deployment.</p>
       <p class="muted">Missing configuration: ${flow.esc(cfg.missing.join(', '))}. See README.md, "Instagram accounts connected by their holders".</p>`);
  }
  if (req.method !== 'GET') { res.statusCode = 405; res.setHeader('Allow', 'GET'); return res.end('Method Not Allowed'); }

  const url = new URL(req.url, 'https://placeholder.invalid');
  const invite = xauth.verifyInvite(cfg.inviteSecret, url.searchParams.get('t'));
  if (!invite) {
    return flow.page(res, 400, 'Invite not valid',
      '<h1>This link is not valid</h1><p>It may have expired (invites last seven days) or been altered. Ask for a fresh one.</p>');
  }
  if (invite.platform !== 'instagram') {
    return flow.page(res, 400, 'Wrong link', '<h1>This invite is for X, not Instagram</h1><p>Ask the person who sent it for the right link.</p>');
  }

  const state = crypto.randomBytes(16).toString('base64url');
  flow.setCookie(res, flow.signCookie(cfg.inviteSecret, { state, invite }));
  const next = igauth.authorizeUrl({ appId: cfg.appId, redirectUri: cfg.redirectUri, state });
  const what = invite.kind === 'spokesperson'
    ? 'Only posts that contain a CitizenGO link (citizengo.org, hazteoir.org or cgo.ac) or mention CitizenGO (by name, @-mention or hashtag) will be stored, with their reach, views, likes, comments, shares and saves. Nothing else you post is kept.'
    : 'Your posts from the last 30 days, and their reach, views and interactions, will be collected each night and kept for reporting.';

  return flow.page(res, 200, 'Connect an Instagram account',
    `<h1>Connect <strong>${flow.esc(invite.label)}</strong> to CitizenGO reporting</h1>
     <p>You are about to let CitizenGO's reporting tool <strong>read</strong> the Instagram account you are signed into. It cannot post, comment, like, follow or message.</p>
     <ul><li>${what}</li>
     <li>It needs a <strong>professional account</strong> (Creator or Business). If yours is personal, switch first: Instagram &rarr; Settings &rarr; Account type and tools &rarr; Switch to professional account. It's free and nothing changes for your followers.</li>
     <li>Access is read-only and you can withdraw it at any time: Instagram &rarr; Settings &rarr; Website permissions (Apps and websites).</li>
     <li>Connected as: <strong>${flow.esc(invite.kind)}</strong>${invite.country ? ` &middot; ${flow.esc(invite.country)}` : ''}</li></ul>
     <p>Make sure you are signed into the right Instagram account before continuing.</p>
     <a class="btn" href="${flow.esc(next)}">Continue to Instagram</a>
     <p class="muted">Requested permissions: ${flow.esc(igauth.SCOPES.join(', '))}. This link expires in ten minutes.</p>`);
};
