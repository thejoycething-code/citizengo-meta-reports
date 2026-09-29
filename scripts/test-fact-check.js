#!/usr/bin/env node
'use strict';
// Tests for the no-AI breakout fact check (lib/fact-check.js), against a
// stubbed Google News feed, so they run offline.
//
// The regressions that matter are the two false conflicts from the first live
// candidate (29 Sept 2026): a six-month-old headline from before a petition
// grew, and a headline about a different petition to the same mayor. Both must
// stay unreported.

const { factCheck, renderFactCheck, withFactCheck, entities, figures, language, topicWords } = require('../lib/fact-check');

let pass = 0; let fail = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const CAPTION = 'Almost 60,000 voices presented to Mayor Sadiq Khan earlier this month in City Hall.\n\nOne behalf of CitizenGO, Conservative member of the London Assembly Susan Hall confronted Sadiq Kahn with our petition demanding his resignation.\n\nKhan has failed children. Girls as young as 13 have not yet found justice.';
const PUBLISHED = '2026-09-26T11:36:26+00:00';
const rss = (items) => `<rss><channel>${items.map((i) => `<item><title>${i.title}</title><link>${i.link || 'https://news.google.com/rss/articles/x' + Math.random()}</link><pubDate>${i.date}</pubDate><source url="x">${i.source || 'Paper'}</source></item>`).join('')}</channel></rss>`;
const feed = (items) => async () => ({ ok: true, status: 200, text: async () => rss(items) });
const ALERT = '_Automated alert from the Meta reporting connector._\n\n🚀 *135,701 views* — Citizen GO UK\n\n> quote';

(async () => {
  console.log('\nReading the caption\n');
  {
    const names = entities(CAPTION);
    check('finds the names', names.includes('Khan') && names.includes('Sadiq'), JSON.stringify(names));
    check('skips sentence-initial words', !names.includes('Almost') && !names.includes('Girls') && !names.includes('One'), JSON.stringify(names));
    check('skips our own name', !names.map((n) => n.toLowerCase()).includes('citizengo'));
    const f = figures(CAPTION);
    check('reads "60,000 voices"', f.length === 1 && f[0].value === 60000 && f[0].unit === 'voices', JSON.stringify(f));
    check('ignores ages and small counts', !f.some((x) => x.value === 13));
    check('reads Spanish thousands', figures('Más de 45.000 firmas')[0].value === 45000);
    check('reads millions', figures('1,2 millones de personas')[0].value === 1.2e6);
    check('ignores years', figures('In 2026 the law changed').length === 0);
    check('detects Spanish', language('Los obispos y la Iglesia que por una vez') === 'es');
    check('topic words come from the sentences near a figure', topicWords(CAPTION).includes('petition'), JSON.stringify(topicWords(CAPTION)));
  }

  console.log('\nComparing with coverage\n');
  {
    const r = await factCheck({ message: CAPTION, published: PUBLISHED }, { fetch: feed([
      { title: 'Sadiq Khan stonewalled nine times on rape gangs — now 40,000 are demanding he quits - Daily Express', date: 'Mon, 09 Mar 2026 10:00:00 GMT' },
      { title: 'Sadiq Khan urged to scrap Silvertown tolls as 37,000 sign petition - standard.co.uk', date: 'Thu, 05 Dec 2024 10:00:00 GMT' },
    ]) });
    check('an old headline from before the petition grew is not a conflict', r.figures[0].verdict === 'not_found', JSON.stringify(r.figures));
  }
  {
    const r = await factCheck({ message: CAPTION, published: PUBLISHED }, { fetch: feed([
      { title: 'Sadiq Khan faces petition as 40,000 demand he quits', date: 'Thu, 10 Sep 2026 10:00:00 GMT', source: 'Daily Express' },
    ]) });
    check('a same-period headline with a different figure is a conflict', r.figures[0].verdict === 'differs' && r.figures[0].found.startsWith('40,000'), JSON.stringify(r.figures));
    const out = withFactCheck(ALERT, renderFactCheck(r));
    check('a conflict warns directly under the first line', out.split('\n')[2].includes('Check before reusing'), out);
    check('the conflict names what the press reported', out.includes('40,000') && out.includes('Daily Express'));
  }
  {
    const r = await factCheck({ message: CAPTION, published: PUBLISHED }, { fetch: feed([
      { title: 'Sadiq Khan handed petition of 58,000 demanding resignation', date: 'Fri, 11 Sep 2026 10:00:00 GMT' },
    ]) });
    check('a figure within 15% matches', r.figures[0].verdict === 'matches', JSON.stringify(r.figures));
    const out = withFactCheck(ALERT, renderFactCheck(r));
    check('a clean result goes at the end', out.startsWith(ALERT) && out.includes('match news coverage'));
  }
  {
    const r = await factCheck({ message: CAPTION, published: PUBLISHED }, { fetch: feed([
      { title: 'Sadiq Khan pledges 40,000 new homes at City Hall', date: 'Fri, 11 Sep 2026 10:00:00 GMT' },
    ]) });
    check('a headline sharing no topic word is not compared', r.figures[0].verdict === 'not_found', JSON.stringify(r.figures));
    const out = withFactCheck(ALERT, renderFactCheck(r));
    check('"not found" still warns, by the unverified rule', out.split('\n')[2].includes('could not be matched'), out);
  }

  console.log('\nFailure and edge cases\n');
  {
    const r = await factCheck({ message: CAPTION, published: PUBLISHED }, { fetch: async () => ({ ok: false, status: 503, text: async () => '' }) });
    check('a feed outage is a failure, not a throw', !r.ok && /503/.test(r.error));
    const out = withFactCheck(ALERT, renderFactCheck(r));
    check('a failed check still warns, at the top', out.split('\n')[2].includes('could not be run'));
    const none = await factCheck({ message: '🙏 Pray for the persecuted Church.' }, { fetch: feed([]) });
    check('a caption with no figures has nothing to compare', none.ok && none.noClaims);
    check('and says so at the end', renderFactCheck(none).where === 'bottom');
    check('every block states it is a no-AI, figures-only check', renderFactCheck(none).text.includes('no AI'));
    const mrk = renderFactCheck({ ok: true, figures: [{ claim: 'x', verdict: 'matches', item: { link: 'https://a.example/1', source: 'Paper' } }] });
    check('mrkdwn links for the webhook', mrk.text.includes('<https://a.example/1|Paper>'));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
