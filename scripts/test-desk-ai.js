#!/usr/bin/env node
'use strict';
// Desk AI end to end: a desk AI button (desk/web.js's sample) files a request
// through the desk API, the Desk AI page (desk/ai-helper.html) picks it up with
// the engine_ai_job tool, asks "Claude" and saves the answer, and the desk's
// poll hands it back to the button. The real desk.js API, engine_ai_job tool,
// web.js and helper script run here; only the database (a tiny PostgREST),
// the browser and Claude are fakes.
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test-key';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const D = require('../lib/desk');
const deskApi = require('../api/desk');
const { callTool } = require('../mcp/tools');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`          expected ${JSON.stringify(want)}\n          got      ${JSON.stringify(got)}`);
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await tick(5); }
  throw new Error(`timed out waiting for ${what}`);
}

// ---- The database: PostgREST filters the desk uses (eq, in, gt, order, limit).
const db = { engine_desk_sessions: [], engine_people: [{ who: 'chris', fb_name: 'Chris' }, { who: 'tobias' }], engine_ai_jobs: [] };
function filt(rows, params) {
  let out = rows.filter((r) => [...params].every(([k, v]) => {
    if (['select', 'order', 'limit'].includes(k)) return true;
    if (v.startsWith('eq.')) return String(r[k]) === v.slice(3);
    if (v.startsWith('gt.')) return String(r[k]) > v.slice(3);
    if (v.startsWith('in.(')) return v.slice(4, -1).split(',').includes(String(r[k]));
    return true;
  }));
  const order = params.get('order');
  if (order) { const [col, dir] = order.split('.'); out = out.slice().sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (dir === 'desc' ? -1 : 1)); }
  if (params.get('limit')) out = out.slice(0, Number(params.get('limit')));
  return out;
}
let clock = 0;
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = new URL(url); const table = u.pathname.split('/').pop(); const rows = db[table];
  if (!rows) return realFetch(url, opts);
  const body = opts.body ? JSON.parse(opts.body) : null; const prefer = (opts.headers && opts.headers.Prefer) || '';
  let out = [];
  if (opts.method === 'GET') out = filt(rows, u.searchParams);
  else if (opts.method === 'POST') {
    for (const b of [].concat(body)) {
      // The table's defaults (status queued, created_at now), in order of filing.
      const row = table === 'engine_ai_jobs' ? { status: 'queued', text: null, error: null, created_at: new Date(Date.now() + clock++).toISOString(), done_at: null, ...b } : b;
      rows.push(row); out.push(row);
    }
  } else if (opts.method === 'PATCH') { out = filt(rows, u.searchParams); out.forEach((r) => Object.assign(r, body)); }
  else if (opts.method === 'DELETE') { const gone = filt(rows, u.searchParams); db[table] = rows.filter((r) => !gone.includes(r)); out = gone; }
  return { ok: true, status: 200, text: async () => (prefer.includes('minimal') ? '' : JSON.stringify(out)) };
};

// ---- The desk API, called as the browser would call /api/desk.
const HOST = 'meta-organic-reporting.vercel.app';
async function apiCall(cookie, pathAndQuery, opts = {}) {
  const method = opts.method || 'GET';
  // Node hands handlers lower-case header names.
  const headers = { cookie, host: HOST };
  for (const [k, v] of Object.entries(opts.headers || {})) headers[k.toLowerCase()] = v;
  if (method === 'POST') headers.origin = `https://${HOST}`;
  const req = { method, url: pathAndQuery, headers, body: opts.body ? JSON.parse(opts.body) : undefined };
  const res = await new Promise((resolve) => {
    const r = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(s) { resolve({ status: this.statusCode, body: s }); } };
    deskApi(req, r);
  });
  return { ok: res.status < 400, status: res.status, json: async () => JSON.parse(res.body) };
}

// ---- A tiny DOM: enough for web.js's dialogs and the helper page.
function el(extra = {}) {
  const parts = {}, fns = [];
  return Object.assign({
    hidden: false, textContent: '', className: '', value: '', innerHTML: '',
    querySelector(sel) { return (parts[sel] = parts[sel] || el()); },
    addEventListener(type, fn) { fns.push(fn); },
    click(k) { fns.forEach((f) => f({ target: { textContent: '', closest: () => ({ dataset: { k } }) } })); },
    focus() {}, select() {}, remove() { this.removed = true; },
  }, extra);
}

