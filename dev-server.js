#!/usr/bin/env node
'use strict';
// Local dev server. Serves index.html and the same /api/posts and /api/pages
// contract as the Vercel functions, but backed by data/*.ndjson via fileStore.
//
// This exists so the dashboard can be built and verified against real collected
// data before any Supabase credentials exist. It deliberately does NOT share a
// code path with api/*.js for the data source — those require Supabase and fail
// loudly without it — but it DOES share lib/shape.js, so what renders here is
// shaped by exactly the same logic that will run in production.
//
// Localhost only. No auth. Never deploy this file.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { fileStore } = require('./lib/store');
const { shapeFeed, shapePages } = require('./lib/shape');

const PORT = Number(process.env.PORT || 4321);
const store = fileStore({ dir: path.join(__dirname, 'data') });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  try {
    if (url.pathname === '/api/posts') {
      const data = await store.loadAll();
      return send(200, shapeFeed(data, {
        page_id: url.searchParams.get('page_id') || undefined,
        since: url.searchParams.get('since') || undefined,
        sort: url.searchParams.get('sort') || undefined,
        limit: url.searchParams.get('limit') || 500,
        with_metrics_only: url.searchParams.get('with_metrics_only') === '1',
      }));
    }
    if (url.pathname === '/api/pages') {
      const data = await store.loadAll();
      return send(200, { pages: shapePages(data) });
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return send(200, fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
    }
    send(404, { error: 'not_found' });
  } catch (e) {
    console.error(e);
    send(500, { error: String(e.message || e) });
  }
});

// 127.0.0.1, not every interface. This server applies no authentication - unlike
// the Vercel functions, which all go through checkAuth - so binding 0.0.0.0
// published the dashboard to whatever network the laptop was on.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`dev dashboard on http://localhost:${PORT}  (sink=${store.name}, no auth — localhost only)`);
});
