'use strict';
// The desk web app's API (/desk). Signed in with a desk session (lib/desk.js),
// it runs the same engine tools the claude.ai connector runs, as that person.
//
//   GET  /api/desk?op=me                       who is signed in (401 if nobody)
//   POST /api/desk?op=call   {tool, input}     one engine tool -> {payload}
//   GET  /api/desk?op=docs&collection=…&team=… the desk's shared documents
//   POST /api/desk?op=docs   {collection, id?, data, merge?}
//   POST /api/desk?op=invite {who, team_id, role}   team admins: a sign-in link
//   POST /api/desk?op=logout
//
// Every POST must come from the desk's own page (Origin + X-Desk header), so
// another site can't use someone's session.

const D = require('../lib/desk');
const { supabaseStore } = require('../lib/store');
const { callTool } = require('../mcp/tools');
const E = require('../lib/engine');

// What the desk may call: the tools the artifact declared, nothing else.
const DESK_TOOLS = new Set(['engine_me', 'engine_posts', 'engine_save', 'engine_status', 'engine_calendar', 'engine_requests', 'engine_request',
  'engine_evergreen', 'engine_evergreen_update', 'engine_connect', 'engine_media', 'engine_pause', 'engine_video', 'engine_inbox', 'engine_inbox_act',
  'engine_inbox_undo', 'engine_inbox_history', 'engine_inbox_person', 'engine_inbox_posts', 'engine_inbox_rules', 'engine_inbox_rule', 'engine_inbox_alert',
  'engine_inbox_bulk', 'engine_analytics', 'engine_listening', 'engine_automations', 'engine_automation', 'engine_access', 'page_inviter_usage']);

function send(res, status, body, cookie) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (cookie) res.setHeader('Set-Cookie', cookie);
  res.end(JSON.stringify(body));
}
function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 12e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (e) { resolve(null); } });
  });
}
function store() {
  return supabaseStore({ url: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_KEY });
}

module.exports = async (req, res) => {
  const url = new URL(req.url, 'https://placeholder.invalid');
  const op = url.searchParams.get('op') || '';
  if (req.method === 'POST' && !D.sameOrigin(req)) return send(res, 403, { error: 'Not from the desk.' });

  let session;
  try { session = await D.readSession(req); } catch (e) { return send(res, 503, { error: 'The desk database is not reachable.' }); }
  if (op === 'logout' && req.method === 'POST') { const out = await D.endSession(req); return send(res, 200, { ok: true }, out.cookie); }
  if (!session) return send(res, 401, { error: 'Sign in with Facebook first.', code: 'SIGNED_OUT' });
  const who = session.who;

  try {
    if (op === 'me' && req.method === 'GET') {
      const people = await D.pg('GET', `engine_people?select=who,initials,fb_name&who=eq.${encodeURIComponent(who)}`);
      return send(res, 200, { who, name: (people[0] && people[0].fb_name) || who, initials: (people[0] && people[0].initials) || null });
    }
    if (op === 'call' && req.method === 'POST') {
      const body = await readBody(req);
      const tool = body && String(body.tool || '');
      if (!DESK_TOOLS.has(tool)) return send(res, 400, { error: `The desk can't call ${tool || 'that'}.`, code: 'tool_error' });
      try {
        const t0 = Date.now();
        const out = await callTool(store(), tool, (body && body.input) || {}, { who });
        console.log(JSON.stringify({ at: new Date().toISOString(), who, tool, ms: Date.now() - t0, event: 'desk/call' }));
        let payload = out.text;
        if (out.raw) { try { payload = JSON.parse(out.text); } catch (e) { payload = out.text; } }
        return send(res, 200, { payload, isError: !!out.isError });
      } catch (e) {
        return send(res, 200, { error: e.message, code: 'tool_error', detail: e.code || null });
      }
    }
    if (op === 'docs') {
      if (req.method === 'GET') {
        const rows = await D.docsList(url.searchParams.get('collection'), { team: url.searchParams.get('team') || undefined });
        return send(res, 200, { docs: rows.map((r) => ({ id: r.id, ...r.data })) });
      }
      if (req.method === 'POST') {
        const body = (await readBody(req)) || {};
        const out = await D.docsPut(String(body.collection || ''), body.id, body.data, who, { merge: !!body.merge });
        return send(res, 200, { ok: true, id: out.id });
      }
    }
    if (op === 'file' && req.method === 'GET') {
      try { return send(res, 200, await D.fileLink(String(url.searchParams.get('name') || ''))); }
      catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }
    if (op === 'presence' && req.method === 'POST') {
      const body = (await readBody(req)) || {};
      return send(res, 200, await D.presenceSync({ idHash: session.idHash, who, name: body.state && body.state.name, state: body.state, after: body.after }));
    }
    if (op === 'emit' && req.method === 'POST') {
      const body = (await readBody(req)) || {};
      await D.emitEvent({ topic: String(body.topic || ''), data: body.data, by: who });
      return send(res, 200, { ok: true });
    }
    if (op === 'upload' && req.method === 'POST') {
      const body = (await readBody(req)) || {};
      try { return send(res, 200, await D.signedUpload({ type: String(body.type || ''), size: Number(body.size) })); }
      catch (e) { return send(res, e.status || 500, { error: e.message, code: e.code || null }); }
    }
    if (op === 'invite' && req.method === 'POST') {
      const body = (await readBody(req)) || {};
      const team = String(body.team_id || '');
      const members = await D.pg('GET', `engine_members?select=team_id,role&who=eq.${encodeURIComponent(who)}`);
      const admin = E.isMaintainer(who) || members.some((m) => m.team_id === team && m.role === 'admin');
      if (!admin) return send(res, 403, { error: "Only the team's admins can invite people." });
      const name = String(body.who || '').trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9._-]{1,40}$/.test(name)) return send(res, 400, { error: 'Give the desk name: letters, numbers, dots or dashes (e.g. tobias).' });
      const inv = await D.createInvite({ who: name, team_id: team, role: body.role, by: who });
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      return send(res, 200, { ok: true, link: `https://${host}/desk/login?invite=${inv.code}`, expires_at: inv.expires_at });
    }
    return send(res, 404, { error: 'Unknown request.' });
  } catch (e) {
    return send(res, e.status && e.status < 500 ? e.status : 500, { error: e.message });
  }
};