// The desk tab: desk/web.js with a signed-in cookie. window.open is the
// browser's new tab; pointing it at the Desk AI link opens the helper there.
const webSrc = fs.readFileSync(path.join(__dirname, '../desk/web.js'), 'utf8');
function deskTab(cookie, helperFor) {
  const boxes = [], tabs = [];
  const win = {
    DESK_AI_HELPER: 'https://claude.ai/artifact/XrdkfXNRYiSoCQtFghpaai',
    location: { href: '/desk' },
    open(url) {
      const tab = { url, closed: false, close() { this.closed = true; }, location: {} };
      let href = url;
      Object.defineProperty(tab.location, 'href', { get: () => href, set: (v) => { href = v; tab.url = v; if (helperFor) helperFor(v, tab); } });
      tabs.push(tab); return tab;
    },
  };
  const document = { visibilityState: 'visible', createElement: () => { const b = el(); boxes.push(b); return b; }, body: { appendChild() {} } };
  const ctx = vm.createContext({
    window: win, document, console, JSON, Object, Promise, Error, Date, Array, String, URL, Blob,
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: (u, o) => apiCall(cookie, u, o), location: win.location,
    // The desk polls every 2 seconds; here, every few milliseconds.
    setTimeout: (f, ms) => setTimeout(f, Math.min(ms, 5)), setInterval: () => 0, clearTimeout,
  });
  vm.runInContext(webSrc, ctx);
  const use = (name) => win.claude.use(name);
  return { win, boxes, tabs, use, openBox: () => boxes.filter((b) => !b.removed).pop() };
}

// The Desk AI page: desk/ai-helper.html's script with the viewer's connector
// (the real engine_ai_job tool, as claude.ai's mcp hands back its payload) and
// a fake Claude.
const helperHtml = fs.readFileSync(path.join(__dirname, '../desk/ai-helper.html'), 'utf8');
const helperSrc = helperHtml.slice(helperHtml.indexOf('<script>') + 8, helperHtml.lastIndexOf('</script>'));
const connector = (who) => ({
  async callTool(server, tool, input) {
    if (server !== 'CitizenGO Organic Meta' || tool !== 'engine_ai_job') throw Object.assign(new Error('not granted'), { code: 'not_granted' });
    const out = await callTool(null, tool, input, { who });
    let payload; try { payload = JSON.parse(out.text); } catch (e) { payload = out.text; }
    return { content: [{ type: 'text', text: out.text }], payload };
  },
});
function helperPage(url, { who = 'chris', claude }) {
  const els = {};
  const document = { querySelector: (s) => (els[s] = els[s] || el()) };
  const hash = url.includes('#') ? url.slice(url.indexOf('#')) : '';
  const asked = [];
  const sample = async (prompt, opts) => { asked.push(prompt); const text = await claude(prompt); if (opts && opts.onText) opts.onText({ text, delta: text }); return { text, truncated: false }; };
  const win = { claude: { use: async (n) => (n === 'mcp' ? connector(who) : n === 'sample' ? sample : null) }, close() { page.closed = true; } };
  const ctx = vm.createContext({ window: win, document, location: { hash }, console, JSON, Object, Promise, Error, String, setTimeout: (f) => setTimeout(f, 0) });
  const page = { els, asked, closed: false, state: () => (els['#state'] && els['#state'].textContent) || '', retry: () => els['#retry'].click() };
  vm.runInContext(helperSrc, ctx);
  return page;
}

