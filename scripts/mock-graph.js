#!/usr/bin/env node
'use strict';
// Minimal Meta Graph API double, enough to exercise the MULTI-TOKEN path without
// real System User tokens.
//
// It exists because the merge across tokens is about to become load-bearing —
// seven portfolios, seven tokens — and has never actually run with more than one.
//
// Models the three things that matter:
//   * different tokens see different (and overlapping) pages
//   * /me/accounts paginates
//   * a dead token fails while the others carry on
//
// Usage: node scripts/mock-graph.js [--port 5700]

const http = require('http');

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1]; };
const PORT = Number(argVal('port', 5700));

// token -> pages it can reach. Deliberately overlapping: HazteOir appears under
// both tok-big and tok-small, to prove first-token-wins rather than duplicating.
const TOKEN_PAGES = {
  'tok-big': [
    { id: '434058216680321', name: 'CitizenGO', followers_count: 117665 },
    { id: '154268578340', name: 'HazteOir.org', followers_count: 500000 },
    { id: '702065149817690', name: 'CitizenGO France', followers_count: 12000 },
    { id: '413326745503751', name: 'CitizenGO Deutsch', followers_count: 9000 },
  ],
  'tok-small': [
    { id: '154268578340', name: 'HazteOir.org', followers_count: 500000 }, // overlap
    { id: '221966714568910', name: 'Derecho a Vivir', followers_count: 40000 },
  ],
  'tok-uk': [
    { id: '105872884133170', name: 'Citizen GO UK', followers_count: 8589 },
  ],
  // 'tok-dead' is deliberately absent -> authentication failure
};

const PAGE_SIZE = 3; // small, so pagination is actually exercised

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function authError(res) {
  return json(res, 401, {
    error: {
      message: 'Error validating access token: the token is invalid.',
      type: 'OAuthException', code: 190,
    },
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

  // /v23.0/me/accounts
  if (/\/me\/accounts$/.test(url.pathname)) {
    const all = TOKEN_PAGES[token];
    if (!all) return authError(res);

    const after = Number(url.searchParams.get('after') || 0);
    const slice = all.slice(after, after + PAGE_SIZE);
    const nextAfter = after + PAGE_SIZE;
    return json(res, 200, {
      data: slice.map((p) => ({ ...p, access_token: `page-token-for-${p.id}` })),
      // A cursor is returned even when exhausted, mirroring Meta — the collector
      // must stop on an empty batch, not on a missing cursor.
      paging: { cursors: { after: String(nextAfter) } },
    });
  }

  // /v23.0/{page}/published_posts — empty, so the test finishes fast. The merge
  // is what is under test, not post collection.
  if (/\/published_posts$/.test(url.pathname)) {
    if (!/^page-token-for-/.test(token)) return authError(res);
    return json(res, 200, { data: [], paging: {} });
  }

  json(res, 404, { error: { message: 'not mocked', code: 100 } });
});

server.listen(PORT, () => {
  process.stderr.write(`mock graph on http://localhost:${PORT}\n`);
  if (process.send) process.send('ready');
});
