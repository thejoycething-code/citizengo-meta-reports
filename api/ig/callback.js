'use strict';
// Instagram account authorisation, step 2 of 2 (16 Oct 2026). See api/ig/authorize.js.
//
// GET /api/ig/callback?state=...&code=...   (or ?error=access_denied)
//
// code -> short-lived token -> long-lived token (60 days); asks Instagram who
// the account is, refuses the wrong account, then SEALS the token to the
// collector's public key and stores it. Never keeps a token in the clear and
// cannot read back what it wrote (lib/xauth.js seal).

const xauth = require('../../lib/xauth');
const igauth = require('../../lib/igauth');
const flow = require('../../lib/igflow');

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
    const text = await r.text().catch(() => '');
    console.error(`ig callback: ${method} ${pathAndQuery.split('?')[0]} -> HTTP ${r.status} ${text.slice(0, 300)}`);
    throw Object.assign(new Error(`database write failed (HTTP ${r.status})`), { status: r.status });
  }
  return r;
}

module.exports = async (req, res) => {
  const cfg = flow.config();
  if (!cfg.ok) return flow.page(res, 503, 'Instagram source not configured', '<h1>Not available yet</h1><p>Connecting Instagram accounts has not been switched on for this deployment.</p>');
  if (req.method !== 'GET') { res.statusCode = 405; res.setHeader('Allow', 'GET'); return res.end('Method Not Allowed'); }

  const url = new URL(req.url, 'https://placeholder.invalid');
  const ticket = flow.readCookie(cfg.inviteSecret, req);
  flow.clearCookie(res);

  if (url.searchParams.get('error')) {
    return flow.page(res, 200, 'Not connected',
      `<h1>Nothing was connected</h1><p>Instagram reported: <code>${flow.esc(url.searchParams.get('error_reason') || url.searchParams.get('error'))}</code>. If you meant to allow access, open your invite link again.</p>`);
  }
  if (!ticket || !ticket.invite) {
    return flow.page(res, 400, 'Session expired',
      '<h1>This step timed out</h1><p>Ten minutes passed between opening the invite and returning from Instagram, or cookies were blocked. Open your invite link again.</p>');
  }
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!state || !code || state !== ticket.state) {
    return flow.page(res, 400, 'Request mismatch', '<h1>This response did not match the request</h1><p>Open your invite link again and try once more.</p>');
  }

  let longTok; let granted;
  try {
    granted = await igauth.exchangeCode({ appId: cfg.appId, appSecret: cfg.appSecret, redirectUri: cfg.redirectUri, code });
    longTok = await igauth.longLived({ appSecret: cfg.appSecret, shortToken: granted.access_token });
  } catch (e) {
    console.error(`ig callback: ${e.message}`);
    return flow.page(res, 502, 'Instagram did not complete the connection',
      `<h1>Instagram did not complete the connection</h1><p class="err">${flow.esc(e.message)}</p><p>Open your invite link again. If it repeats, tell the person who sent it.</p>`);
  }
  if (granted.permissions.length && !granted.permissions.includes('instagram_business_manage_insights')) {
    return flow.page(res, 400, 'Insights not allowed',
      '<h1>Instagram did not grant access to insights</h1><p>Without it we can see your posts but not how they performed. Open the invite again and allow every permission on the Instagram screen.</p>');
  }

  const me = await igauth.get('me', { fields: igauth.ME_FIELDS }, longTok.access_token);
  if (!me.ok || !me.body || !(me.body.user_id || me.body.id)) {
    return flow.page(res, 502, 'Could not identify the account', '<h1>Instagram did not say which account this is</h1><p>Open the invite again.</p>');
  }
  const u = me.body;
  const igUserId = String(u.user_id || u.id);
  const invite = ticket.invite;
  const now = new Date().toISOString();

  let conflict;
  try {
    const existing = await (await pg('GET', `ig_accounts?select=ig_user_id,username,label,kind,is_active&ig_user_id=eq.${encodeURIComponent(igUserId)}`)).json();
    const holders = await (await pg('GET', `ig_accounts?select=ig_user_id,username,label,is_active&is_active=eq.true&label=ilike.${encodeURIComponent(String(invite.label).replace(/[*%,()]/g, ''))}`)).json();
    conflict = flow.enrolmentConflict({ igUserId, username: u.username, invite,
      existing: Array.isArray(existing) ? existing[0] || null : null, holders: Array.isArray(holders) ? holders : [] });
  } catch (e) {
    return flow.page(res, 500, 'Could not check', `<h1>Could not check whether this account is already connected</h1><p class="err">${flow.esc(e.message)}</p><p>Nothing was saved. Try the invite again in a few minutes.</p>`);
  }
  if (conflict) {
    console.log(JSON.stringify({ at: now, event: 'ig/enrol-refused', code: conflict.code, ig_user_id: igUserId, username: u.username, invite_label: invite.label }));
    return flow.page(res, 409, conflict.title, `<h1>${flow.esc(conflict.title)}</h1><p>${flow.esc(conflict.message)}</p><p class="muted">Nothing was changed. Your Instagram account has not been connected by this attempt.</p>`);
  }

  try {
    await pg('POST', 'ig_accounts?on_conflict=ig_user_id', [{
      ig_user_id: igUserId, username: u.username || null, name: u.name || null, account_type: u.account_type || null,
      kind: invite.kind, country: invite.country || null, label: invite.label, is_active: true,
      followers_count: u.followers_count ?? null, media_count: u.media_count ?? null,
      authorized_at: now, authorized_by: invite.by || null, last_seen_at: now,
    }], 'resolution=merge-duplicates,return=minimal');
    await pg('PATCH', `ig_oauth_tokens?ig_user_id=eq.${encodeURIComponent(igUserId)}&revoked_at=is.null`,
      { revoked_at: now, last_error: 're-authorised' }, 'return=minimal');
    await pg('POST', 'ig_oauth_tokens', [{
      ig_user_id: igUserId, sealed_token: xauth.seal(cfg.publicKey, longTok.access_token),
      scopes: (granted.permissions.length ? granted.permissions : igauth.SCOPES).join(','),
      authorized_at: now, refreshed_at: now, expires_at: new Date(Date.now() + longTok.expires_in * 1000).toISOString(),
    }], 'return=minimal');
  } catch (e) {
    return flow.page(res, 500, 'Could not save', `<h1>Connected to Instagram, but not saved</h1><p class="err">${flow.esc(e.message)}</p><p>Nothing was collected. Tell the person who sent the invite.</p>`);
  }

  console.log(JSON.stringify({ at: now, event: 'ig/authorized', ig_user_id: igUserId, username: u.username, kind: invite.kind, label: invite.label }));
  return flow.page(res, 200, 'Connected',
    `<h1>@${flow.esc(u.username)} is connected</h1>
     <p>Connected as <strong>${flow.esc(invite.label)}</strong> (${flow.esc(invite.kind)}). Collection starts with the next nightly run.</p>
     <p class="muted">You can close this page. To withdraw access later: Instagram &rarr; Settings &rarr; Website permissions.</p>`);
};
