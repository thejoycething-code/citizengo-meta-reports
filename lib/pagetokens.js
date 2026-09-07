'use strict';
// Resolving a Page access token for a given page id.
//
// Two routes, and both are needed. /me/accounts lists only pages the user holds
// a DIRECT role on, which since 29 Aug 2026 is 14 of our 36 - the rest are
// reached through a Business Portfolio and need business_management to
// enumerate, while remaining perfectly readable when asked for by id.
//
// Extracted here because getting this wrong is silent: the first run of
// scripts/probe-follower-metrics.js enumerated only, found no Instagram-linked
// page among the 14, and reported "skipped" as a success. The collector's
// Step 1b has always done it properly; anything else that needs a page token
// should share this rather than reimplement half of it.

function makePageTokens(client, tokens) {
  const enumerated = new Map();
  const resolved = new Map();

  async function enumeratePages() {
    for (const token of tokens) {
      let after = null;
      for (let guard = 0; guard < 20; guard++) {
        const params = { fields: 'id,name,access_token', limit: 100 };
        if (after) params.after = after;
        const res = await client.get('/me/accounts', params, { token });
        if (!res.ok) break;
        for (const p of (res.body && res.body.data) || []) {
          if (p.id && p.access_token && !enumerated.has(p.id)) enumerated.set(p.id, p.access_token);
        }
        after = res.body && res.body.paging && res.body.paging.cursors
          && res.body.paging.cursors.after;
        if (!after) break;
      }
    }
    return enumerated.size;
  }

  // Memoised, including the failures - a page that will not hand over a token
  // must not be re-asked once per metric.
  async function tokenFor(pageId) {
    if (resolved.has(pageId)) return resolved.get(pageId);
    let out = enumerated.get(pageId) || null;
    if (!out) {
      for (const token of tokens) {
        const r = await client.get(`/${pageId}`, { fields: 'id,access_token' }, { token });
        if (r.ok && r.body && r.body.access_token) { out = r.body.access_token; break; }
      }
    }
    resolved.set(pageId, out);
    return out;
  }

  return { enumeratePages, tokenFor, get enumeratedSize() { return enumerated.size; } };
}

module.exports = { makePageTokens };