process.on('beforeExit', () => { if (!done) { console.error('FAIL  the test stopped waiting on something that never happened'); process.exitCode = 1; } });
let done = false;
setTimeout(() => { console.error(`FAIL  still waiting after 30 seconds (${pass} passed so far)`); process.exit(1); }, 30000).unref();
(async () => {
  const s1 = await D.createSession({ who: 'chris', fbUserId: 'fb1', userAgent: 'test' });
  const chris = `cgo_desk=${s1.cookie.split(';')[0].split('=')[1]}`;
  const s2 = await D.createSession({ who: 'tobias', fbUserId: 'fb2', userAgent: 'test' });
  const tobias = `cgo_desk=${s2.cookie.split(';')[0].split('=')[1]}`;

  // 1. A JSON button (Draft with Claude): Claude answers with a sentence and a fenced block.
  let page = null;
  const answer = 'Here are three replies:\n```json\n{"replies":[{"label":"Public reply","text":"Thank you!"}]}\n```';
  const desk = deskTab(chris, (url) => { page = helperPage(url, { claude: async () => answer }); });
  const sample = await desk.use('sample');
  const prompt = 'Write three short alternative replies. Answer only with JSON: {"replies":[...]}';
  const got = await sample.json(prompt, { modelTier: 'default' });
  const job = db.engine_ai_jobs[0];
  eq('the button gets the parsed answer back', got, { replies: [{ label: 'Public reply', text: 'Thank you!' }] });
  eq('one request was filed for the clicker, with the prompt', [db.engine_ai_jobs.length, job.who, job.prompt], [1, 'chris', prompt]);
  eq('the tab opened at the click and was pointed at the request', [desk.tabs.length, desk.tabs[0].url], [1, `https://claude.ai/artifact/XrdkfXNRYiSoCQtFghpaai#${job.id}`]);
  eq('the helper asked Claude the same prompt and saved the answer', [page.asked, job.status, job.text, !!job.done_at], [[prompt], 'done', answer, true]);
  eq('the helper says it is done and closes itself', [page.state(), await until(() => page.closed, 'helper close')], ['Done: the answer is on the desk. You can close this tab.', true]);
  eq('the waiting dialog is gone', desk.boxes.every((b) => b.removed), true);

  // 2. While a request waits, the desk sees it unanswered; nobody else sees it at all.
  const id2 = (await (await apiCall(chris, '/api/desk?op=aijob', { method: 'POST', headers: { 'x-desk': '1' }, body: JSON.stringify({ prompt: 'Say hi' }) })).json()).id;
  const poll = await (await apiCall(chris, `/api/desk?op=aijob&id=${id2}`)).json();
  eq('a new request reads back queued, with no text yet', [poll.status, poll.text], ['queued', null]);
  eq('another person gets 404 from the desk API', (await apiCall(tobias, `/api/desk?op=aijob&id=${id2}`)).status, 404);
  const other = await callTool(null, 'engine_ai_job', { action: 'get', id: id2 }, { who: 'tobias' });
  const otherDone = await callTool(null, 'engine_ai_job', { action: 'complete', id: id2, text: 'hijack' }, { who: 'tobias' });
  eq("another person's connector can't read or answer it", [JSON.parse(other.text).ok, JSON.parse(otherDone.text).ok, db.engine_ai_jobs[1].status], [false, false, 'queued']);
  eq('a bad id is refused', JSON.parse((await callTool(null, 'engine_ai_job', { action: 'get', id: '../x' }, { who: 'chris' })).text).error, 'That request id is not valid.');
  eq('an empty request is refused by the API', (await apiCall(chris, '/api/desk?op=aijob', { method: 'POST', headers: { 'x-desk': '1' }, body: JSON.stringify({ prompt: '  ' }) })).status, 400);
  eq('a POST from another site is refused', (await apiCall(chris, '/api/desk?op=aijob', { method: 'POST', body: JSON.stringify({ prompt: 'x' }) })).status, 403);

  // 3. The helper opened without the #id (next): it takes the newest unanswered request.
  const bare = helperPage('https://claude.ai/artifact/XrdkfXNRYiSoCQtFghpaai', { claude: async () => 'hi' });
  await until(() => db.engine_ai_jobs[1].status === 'done', 'next request answered');
  eq('without an id the helper answers the newest waiting request', [bare.asked, db.engine_ai_jobs[1].text], [['Say hi'], 'hi']);
  const none = helperPage('https://claude.ai/artifact/XrdkfXNRYiSoCQtFghpaai', { claude: async () => 'x' });
  await until(() => none.state().startsWith('No request'), 'nothing waiting');
  eq('with nothing waiting it says so', none.asked.length, 0);
  // Opened without an id, failed, then a newer request arrives: Try again stays on the first.
  const idA = (await (await apiCall(chris, '/api/desk?op=aijob', { method: 'POST', headers: { 'x-desk': '1' }, body: JSON.stringify({ prompt: 'First' }) })).json()).id;
  let busyA = true;
  const bareA = helperPage('https://claude.ai/artifact/XrdkfXNRYiSoCQtFghpaai', { claude: async (p) => { if (busyA) throw new Error('busy'); return `answer to ${p}`; } });
  await until(() => db.engine_ai_jobs.find((j) => j.id === idA).status === 'failed', 'first request failed');
  const idB = (await (await apiCall(chris, '/api/desk?op=aijob', { method: 'POST', headers: { 'x-desk': '1' }, body: JSON.stringify({ prompt: 'Second' }) })).json()).id;
  busyA = false; bareA.retry();
  await until(() => db.engine_ai_jobs.find((j) => j.id === idA).status === 'done', 'first request answered');
  eq('Try again answers the request the page picked, not a newer one', [db.engine_ai_jobs.find((j) => j.id === idA).text, db.engine_ai_jobs.find((j) => j.id === idB).status], ['answer to First', 'queued']);
  db.engine_ai_jobs.find((j) => j.id === idB).status = 'done';
  eq('an answered request is not answered twice', JSON.parse((await callTool(null, 'engine_ai_job', { action: 'complete', id: id2, text: 'again' }, { who: 'chris' })).text).error, 'This request is already done.');

  // 4. Claude fails (out of messages), the desk shows why, then Try again works.
  let busy = true, page4 = null;
  const desk4 = deskTab(chris, (url) => { page4 = helperPage(url, { claude: async () => { if (busy) throw Object.assign(new Error('busy'), { code: 'rate_limited' }); return 'Second time lucky'; } }); });
  const p4 = (await desk4.use('sample'))('Rewrite this caption');
  const job4 = await until(() => db.engine_ai_jobs.find((j) => j.prompt === 'Rewrite this caption' && j.status === 'failed'), 'failed request');
  const msg = await until(() => { const b = desk4.openBox(); const t = b && b.querySelector('[data-k="msg"]').textContent; return t && t.startsWith('Your Claude is busy') && t; }, 'desk failure message');
  eq('a failure is saved and shown on the desk', [job4.error, msg], ['Your Claude is busy or out of messages for now. Try again in a while.', 'Your Claude is busy or out of messages for now. Try again in a while. Try again from the Desk AI tab, or copy and paste instead.']);
  busy = false; page4.retry();
  eq('after Try again the desk gets the answer', await p4, { text: 'Second time lucky', truncated: false });

  // 5. Cancel, and copy-and-paste instead.
  const desk5 = deskTab(chris, null);
  const s5 = await desk5.use('sample');
  const p5 = s5('Cancel me').then(() => 'resolved', (e) => e.code);
  await until(() => desk5.openBox(), 'waiting dialog'); desk5.openBox().click('cancel');
  eq('Cancel rejects with cancelled', await p5, 'cancelled');
  const p6 = s5.json('Paste me');
  await until(() => desk5.openBox(), 'waiting dialog'); desk5.openBox().click('manual');
  const paste = await until(() => { const b = desk5.openBox(); return b && b.innerHTML.includes('Ask Claude') && b; }, 'paste dialog');
  paste.querySelector('.askca').value = 'Sure! {"ok": true} Hope that helps.';
  paste.click('use');
  eq('copy and paste instead takes the pasted answer (JSON with a sentence around it)', await p6, { ok: true });

  // 6. Answers that aren't JSON, and a request the API can't file.
  const desk7 = deskTab(chris, (url) => helperPage(url, { claude: async () => 'Sorry, I cannot help with that.' }));
  const e7 = await (await desk7.use('sample')).json('Give JSON').then(() => null, (e) => [e.code, e.text]);
  eq("an answer that isn't JSON rejects invalid_json with the reply", e7, ['invalid_json', 'Sorry, I cannot help with that.']);
  const desk8 = deskTab(chris, null);
  const p8 = (await desk8.use('sample'))([{ role: 'user', content: [{ type: 'text', text: '' }] }]);
  const box8 = await until(() => { const b = desk8.openBox(); return b && b.innerHTML.includes('Ask Claude') && b; }, 'fallback dialog');
  eq('if the request cannot be filed, the blank tab closes and copy-paste opens', [desk8.tabs[0].closed, !!box8], [true, true]);
  box8.querySelector('.askca').value = 'by hand'; box8.click('use');
  eq('message-list prompts work too', await p8, { text: 'by hand', truncated: false });

  done = true;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
