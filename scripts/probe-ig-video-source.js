#!/usr/bin/env node
'use strict';
// Can we get at the video itself? Transcribing a Reel needs a fetchable media
// file; Graph is the only way we would get one. Asks v23.0 for the fields that
// could carry it, on real Reels, and reports what comes back and whether the
// URL actually serves bytes. Read-only: no downloads beyond a range request.
//
//   node scripts/probe-ig-video-source.js [--count 3]

const { loadEnv, makeClient } = require('../lib/graph');
loadEnv();
const { makePageTokens } = require('../lib/pagetokens');

const VERSION = process.env.GRAPH_VERSION || 'v23.0';
const COUNT = Number((process.argv.find((a) => a.startsWith('--count=')) || '').split('=')[1] || 3);

// Every field that might carry a video, a transcript or a caption track.
const CANDIDATES = ['media_url', 'thumbnail_url', 'media_type', 'media_product_type', 'permalink'];
const LONGSHOTS = ['captions', 'transcript', 'video_title', 'alt_text', 'source'];

async function main() {
  // Same env contract as the collector: META_TOKENS is a list, META_TOKEN one.
  const tokens = String(process.env.META_TOKENS || process.env.META_TOKEN || '')
    .split(/[\n,]/).map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) { console.error('No token. Set META_TOKENS or META_TOKEN.'); process.exit(2); }
  const token = tokens[0];
  const client = makeClient({ token, version: VERSION });

  const url = process.env.SUPABASE_URL.replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  const res = await fetch(`${url}/rest/v1/meta_ig_media?select=media_id,page_id,ig_user_id,permalink,timestamp`
    + `&media_type=eq.VIDEO&order=timestamp.desc&limit=${COUNT}`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  const media = await res.json();
  if (!media.length) { console.error('no VIDEO media in the store'); process.exit(1); }
  console.log(`Probing ${media.length} Reel(s) on Graph ${VERSION}\n`);

  const pt = makePageTokens(client, tokens);
  await pt.enumeratePages();

  let anyUrl = false;
  for (const m of media) {
    const tok = (await pt.tokenFor(m.page_id)) || token;
    console.log(`--- ${m.media_id}  (${String(m.timestamp).slice(0, 10)})`);

    const r = await client.get(`/${m.media_id}`, { fields: CANDIDATES.join(',') }, { token: tok });
    if (!r.ok) { console.log(`  standard fields refused: ${(r.body && r.body.error && r.body.error.message) || r.status}`); }
    else {
      for (const f of CANDIDATES) {
        const v = r.body[f];
        console.log(`  ${f.padEnd(20)} ${v ? (String(v).length > 70 ? String(v).slice(0, 67) + '...' : v) : '(absent)'}`);
      }
      if (r.body.media_url) {
        anyUrl = true;
        // Range request: proves it serves bytes without pulling the whole file.
        try {
          const head = await fetch(r.body.media_url, { headers: { Range: 'bytes=0-1023' } });
          console.log(`  -> fetchable: HTTP ${head.status}, type ${head.headers.get('content-type')}, `
            + `range ${head.headers.get('content-range') || 'n/a'}`);
        } catch (e) { console.log(`  -> fetch failed: ${e.message}`); }
      }
    }
    // One at a time: an unavailable field must not take the others down.
    for (const f of LONGSHOTS) {
      const q = await client.get(`/${m.media_id}`, { fields: f }, { token: tok });
      const err = q.ok ? null : ((q.body && q.body.error && q.body.error.message) || `HTTP ${q.status}`);
      console.log(`  ${f.padEnd(20)} ${q.ok ? JSON.stringify(q.body[f]) : 'REFUSED — ' + String(err).slice(0, 90)}`);
    }
    console.log();
  }
  console.log(anyUrl
    ? 'VERDICT: a fetchable video URL is available, so transcription is possible.'
    : 'VERDICT: no video URL from Graph — transcription would need another source.');
}
main().catch((e) => { console.error(e); process.exit(1); });
