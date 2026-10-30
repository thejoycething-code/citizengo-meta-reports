#!/usr/bin/env node
'use strict';
// Pins topic_performance (mcp/topic-tools.js): which posts match a topic, how
// each is scored against its own account's normal, and that the answer never
// adds one platform's audience to another's. Usage: node scripts/test-topic.js

const { summarise, termsOf, topicPerformance } = require('../mcp/topic-tools');

let passed = 0, failed = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failed++; }
}

const fb = (id, page, msg, views) => ({ post_id: id, page_id: page, page_name: page, created_time: '2026-10-10T09:00:00Z', message: msg, permalink_url: 'https://fb/' + id, views_total: views });
const corpus = {
  facebook: [
    fb('1', 'Italia', 'Utero in affitto: firma ora', 3000),
    fb('2', 'Italia', 'Preghiera', 1000),
    fb('3', 'Italia', 'Famiglia', 1000),
    fb('4', 'Italia', 'Vita', 1000),
    fb('5', 'UK', 'Surrogacy | exploitation', 500),   // UK has one post: no baseline
  ],
  instagram: [
    { media_id: 'a', ig_username: 'cgo_es', timestamp: '2026-10-11T00:00:00Z', caption: 'Mira', transcript: 'la gestación subrogada es explotación', permalink: 'https://ig/a', reach: 400 },
    { media_id: 'b', ig_username: 'cgo_es', timestamp: '2026-10-11T00:00:00Z', caption: 'x', transcript: null, permalink: 'https://ig/b', reach: 200 },
    { media_id: 'c', ig_username: 'cgo_es', timestamp: '2026-10-11T00:00:00Z', caption: 'y', transcript: null, permalink: 'https://ig/c', reach: 200 },
  ],
  x: null,
};
const terms = termsOf('Utero in affitto, surrogacy, gestación subrogada');
eq('terms: split on commas, lower-cased', terms, ['utero in affitto', 'surrogacy', 'gestación subrogada']);
eq('terms: " OR " also separates', termsOf('a OR bb, bb'), ['bb']);

const s = summarise(corpus, terms);
eq('facebook: matches across languages', s.facebook.posts, 2);
eq('facebook: share of estate counted from every post', s.facebook.estatePosts, 5);
eq('facebook: scored against own page median (3000 / 1000)', s.facebook.top[0]._ratio, 3);
eq('facebook: page with under 3 posts is left unscored', s.facebook.scored, 1);
eq('instagram: what is said in the video matches', s.instagram.posts, 1);
eq('instagram: ratio vs account median (400 / 200)', s.instagram.typical, 2);
eq('x: not collected is null, not zero', s.x, null);

(async () => {
  const out = await topicPerformance({ topicCorpus: async () => corpus }, { query: 'utero in affitto, surrogacy, gestación subrogada' });
  eq('answer: says X is not collected', out.text.includes('Not collected here: X'), true);
  eq('answer: audiences labelled by their own measure', [out.text.includes('3,500 views'), out.text.includes('400 reach')], [true, true]);
  eq('answer: no grand total across platforms', /3,900|total across/i.test(out.text), false);
  eq('answer: pipe in post text escaped', out.text.includes('Surrogacy \\| exploitation') || !out.text.includes('Surrogacy | exploitation'), true);
  eq('answer: asks for a topic when none given', (await topicPerformance({ topicCorpus: async () => corpus }, { query: ' ' })).text.startsWith('Give a topic'), true);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
