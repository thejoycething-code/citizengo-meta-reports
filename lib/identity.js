'use strict';
// Is the person a token names still allowed in?
//
// Two kinds of identity reach the MCP endpoint and the refresh grant:
//   - a NAME from MCP_TOKENS ("chris"), behind a pre-shared token
//   - an EMAIL from Google sign-in ("someone@citizengo.net")
// Both are re-checked on every request and every refresh, so revocation takes
// effect on the next call rather than when a token happens to expire:
//   - a name: delete its MCP_TOKENS entry
//   - an email: add it to MCP_REVOKED_EMAILS, or remove the person from the
//     Workspace, or turn Google sign-in off (which ends every Google session)

const guard = require('./guard');
const google = require('./google');

function revokedEmails() {
  return String(process.env.MCP_REVOKED_EMAILS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function identityStillValid(who) {
  if (!who || typeof who !== 'string') return false;
  if (who.includes('@')) {
    if (!google.configured()) return false;           // sign-in off: its sessions end
    const email = who.toLowerCase();
    const domain = email.split('@')[1] || '';
    return google.allowedDomains().includes(domain) && !revokedEmails().includes(email);
  }
  return guard.usableTokens(process.env.MCP_TOKENS).some((e) => e.name === who);
}

module.exports = { identityStillValid, revokedEmails };
