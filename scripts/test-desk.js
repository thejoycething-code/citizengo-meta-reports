#!/usr/bin/env node
'use strict';
// The desk web app: sessions, invites, the same-origin check and the API's
// tool allow-list, against a fake PostgREST.
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test-key';
const D = require('../lib/desk');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`          expected ${JSON.stringify(want)}\n          got      ${JSON.stringify(got)}`);
}

// A tiny PostgREST: tables of rows, eq / is.null / neq filters, upserts.
const db = { engine_desk_sessions: [], engine_desk_invites: [], engine_people: [{ who: 'chris', fb_user_id: 'fb1' }], engine_members: [], engine_desk_docs: [] };
function filt(rows, params) {
  return rows.filter((r) => [...params].every(([k, v]) => {
    if (['select', 'order', 'limit', 'on_conflict', 'or'].includes(k)) return true;
    if (v.startsWith('eq.')) return String(r[k]) === v.slice(3);
    if (v.startsWith('neq.')) return String(r[k]) !== v.slice(4);
    if (v === 'is.null') return r[k] == null;
    return true;
  }));
}
global.fetch = async (url, opts = {}) => {
  const u = new URL(url); const table = u.pathname.split('/').pop(); const rows = db[table];
  const body = opts.body ? JSON.parse(opts.body) : null; const prefer = (opts.headers && opts.headers.Prefer) || '';
  let out = [];
  if (opts.method === 'GET') out = filt(rows, u.searchParams);
  else if (opts.method === 'POST') {
    for (const b of [].concat(body)) {
      const key = u.searchParams.get('on_conflict');
      const keys = key ? key.split(',') : null;
      const i = keys ? rows.findIndex((r) => keys.every((k) => r[k] === b[k])) : -1;
      if (i >= 0) { if (!prefer.includes('ignore')) rows[i] = { ...rows[i], ...b }; } else rows.push({ ...b });
      out.push(b);
    }
  } else if (opts.method === 'PATCH') { out = filt(rows, u.searchParams); out.forEach((r) => Object.assign(r, body)); }
  else if (opts.method === 'DELETE') { const gone = filt(rows, u.searchParams); db[table] = rows.filter((r) => !gone.includes(r)); out = gone; }
  return { ok: true, status: 200, text: async () => (prefer.includes('minimal') ? '' : JSON.stringify(out)) };
};
const reqWith = (cookie, headers = {}) => ({ headers: { cookie, ...headers } });

(async () => {
  const s = await D.createSession({ who: 'chris', fbUserId: 'fb1', userAgent: 'test' });
  const value = s.cookie.split(';')[0].split('=')[1];
  eq('session cookie is HttpOnly, Secure, SameSite=Lax, 30 days; only its hash is stored',
    [/HttpOnly/.test(s.cookie), /Secure/.test(s.cookie), /SameSite=Lax/.test(s.cookie), /Max-Age=2592000/.test(s.cookie), db.engine_desk_sessions[0].id_hash === D.sha(value), db.engine_desk_sessions[0].id_hash !== value],
    [true, true, true, true, true, true]);
  eq('a session reads back as its person; a wrong or missing cookie as nobody', [
    (await D.readSession(reqWith(`cgo_desk=${value}`))).who, await D.readSession(reqWith('cgo_desk=nope-nope-nope-nope-nope')), await D.readSession(reqWith('')),
  ], ['chris', null, null]);
  db.engine_desk_sessions[0].expires_at = new Date(Date.now() - 1000).toISOString();
  eq('an expired session is nobody', await D.readSession(reqWith(`cgo_desk=${value}`)), null);
  await D.endSession(reqWith(`cgo_desk=${value}`));
  eq('signing out deletes the session', db.engine_desk_sessions.length, 0);

  eq('a linked Facebook account finds its desk name; others none', [await D.whoForFacebook('fb1'), await D.whoForFacebook('fb9')], ['chris', null]);
  const inv = await D.createInvite({ who: 'tobias', team_id: 'uk', role: 'editor', by: 'chris' });
  const used = await D.useInvite(inv.code, 'fb2');
  const again = await D.useInvite(inv.code, 'fb3');
  eq('an invite works once and adds the person to its team', [used && used.who, again, db.engine_members.map((m) => [m.team_id, m.who, m.role])], ['tobias', null, [['uk', 'tobias', 'editor']]]);
  const old = await D.createInvite({ who: 'sam', team_id: 'uk', by: 'chris' }, Date.now() - 8 * 864e5);
  eq('an invite older than 7 days is refused', await D.useInvite(old.code, 'fb4'), null);
  await D.linkFacebook('tobias', 'fb1', 'Ignacio');
  eq('one Facebook account belongs to one desk name', db.engine_people.map((p) => [p.who, p.fb_user_id]), [['chris', null], ['tobias', 'fb1']]);

  eq('only the desk page may POST (origin + header)', [
    D.sameOrigin({ headers: { origin: 'https://x.vercel.app', host: 'x.vercel.app', 'x-desk': '1' } }),
    D.sameOrigin({ headers: { origin: 'https://evil.example', host: 'x.vercel.app', 'x-desk': '1' } }),
    D.sameOrigin({ headers: { origin: 'https://x.vercel.app', host: 'x.vercel.app' } }),
    D.sameOrigin({ headers: { host: 'x.vercel.app', 'x-desk': '1' } }),
  ], [true, false, false, false]);
  await D.docsPut('savedReplies', null, { team: 'uk', title: 'Thanks', text: 'Thank you!' }, 'chris');
  const r = await D.docsPut('videoRequests', 'd1-o1', { status: 'requested' }, 'chris');
  await D.docsPut('videoRequests', 'd1-o1', { status: 'done' }, 'bot', { merge: true });
  eq('shared documents: known collections only; merge keeps fields', [
    await D.docsPut('secrets', null, {}, 'chris').then(() => 'ok', (e) => e.status), db.engine_desk_docs.length, r.id, db.engine_desk_docs.find((d) => d.id === 'd1-o1').data.status,
  ], [400, 2, 'd1-o1', 'done']);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
