#!/usr/bin/env node
'use strict';
// search_posts covers two platforms and neither was tested: test-tool-size.js
// skips it because the mock has no views, so the Facebook half went unexercised
// and the Instagram half did not exist. This drives the tool against a fake
// store and asserts on the rendered text, which is all any client ever sees.

const { callTool } = require('../mcp/tools.js');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

// A caption where the search term sits well past the old 52-character window.
const LEAD = 'Firmamos por la vida y por la familia en toda Europa. ';
const CAPTION = LEAD.repeat(3) + 'Di no a la eutanasia hoy mismo. ' + 'Comparte. '.repeat(8);

const fakeStore = {
  name: 'fake',
  async freshness() { return { latest: new Date().toISOString().slice(0, 10), recentFailures: 0 }; },
  async searchPosts({ q }) {
    return q.toLowerCase() === 'eutanasia' ? [{
      created_time: '2026-09-01T10:00:00Z', page_name: 'CitizenGO España', post_id: '1_1',
      message: LEAD.repeat(2) + 'La eutanasia no es compasion | es abandono.',
      permalink_url: 'https://facebook.com/1_1',
      views_unique: 1000, views_total: 2000, views_from_nonfollowers: 500,
      shares_total: 10, comments_total: 5, engagement_rate_pct: 3.2,
    }] : [];
  },
  async searchIgMedia({ q }) {
    return q.toLowerCase() === 'eutanasia' ? [{
      timestamp: '2026-09-02T10:00:00Z', ig_username: 'citizengo_es', media_id: 'ig1',
      caption: CAPTION, permalink: 'https://instagram.com/p/ig1',
      media_product_type: 'REELS', media_type: 'VIDEO',
      reach: 900, views: 1800, saved: 40, total_interactions: 120, interaction_rate_pct: 13.3,
    }] : [];
  },
};

