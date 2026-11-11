'use strict';
// Is the person a token names still allowed in?
//
// Two kinds of identity reach the MCP endpoint and the refresh grant:
//   - a NAME from MCP_TOKENS ("chris"), behind a pre-shared token
//   - an EMAIL from Google sign-in ("someone@citizengo.net")
// Both are re-checked on every request and every refresh, so revocation takes
// effect on the next call rather than when a token happens to expire:
//   - a name: `npm run tokens -- revoke <name>` (or delete its MCP_TOKENS entry)
//   - an email: add it to MCP_REVOKED_EMAILS, or remove the person from the
//     Workspace, or turn Google sign-in off (which ends every Google session)

const google = require('./google');
const tokens = require('./tokens');

function revokedEmails() {
  return String(process.env.MCP_REVOKED_EMAILS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

async function identityStillValid(who) {
  if (!who || typeof who !== 'string') return false;
  if (who.includes('@')) {
    if (!google.configured()) return false;           // sign-in off: its sessions end
    const email = who.toLowerCase();
    const domain = email.split('@')[1] || '';
    return google.allowedDomains().includes(domain) && !revokedEmails().includes(email);
  }
  return tokens.nameActive(who);
}

// The desk name a Google sign-in acts as.
//
// The Content Engine knows people by their desk name ("chris"), which is what
// team membership, approvals and the desk's own sign-in use. A Google sign-in
// arrives as a work email instead. GOOGLE_DESK_NAMES pairs them
// ("cjoyce@citizengo.net=chris,someone@citizengo.net=sname") so the same person
// keeps their teams whichever way they connected. An email with no pairing
// stays the email: reporting tools work, Content Engine tools say "sign in".
// Applied only AFTER identityStillValid has accepted the email, so the pairing
// can never let in someone the domain and revocation checks refused.
function deskNameFor(who) {
  if (!who || typeof who !== 'string' || !who.includes('@')) return who;
  const email = who.toLowerCase();
  for (const pair of String(process.env.GOOGLE_DESK_NAMES || '').split(',')) {
    const [e, name] = pair.split('=').map((s) => (s || '').trim());
    if (e && name && e.toLowerCase() === email) return name;
  }
  return who;
}

module.exports = { identityStillValid, revokedEmails, deskNameFor };
