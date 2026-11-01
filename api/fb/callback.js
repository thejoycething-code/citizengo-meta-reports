'use strict';
// Connect Facebook for the Content Engine, step 2 of 2. See api/fb/authorize.js.
//
// GET /api/fb/callback?state=...&code=...   (or ?error=access_denied)
//
// code -> long-lived user token -> the Pages the person manages. Pages they can
// post to (CREATE_CONTENT) that match a team account become their publishing
// rights (source 'meta'); each Page token is SEALED to the collector's public
// key before it is stored, and rights they no longer have are removed.

const xauth = require('../../lib/xauth');
const E = require('../../lib/engine');
const flow = require('../../lib/fbflow');
const D = require('../../lib/desk');

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
    console.error(`fb callback: ${method} ${pathAndQuery.split('?')[0]} -> HTTP ${r.status} ${text.slice(0, 300)}`);
    throw Object.assign(new Error(`database write failed (HTTP ${r.status})`), { status: r.status });
  }
  return r;
}
const inList = (xs) => `(${xs.map((x) => `"${String(x).replace(/["\\]/g, '')}"`).join(',')})`;

module.exports = async (req, res) => {
  const cfg = flow.config();
  if (!cfg.ok) return flow.page(res, 503, 'Connect Facebook not configured', '<h1>Not available yet</h1><p>Connecting Facebook for publishing has not been switched on for this deployment.</p>');
  if (req.method !== 'GET') { res.statusCode = 405; res.setHeader('Allow', 'GET'); return res.end('Method Not Allowed'); }

  const url = new URL(req.url, 'https://placeholder.invalid');
  const ticket = flow.readCookie(cfg.secret, req);
  flow.clearCookie(res);

  if (url.searchParams.get('error')) {
    return flow.page(res, 200, 'Not connected',
      `<h1>Nothing was connected</h1><p>Facebook reported: <code>${flow.esc(url.searchParams.get('error_reason') || url.searchParams.get('error'))}</code>. To try again, choose Connect Facebook on the posts desk.</p>`);
  }
  if (!ticket || !ticket.state) {
    return flow.page(res, 400, 'Session expired', '<h1>This step timed out</h1><p>Ten minutes passed, or cookies were blocked. Choose Connect Facebook on the posts desk again.</p>');
  }
  if (url.searchParams.get('state') !== ticket.state || !url.searchParams.get('code')) {
    return flow.page(res, 400, 'Request mismatch', '<h1>This response did not match the request</h1><p>Choose Connect Facebook on the posts desk again.</p>');
  }

  let person; let rights; let teams;
  try {
    const token = await flow.userToken({ appId: cfg.appId, appSecret: cfg.appSecret, redirectUri: cfg.redirectUri, code: url.searchParams.get('code') });
    const [who, mine] = await Promise.all([flow.me(token), flow.pages(token)]);
    person = who;
    teams = await (await pg('GET', 'engine_teams?select=id,name,accounts')).json();
    rights = E.rightsFromPages(teams, mine);
  } catch (e) {
    console.error(`fb callback: ${e.message}`);
    return flow.page(res, 502, 'Facebook did not complete the connection',
      `<h1>Facebook did not complete the connection</h1><p class="err">${flow.esc(e.message)}</p><p>Try again from the posts desk. If it repeats, tell Chris.</p>`);
  }

  // Signing in to the desk web app: which desk name is this Facebook account?
  // Linked already, or linked now by an admin's invite; otherwise not let in.
  const login = ticket.mode === 'login';
  if (login) {
    try {
      let who = await D.whoForFacebook(person.id);
      if (ticket.invite) {
        const inv = await D.useInvite(ticket.invite, person.id);
        if (inv) { who = inv.who; await D.linkFacebook(who, person.id, person.name); }
        else if (!who) return flow.page(res, 400, 'Invite not valid', '<h1>This invite has been used or has expired</h1><p>Invites work once, for 7 days. Ask a team admin for a new one.</p>');
      }
      if (!who) {
        return flow.page(res, 403, 'Not on the desk yet',
          `<h1>Not on the desk yet</h1><p>Facebook account <strong>${flow.esc(person.name || person.id)}</strong> isn't linked to the Content Engine desk. Ask a team admin for an invite link (Settings › Team and access).</p>`);
      }
      ticket.who = who;
    } catch (e) {
      return flow.page(res, 500, 'Could not sign in', '<h1>Could not sign you in</h1><p>Try again in a minute. If it repeats, tell Chris.</p>');
    }
  }

  const now = new Date().toISOString();
  try {
    if (rights.length) {
      await pg('POST', 'engine_page_tokens?on_conflict=who,account_key',
        rights.map((r) => ({ who: ticket.who, account_key: r.account_key, page_id: r.page_id, ig_id: r.ig_id, sealed: xauth.seal(cfg.publicKey, r.token), connected_at: now })),
        'resolution=merge-duplicates,return=minimal');
      await pg('POST', 'engine_publish_rights?on_conflict=who,account_key',
        rights.map((r) => ({ who: ticket.who, account_key: r.account_key, source: 'meta', checked_at: now })),
        'resolution=merge-duplicates,return=minimal');
    }
    // Access they no longer have on Facebook goes here too. Rights a
    // maintainer added by hand stay until the maintainer removes them.
    const keep = rights.map((r) => r.account_key);
    const not = keep.length ? `&account_key=not.in.${encodeURIComponent(inList(keep))}` : '';
    await pg('DELETE', `engine_page_tokens?who=eq.${encodeURIComponent(ticket.who)}${not}`, undefined, 'return=minimal');
    await pg('DELETE', `engine_publish_rights?who=eq.${encodeURIComponent(ticket.who)}&source=eq.meta${not}`, undefined, 'return=minimal');
    // The Facebook account that connected is this person's sign-in from now on.
    if (!login && person && person.id) await D.linkFacebook(ticket.who, person.id, person.name);
  } catch (e) {
    return flow.page(res, 500, 'Could not save', '<h1>Connected, but saving failed</h1><p>Nothing was changed. Try again from the posts desk in a minute.</p>');
  }

  if (login) {
    const s = await D.createSession({ who: ticket.who, fbUserId: person.id, userAgent: req.headers['user-agent'] });
    res.setHeader('Set-Cookie', ['fb_connect_flow=; Max-Age=0; Path=/api/fb; HttpOnly; Secure; SameSite=Lax', s.cookie]);
    res.statusCode = 302;
    res.setHeader('Location', '/desk/');
    res.setHeader('Cache-Control', 'no-store');
    return res.end();
  }

  const names = (key) => { for (const t of teams) for (const a of t.accounts || []) if (a.key === key) return `${a.name || key} (${t.name})`; return key; };
  return flow.page(res, 200, 'Facebook connected',
    rights.length
      ? `<h1>Connected</h1><p>Facebook account: <strong>${flow.esc(person.name || person.id)}</strong>. You can now approve posts for:</p><ul>${rights.map((r) => `<li>${flow.esc(names(r.account_key))}</li>`).join('')}</ul><p>Go back to the posts desk and reload it.</p>`
      : `<h1>No CitizenGO Pages found</h1><p>Facebook account <strong>${flow.esc(person.name || person.id)}</strong> didn't share any CitizenGO Page you can post to. If you do manage one, connect again and tick it on the Facebook screen, or ask a Page admin to give you posting access.</p>`);
};
