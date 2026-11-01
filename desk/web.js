'use strict';
/* The desk as a web app (Nov 2026). The desk was built as a claude.ai
   artifact and reaches everything through window.claude.use(name); this file
   gives it the same shape on our own site:
   - mcp: engine tools through /api/desk (signed in with Facebook)
   - user: who is signed in
   - db: the desk's shared documents (saved replies, Listening shares,
     Analytics groups, feedback, video requests), polled every 30 seconds
   - downloads: an ordinary browser download
   - sample ("ask Claude"): no paid AI. It shows the prompt, opens claude.ai
     with it filled in, and takes the answer pasted back, so every AI button
     still works with each person's own Claude.
   - room: presence and nudges by a 15-second sync; assets: signed upload
     straight to Supabase storage. */
(function () {
  const api = async (op, { method = 'GET', body, query = '' } = {}) => {
    const r = await fetch(`/api/desk?op=${op}${query}`, {
      method, credentials: 'same-origin',
      headers: method === 'POST' ? { 'Content-Type': 'application/json', 'X-Desk': '1' } : {},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (r.status === 401) { location.href = '/desk/login'; throw Object.assign(new Error('Signed out'), { code: 'not_granted' }); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { code: j.code || 'unavailable' });
    return j;
  };
  let mePromise = null;
  const me = () => (mePromise = mePromise || api('me'));

  const mcp = {
    async callTool(server, tool, input) {
      const j = await api('call', { method: 'POST', body: { tool, input: input || {} } });
      if (j.error) throw Object.assign(new Error(j.error), { code: 'tool_error' });
      return { payload: j.payload, content: [{ type: 'text', text: typeof j.payload === 'string' ? j.payload : JSON.stringify(j.payload) }], isError: j.isError };
    },
  };

  const user = {
    async id() { return (await me()).who; },
    async me() { const m = await me(); return { id: m.who, name: m.name }; },
    async profiles() { return {}; },
    isOwner() { return false; }, canEdit() { return true; },
  };

  // Shared documents: add / set / update, and onSnapshot by polling.
  const watchers = {};
  async function refresh(name) {
    const w = watchers[name]; if (!w || !w.cbs.length) return;
    try {
      const j = await api('docs', { query: `&collection=${encodeURIComponent(name)}` });
      const snap = { docs: j.docs.map((d) => ({ id: d.id, data: () => d })) };
      w.cbs.forEach((cb) => { try { cb(snap); } catch (e) { console.error(e); } });
    } catch (e) { w.errs.forEach((f) => { try { f(e); } catch (x) {} }); }
  }
  const db = {
    collection(name) {
      return {
        async add(data) { const j = await api('docs', { method: 'POST', body: { collection: name, data } }); refresh(name); return { id: j.id }; },
        onSnapshot(cb, err) {
          const w = watchers[name] = watchers[name] || { cbs: [], errs: [], timer: null };
          w.cbs.push(cb); if (err) w.errs.push(err);
          refresh(name);
          if (!w.timer) w.timer = setInterval(() => { if (document.visibilityState === 'visible') refresh(name); }, 30000);
          return () => { w.cbs = w.cbs.filter((f) => f !== cb); };
        },
      };
    },
    doc(path) {
      const [name, id] = String(path).split('/');
      return {
        async set(data) { await api('docs', { method: 'POST', body: { collection: name, id, data } }); refresh(name); },
        async update(data) { await api('docs', { method: 'POST', body: { collection: name, id, data, merge: true } }); refresh(name); },
      };
    },
  };

  const downloads = {
    async save({ filename, data, mimeType }) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: mimeType || 'application/octet-stream' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename || 'download';
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      return { ok: true };
    },
  };

  // "Ask Claude": the prompt goes to claude.ai in a new tab; the answer comes back by paste.
  function askClaude(prompt) {
    const text = typeof prompt === 'string' ? prompt : (Array.isArray(prompt) ? prompt.map((t) => t.content).join('\n\n') : String(prompt));
    return new Promise((resolve, reject) => {
      const box = document.createElement('div');
      box.className = 'askc';
      box.innerHTML = `<div class="askcbox" role="dialog" aria-modal="true" aria-label="Ask Claude">
        <b>Ask Claude</b>
        <p class="src">1. Open Claude with the request filled in (or copy it). 2. Paste Claude's answer below. 3. Use it.</p>
        <textarea class="askcp" readonly rows="5"></textarea>
        <div class="ibacts"><button class="btn small primary" data-k="open">Open Claude ↗</button><button class="btn small" data-k="copy">Copy the request</button></div>
        <textarea class="askca" rows="6" placeholder="Paste Claude's answer here"></textarea>
        <div class="ibacts"><button class="btn small primary" data-k="use">Use this answer</button><button class="btn small" data-k="cancel">Cancel</button></div>
      </div>`;
      box.querySelector('.askcp').value = text;
      const done = (fn) => { box.remove(); fn(); };
      box.addEventListener('click', async (ev) => {
        const k = ev.target.closest('[data-k]') && ev.target.closest('[data-k]').dataset.k;
        if (k === 'open') {
          try { await navigator.clipboard.writeText(text); } catch (e) {}
          const u = 'https://claude.ai/new?q=' + encodeURIComponent(text);
          window.open(u.length < 7500 ? u : 'https://claude.ai/new', '_blank', 'noopener');
          if (u.length >= 7500) ev.target.textContent = 'Opened: paste the request (copied)';
        } else if (k === 'copy') {
          try { await navigator.clipboard.writeText(text); ev.target.textContent = 'Copied'; } catch (e) { box.querySelector('.askcp').select(); }
        } else if (k === 'use') {
          const a = box.querySelector('.askca').value.trim();
          if (!a) { box.querySelector('.askca').focus(); return; }
          done(() => resolve({ text: a, truncated: false }));
        } else if (k === 'cancel') done(() => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })));
      });
      document.body.appendChild(box);
      box.querySelector('[data-k="open"]').focus();
    });
  }
  const sample = Object.assign((input) => askClaude(input), {
    async json(input) { const r = await askClaude(input); return JSON.parse(String(r.text).replace(/^```(?:json)?|```$/g, '').trim()); },
    async limits() { return { images: false }; },
  });

  // Photo upload: a signed link from the desk API, then straight to storage.
  const assets = {
    async upload(file) {
      const s = await api('upload', { method: 'POST', body: { type: file.type, size: file.size } });
      const r = await fetch(s.upload_url, { method: 'PUT', headers: { 'Content-Type': file.type, 'x-upsert': 'false' }, body: file });
      if (!r.ok) throw Object.assign(new Error('Upload failed'), { code: r.status === 413 ? 'too_large' : 'upload_failed' });
      return { id: s.id, url: s.url, sizeBytes: file.size, contentType: file.type };
    },
  };
  const invite = (body) => api('invite', { method: 'POST', body });

  // Presence and nudges: one sync every 15 seconds while the desk is visible.
  const room = (() => {
    let state = {}, after = null, timer = null;
    const peerFns = [], topicFns = {};
    async function sync() {
      try {
        const j = await api('presence', { method: 'POST', body: { state, after } });
        after = j.last_id;
        peerFns.forEach((f) => { try { f(j.peers); } catch (e) {} });
        for (const e of j.events) (topicFns[e.topic] || []).forEach((f) => { try { f(e.data, { by: e.by }); } catch (x) {} });
      } catch (e) {}
    }
    function start() { if (!timer) { sync(); timer = setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 15000); } }
    return {
      presence(patch) { state = { ...state, ...(patch || {}) }; start(); clearTimeout(room._t); room._t = setTimeout(sync, 400); },
      onPeers(fn) { peerFns.push(fn); start(); return () => {}; },
      on(topic, fn) { (topicFns[topic] = topicFns[topic] || []).push(fn); start(); return () => {}; },
      emit(topic, data) { api('emit', { method: 'POST', body: { topic, data } }).catch(() => {}); },
    };
  })();

  const caps = { mcp, user, db, downloads, sample, room, assets };
  window.claude = { use: async (name) => (name in caps ? caps[name] : null) };
  window.DESK_WEB = true;
  window.deskInvite = invite;
  window.deskFile = (name) => api('file', { query: `&name=${encodeURIComponent(name)}` });
  window.deskSignOut = async () => { try { await api('logout', { method: 'POST' }); } catch (e) {} location.href = '/desk/login'; };
})();