(async () => {
  console.log('search_posts');
  const hit = await callTool(fakeStore, 'search_posts', { query: 'eutanasia' });

  check('reports both platforms in the count', /1 on Facebook, 1 on Instagram/.test(hit.text), hit.text.split('\n')[0]);
  check('renders a Facebook section', /\*\*Facebook\*\*/.test(hit.text));
  check('renders an Instagram section', /\*\*Instagram\*\*/.test(hit.text));
  check('links the Instagram permalink', hit.text.includes('https://instagram.com/p/ig1'));
  check('returns both row sets as data', !!(hit.data && hit.data.facebook.length === 1 && hit.data.instagram.length === 1));

  // The point of the change: the searched word is visible in the row.
  const igLine = hit.text.split('\n').find((l) => l.includes('@citizengo_es')) || '';
  check('the Instagram row SHOWS the matched word', /eutanasia/i.test(igLine), igLine.slice(0, 120));
  check('the window is marked as a window, not the opening', igLine.includes('…'));
  const oldWindow = CAPTION.replace(/\s+/g, ' ').slice(0, 52);
  check('the old 52-char opening would NOT have contained it', !/eutanasia/i.test(oldWindow), oldWindow);

  // A pipe in post text closes the cell and corrupts every column after it.
  const fbLine = hit.text.split('\n').find((l) => l.includes('CitizenGO España')) || '';
  check('a pipe in the post text is escaped', !/[^\\]\|/.test(fbLine.slice(1, -1).replace(/\\\|/g, '')) || fbLine.includes('\\|'), fbLine.slice(0, 90));

  // Never silently drop a half.
  const fbOnly = await callTool({
    ...fakeStore,
    async searchIgMedia() { return []; },
  }, 'search_posts', { query: 'eutanasia' });
  check('says so when Instagram matched nothing', /No Instagram captions matched/.test(fbOnly.text));
  check('does not claim Instagram hits it did not have', /1 on Facebook, 0 on Instagram/.test(fbOnly.text));

  const none = await callTool(fakeStore, 'search_posts', { query: 'zzzznothing' });
  check('empty result names both sources searched', /Facebook post copy and Instagram captions/.test(none.text));
  check('empty result returns null data', none.data === null);

  const blank = await callTool(fakeStore, 'search_posts', { query: '   ' });
  check('a blank query asks for a term rather than searching', /Give a search term/.test(blank.text));

  // --- the spoken word -----------------------------------------------------
  // A hit in a transcript and a hit in a caption are different editorial
  // facts. A row that does not say which invites the reader to assume the
  // page wrote the word down.
  const spokenStore = {
    ...fakeStore,
    async searchPosts() { return []; },
    async searchIgMedia() {
      return [
        { timestamp: '2026-09-03T10:00:00Z', ig_username: 'citizengo_italia', media_id: 'ig2',
          caption: 'Guarda il video e firma la petizione.', permalink: 'https://instagram.com/p/ig2',
          media_product_type: 'REELS', media_type: 'VIDEO',
          transcript: 'Oggi parliamo di eutanasia e di cosa significa davvero per i malati.',
          transcript_language: 'it',
          reach: 500, views: 900, saved: 5, total_interactions: 30, interaction_rate_pct: 6.0 },
        { timestamp: '2026-09-04T10:00:00Z', ig_username: 'citizengo_italia', media_id: 'ig3',
          caption: 'La eutanasia avanza in Europa.', permalink: 'https://instagram.com/p/ig3',
          media_product_type: 'REELS', media_type: 'VIDEO',
          transcript: null, transcript_error: null,
          reach: 400, views: 800, saved: 4, total_interactions: 20, interaction_rate_pct: 5.0 },
      ];
    },
  };
  const spoken = await callTool(spokenStore, 'search_posts', { query: 'eutanasia' });
  const rowSpoken = spoken.text.split('\n').find((l) => l.includes('/ig2')) || '';
  const rowCaption = spoken.text.split('\n').find((l) => l.includes('/ig3')) || '';

  check('a transcript-only hit is labelled spoken', / spoken /.test(rowSpoken), rowSpoken.slice(0, 100));
  check('and shows the spoken text as the evidence', /parliamo di eutanasia/.test(rowSpoken));
  check('a caption hit is labelled caption', / caption /.test(rowCaption), rowCaption.slice(0, 100));
  check('warns that untranscribed Reels were searched on caption alone',
    /1 of the 2 Reels shown have not been transcribed yet/.test(spoken.text));

  // The warning must disappear once everything shown has been listened to.
  const allDone = await callTool({
    ...spokenStore,
    async searchIgMedia() {
      const rows = await spokenStore.searchIgMedia();
      return [{ ...rows[0] }];
    },
  }, 'search_posts', { query: 'eutanasia' });
  check('no warning when every Reel shown has a transcript',
    !/have not been transcribed yet/.test(allDone.text));

  // --- text safety ------------------------------------------------------
  // Slicing UTF-16 code units can cut an emoji's surrogate pair in half. A lone
  // surrogate is not valid JSON: it broke an MCP client outright with "lone
  // leading surrogate in hex escape" on a caption containing a flag emoji. It
  // only happens at the widths where the cut lands mid-pair, which is why it
  // looked intermittent rather than broken.
  const lone = (str) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(str);
  const emojiStore = {
    ...fakeStore,
    async searchPosts() {
      return [{
        created_time: '2026-08-10T10:00:00Z', page_name: 'CitizenGO Latam', post_id: 'e1',
        message: 'Colombia \u{1F1E8}\u{1F1F4} ha sido sacudida por un potente terremoto de magnitud 7,4 hoy \u{1F64F}',
        permalink_url: 'https://facebook.com/e1',
        views_unique: 100, views_total: 200, views_from_nonfollowers: 50,
        reactions_total: 5, shares_total: 1, comments_total: 2, clicks_total: 3,
        engagement_total: 11, engagement_rate_pct: 5.5,
      }];
    },
    async searchIgMedia() { return []; },
  };
  const emo = await callTool(emojiStore, 'search_posts', { query: 'terremoto' });
  check('no lone surrogate in the rendered output', !lone(emo.text));
  check('the output survives a JSON round trip', (() => {
    try { JSON.parse(JSON.stringify({ text: emo.text })); return true; } catch (e) { return false; }
  })());

  console.log(`\n${failed ? failed + ' failed' : 'all passed'}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
