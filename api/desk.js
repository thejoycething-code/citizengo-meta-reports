'use strict';
// The desk web app's API (/desk). Signed in with a desk session (lib/desk.js),
// it runs the same engine tools the claude.ai connector runs, as that person.
//
//   GET  /api/desk?op=me                       who is signed in (401 if nobody)
//   POST /api/desk?op=call   {tool, input}     one engine tool -> {payload}
//   GET  /api/desk?op=docs&collection=…&team=… the desk's shared documents
//   POST /api/desk?op=docs   {collection, id?, data, merge?}
//   POST /api/desk?op=invite {who, team_id, role}   team admins: a sign-in link
//   GET  /api/desk?op=img&u=…                 one of our Instagram/Facebook pictures (for saving the grid)
//   POST /api/desk?op=fromlink {url}          a picture from a Canva, Drive or public link, kept in desk-assets
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
  'engine_inbox_undo', 'engine_inbox_history', 'engine_inbox_team', 'engine_ig_grid', 'engine_bio', 'engine_parliament', 'engine_inbox_person', 'engine_inbox_posts', 'engine_inbox_rules', 'engine_inbox_rule', 'engine_inbox_alert',
  'engine_inbox_bulk', 'engine_analytics', 'engine_listening', 'engine_automations', 'engine_automation', 'engine_access', 'page_inviter_usage', 'engine_inviter', 'engine_links', 'engine_health', 'engine_preview', 'engine_trash',
  'engine_create', 'engine_inbox_check', 'engine_prefs', 'engine_bell', 'engine_inbox_post', 'engine_inbox_similar', 'engine_benchmark', 'engine_house_rules', 'engine_report', 'engine_signups']);

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
        let input = (body && body.input) || {};
        // New post (3 Nov): the desk only starts a blank post in Review for one of the person's
        // teams; it never picks the id or claims to be a copy of another post.
        if (tool === 'engine_create') input = { team: input.team, doc: input.doc };
        const out = await callTool(store(), tool, input, { who });
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
    if (op === 'aijob') {
      if (req.method === 'POST') { const body = (await readBody(req)) || {}; return send(res, 200, await D.aiJobCreate(who, body.prompt)); }
      const job = await D.aiJobGet(String(url.searchParams.get('id') || ''), who);
      if (!job) return send(res, 404, { error: 'No such request.' });
      return send(res, 200, { id: job.id, status: job.status, text: job.status === 'done' ? job.text : null, error: job.error || null });
    }
    // 16 (Priority Two, 3 Nov): our own Instagram and Facebook pictures, fetched
    // for the signed-in desk so the grid can be saved as one image (the CDNs
    // send no CORS headers, so the browser can't draw them into a picture).
    // Meta's picture hosts only, images only, 6 MB at most.
    if (op === 'img' && req.method === 'GET') {
      let u;
      try { u = new URL(String(url.searchParams.get('u') || '')); } catch (e) { return send(res, 400, { error: 'Bad picture address.' }); }
      if (u.protocol !== 'https:' || !/(^|\.)(cdninstagram\.com|fbcdn\.net)$/i.test(u.hostname)) return send(res, 400, { error: 'Only Instagram and Facebook pictures.' });
      const r = await fetch(u.toString(), { redirect: 'follow' }).catch(() => null);
      const type = r && r.headers.get('content-type') || '';
      if (!r || !r.ok || !/^image\//.test(type)) return send(res, 502, { error: 'Picture not available.' });
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 6e6) return send(res, 413, { error: 'Picture too big.' });
      res.statusCode = 200; res.setHeader('Content-Type', type); res.setHeader('Cache-Control', 'private, max-age=3600');
      return res.end(buf);
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
    // 41C (Priority Three, 4 Nov): a picture from a Canva, Drive or other public link, kept like an upload.
    if (op === 'fromlink' && req.method === 'POST') {
      const body = (await readBody(req)) || {};
      try { return send(res, 200, await require('../lib/fromlink').saveFromLink(String(body.url || ''))); }
      catch (e) { return send(res, e.status && e.status < 500 ? 200 : 502, { ok: false, error: e.message }); }
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
