'use strict';
// X account authorisation, step 2 of 2. GROUNDWORK - see api/x/authorize.js.
//
// GET /api/x/callback?state=...&code=...   (or ?error=access_denied)
//
// Exchanges the code for tokens, asks X who the account is, SEALS the refresh
// token to the collector's public key and stores it. This function never keeps
// a token in the clear and cannot read back what it wrote: Vercel holds the
// public key only. See lib/xauth.js for why.

const xauth = require('../../lib/xauth');
const xapi = require('../../lib/xapi');
const flow = require('../../lib/xflow');

async function pg(method, pathAndQuery, body, prefer) {
  const base = String(process.env.SUPABASE_URL || '').trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!base || !key) throw new Error('database not configured');
  const r = await fetch(`${base}/rest/v1/${pathAndQuery}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    // Table names and Postgres codes stay server-side, as in lib/store.js.
    const text = await r.text().catch(() => '');
    console.error(`x callback: ${method} ${pathAndQuery.split('?')[0]} -> HTTP ${r.status} ${text.slice(0, 300)}`);
    throw Object.assign(new Error(`database write failed (HTTP ${r.status})`), { status: r.status });
  }
  return r;
}

module.exports = async (req, res) => {
  const cfg = flow.config();
  if (!cfg.ok) return flow.page(res, 503, 'X source not configured', '<h1>Not available yet</h1><p>The X data source has not been switched on for this deployment.</p>');
  if (req.method !== 'GET') { flow.secureHeaders(res); res.statusCode = 405; res.setHeader('Allow', 'GET'); return res.end('Method Not Allowed'); }

  const url = new URL(req.url, 'https://placeholder.invalid');
  const ticket = flow.readCookie(cfg.inviteSecret, req);
  flow.clearCookie(res);

  if (url.searchParams.get('error')) {
    return flow.page(res, 200, 'Not connected',
      `<h1>Nothing was connected</h1><p>X reported: <code>${flow.esc(url.searchParams.get('error'))}</code>. If you meant to allow access, open your invite link again.</p>`);
  }
  if (!ticket || !ticket.invite) {
    return flow.page(res, 400, 'Session expired',
      '<h1>This step timed out</h1><p>Ten minutes passed between opening the invite and returning from X, or cookies were blocked. Open your invite link again.</p>');
  }
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!state || !code || state !== ticket.state) {
    return flow.page(res, 400, 'Request mismatch', '<h1>This response did not match the request</h1><p>Open your invite link again and try once more.</p>');
  }

  let granted;
  try {
    granted = await xauth.exchangeCode({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, redirectUri: cfg.redirectUri, code, verifier: ticket.verifier });
  } catch (e) {
    console.error(`x callback: ${e.message}`);
    return flow.page(res, 502, 'X did not accept the code', `<h1>X did not complete the connection</h1><p class="err">${flow.esc(e.message)}</p><p>Open your invite link again. If it repeats, tell the person who sent it.</p>`);
  }
  if (!granted.refresh_token) {
    return flow.page(res, 502, 'No refresh token', '<h1>X did not grant ongoing access</h1><p>The offline.access permission was not included in the grant, so nightly collection would stop within two hours. Open the invite again and make sure every permission is allowed.</p>');
  }

  const client = xapi.makeClient({ token: granted.access_token });
  const me = await client.me();
  if (!me.ok || !me.body || !me.body.data) {
    return flow.page(res, 502, 'Could not identify the account', '<h1>X did not say which account this is</h1><p>Open the invite again.</p>');
  }
  const u = me.body.data;
  const invite = ticket.invite;
  const now = new Date().toISOString();

  // Refuse to enrol the wrong account before writing anything. See
  // lib/xflow.js enrolmentConflict for why this exists.
  let conflict;
  try {
    const existing = await (await pg('GET', `x_accounts?select=account_id,username,label,kind,is_active&account_id=eq.${encodeURIComponent(String(u.id))}`)).json();
    const holders = await (await pg('GET', `x_accounts?select=account_id,username,label,is_active&is_active=eq.true&label=ilike.${encodeURIComponent(String(invite.label).replace(/[*%,()]/g, ''))}`)).json();
    conflict = flow.enrolmentConflict({ accountId: String(u.id), username: u.username, invite,
      existing: Array.isArray(existing) ? existing[0] || null : null, holders: Array.isArray(holders) ? holders : [] });
  } catch (e) {
    return flow.page(res, 500, 'Could not check', `<h1>Could not check whether this account is already connected</h1><p class="err">${flow.esc(e.message)}</p><p>Nothing was saved. Try the invite again in a few minutes.</p>`);
  }
  if (conflict) {
    // The grant we just received is unwanted; hand it back rather than leave a
    // live refresh token sitting unused on X's side.
    try { await xauth.revoke({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, token: granted.refresh_token }); } catch (e) { /* best effort */ }
    console.log(JSON.stringify({ at: now, event: 'x/enrol-refused', code: conflict.code, account_id: String(u.id), username: u.username, invite_label: invite.label }));
    return flow.page(res, 409, conflict.title, `<h1>${flow.esc(conflict.title)}</h1><p>${flow.esc(conflict.message)}</p><p class="muted">Nothing was changed. Your X account has not been connected by this attempt.</p>`);
  }

  try {
    await pg('POST', 'x_accounts?on_conflict=account_id', [{
      account_id: String(u.id), username: u.username, name: u.name || null,
      kind: invite.kind, country: invite.country || null, label: invite.label,
      is_active: true, followers_count: u.public_metrics ? u.public_metrics.followers_count ?? null : null,
      authorized_at: now, authorized_by: invite.by || null, last_seen_at: now,
    }], 'resolution=merge-duplicates,return=minimal');
    // A re-authorisation supersedes the previous credential. Keep the row,
    // mark it, so "who authorised when" stays answerable.
    await pg('PATCH', `x_oauth_tokens?account_id=eq.${encodeURIComponent(String(u.id))}&revoked_at=is.null`,
      { revoked_at: now, last_error: 're-authorised' }, 'return=minimal');
    await pg('POST', 'x_oauth_tokens', [{
      account_id: String(u.id), sealed_refresh: xauth.seal(cfg.publicKey, granted.refresh_token),
      scopes: granted.scope || xauth.SCOPES.join(' '), authorized_at: now,
    }], 'return=minimal');
  } catch (e) {
    return flow.page(res, 500, 'Could not save', `<h1>Connected to X, but not saved</h1><p class="err">${flow.esc(e.message)}</p><p>Nothing was collected. Tell the person who sent the invite; they can re-issue it once the database is reachable.</p>`);
  }

  console.log(JSON.stringify({ at: now, event: 'x/authorized', account_id: String(u.id), username: u.username, kind: invite.kind, label: invite.label }));
  return flow.page(res, 200, 'Connected',
    `<h1>@${flow.esc(u.username)} is connected</h1>
     <p>Connected as <strong>${flow.esc(invite.label)}</strong> (${flow.esc(invite.kind)}). Collection starts with the next nightly run.</p>
     <p class="muted">You can close this page. To withdraw access later: X &rarr; Settings &rarr; Security and account access &rarr; Apps and sessions.</p>`);
};
