#!/usr/bin/env node
'use strict';
// Tests for the breakout alerts: story clustering and the announce rule.
//
// These exist because both halves were got wrong first time and only real data
// showed it. The clustering regression below is the important one: the first
// implementation merged 591 posts across 23 pages into a single "story".

const { cluster, shouldAnnounce, properNouns, nameTokens, buildIndex } = require('../lib/stories');

let pass = 0; let fail = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const day = (n) => new Date(Date.UTC(2026, 7, 28) + n * 86400000).toISOString();
let seq = 0;
const post = (o) => ({
  post_id: o.post_id || `p${++seq}`, page_id: o.page_id || 'pg1',
  created_time: o.created_time,
  // Uses "in", not a falsy check: an explicit null media_type is the case being
  // tested, and defaulting it to 'photo' quietly removed the test.
  media_type: 'media_type' in o ? o.media_type : 'photo',
  message: o.message, full_picture: o.full_picture || null,
});

console.log('\nProper nouns, not rare words\n');
{
  check('finds a name in Spanish', properNouns('🚨 Nació mediante gestación subrogada. Olivia Maurel descubrió').includes('maurel'));
  check('finds the same name in Italian', properNouns('È nata da maternità surrogata. Olivia Maurel ha scoperto').includes('maurel'));
  check('finds it in Croatian too', properNouns('🚨Rođena je iz surogatstva. Olivia Maurel je otkrila').includes('maurel'));
  check('ignores all-caps shouting', properNouns('🚨 URGENTE ATENCIÓN INVASORES AGREDEN A MILITARES').length === 0);
  check('drops fragments from letters NFKD cannot fold',
    !properNouns('Rođena je').some((t) => t.includes(' ')), JSON.stringify(properNouns('Rođena je')));

  // The fault that produced the 591-post cluster: an everyday word in a minority
  // language is rare in a Spanish-dominated corpus, but it is not a name.
  const corpus = [
    ...Array.from({ length: 40 }, (_, i) => post({ created_time: day(i % 10), message: `Sánchez y el Gobierno ${i}` })),
    post({ created_time: day(1), message: 'Ovo nije dobro za roditeljima' }),
    post({ created_time: day(2), message: 'To nije istina, nikada nije' }),
  ];
  const idx = buildIndex(corpus);
  const names = nameTokens(corpus[corpus.length - 1], idx);
  check('a lowercase minority-language word is not treated as a name', !names.includes('nije'), JSON.stringify(names));
}

console.log('\nClustering\n');
{
  // The real Olivia Maurel spread: Spanish original, Spanish copy, translations.
  const posts = [
    post({ post_id: 'mx', page_id: 'mx', created_time: day(0), message: '🚨 Nació mediante gestación subrogada. Ahora recorre el mundo luchando por abolirla. Olivia Maurel descubrió, gracias a una prueba de ADN, que había sido concebida mediante gestación subrogada.' }),
    post({ post_id: 'latam', page_id: 'latam', created_time: day(0), message: '🚨 Nació mediante gestación subrogada. Ahora recorre el mundo luchando por abolirla. Olivia Maurel descubrió, gracias a una prueba de ADN, que había sido concebida mediante gestación subrogada.' }),
    post({ post_id: 'it', page_id: 'it', created_time: day(3), message: 'È nata da maternità surrogata. Oggi viaggia per il mondo battendosi per abolirla. Olivia Maurel ha scoperto tramite un test del DNA di essere stata concepita.' }),
    post({ post_id: 'hr', page_id: 'hr', created_time: day(5), message: '🚨Rođena je iz surogatstva. Danas putuje svijetom boreći se za njegovo ukidanje. Olivia Maurel je otkrila testom DNA.' }),
    post({ post_id: 'other', page_id: 'uk', created_time: day(1), message: 'Andy Burnham has appointed Lucy Powell as Education Secretary, and her views on inclusion are radical.' }),
  ];
  const stories = cluster(posts);
  const olivia = stories.find((s) => s.members.some((m) => m.post_id === 'latam'));
  check('the whole Olivia family lands in one story', olivia.members.length === 4, `${olivia.members.length} members`);
  check('across all four pages', new Set(olivia.members.map((m) => m.page_id)).size === 4);
  check('the earliest post is the story key', olivia.story_key === 'mx', olivia.story_key);
  check('an unrelated post is its own story', stories.length === 2, `${stories.length} stories`);

  // The regression. Anchoring on a representative means one weak pair cannot
  // chain two stories together.
  const chain = [
    post({ post_id: 'a', created_time: day(0), message: 'Ceuta y Sánchez, la frontera sur y el Gobierno de Moncloa fracasan' }),
    post({ post_id: 'b', created_time: day(1), message: 'Ceuta otra vez, Moncloa calla y los vecinos protestan en la calle hoy' }),
    post({ post_id: 'c', created_time: day(2), message: 'Bachelet en la ONU, Michelle Bachelet y el aborto como derecho universal' }),
    post({ post_id: 'd', created_time: day(3), message: 'Michelle Bachelet quiere imponer la ideología de género en las escuelas' }),
  ];
  const cs = cluster(chain);
  check('Ceuta and Bachelet do not chain into one story', cs.length >= 2, `${cs.length} stories`);
  check('no cluster swallows every post', Math.max(...cs.map((s) => s.members.length)) < chain.length,
    JSON.stringify(cs.map((s) => s.members.length)));
}

console.log('\nThe announce rule\n');
{
  const story = { story_key: 'first', first: post({ post_id: 'first', created_time: day(0), message: 'Olivia Maurel' }) };
  const priorPhoto = [{ story_key: 'first', media_type: 'photo', post_id: 'first' }];

  check('the first post over the threshold is announced',
    shouldAnnounce({ post: post({ created_time: day(0) }), story, prior: [] }).announce);

  check('a same-format copy two days later is not',
    !shouldAnnounce({ post: post({ created_time: day(2), media_type: 'photo' }), story, prior: priorPhoto }).announce);

  check('nor is one 34 days later',
    !shouldAnnounce({ post: post({ created_time: day(34), media_type: 'photo' }), story, prior: priorPhoto }).announce);

  // The case that motivated splitting the key: a video of Olivia is not the
  // photo of Olivia, and both deserve surfacing.
  const v = shouldAnnounce({ post: post({ created_time: day(2), media_type: 'video' }), story, prior: priorPhoto });
  check('a VIDEO on the same story is announced even though the photo already was', v.announce);
  check('and it is not labelled a revival', v.revival === null);

  const r = shouldAnnounce({ post: post({ created_time: day(35), media_type: 'photo' }), story, prior: priorPhoto });
  check('a same-format copy exactly 35 days after the first post is announced', r.announce);
  check('and is labelled a revival, with the gap', !!r.revival && r.revival.days === 35, JSON.stringify(r.revival));

  check('a copy 60 days later is announced too',
    shouldAnnounce({ post: post({ created_time: day(60), media_type: 'photo' }), story, prior: priorPhoto }).announce);

  check('an unknown media type does not collide with a known one',
    shouldAnnounce({ post: post({ created_time: day(1), media_type: null }), story, prior: priorPhoto }).announce);

  check('a different story is unaffected by this one',
    shouldAnnounce({ post: post({ created_time: day(1), media_type: 'photo' }),
      story: { story_key: 'elsewhere', first: post({ post_id: 'elsewhere', created_time: day(1) }) },
      prior: priorPhoto }).announce);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
