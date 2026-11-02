'use strict';
// Tone of a comment, message or mention from its words and emoji (no paid AI).
// English and Spanish word lists; other languages come back null unless an
// emoji gives it away. It reads the tone of the words, not whether someone
// agrees with us: "This is disgusting, abortion is murder" from a supporter
// reads negative. Pair it with Supporter and Hostile to tell the two apart.
//
// toneOf(text, { lang }) -> { tone: positive|negative|mixed|neutral, score, hits } or null
//   lang: from langOf; anything but en, es or null (unknown) is only read for emoji.

const W = (s, v) => Object.fromEntries(s.trim().split(/\s+/).map((w) => [w, v]));
const WORDS = {
  // English
  ...W(`thank thanks thankyou grateful bless blessed blessing blessings amen pray praying prayed prayers prayer love loved loving lovely
    wonderful great brilliant beautiful proud support supporting supported signed hope hopeful glad happy agree agreed excellent
    amazing fantastic courage courageous brave inspiring inspired victory win won good best awesome congratulations congrats
    superb fabulous marvellous marvelous joy joyful grace thrilled delighted encouraging encouraged heroes hero appreciate
    appreciated helpful strong faithful`, 1),
  ...W(`hate hated hateful hating disgusting disgrace disgraceful shame shameful evil sick sickening wrong terrible awful horrible
    horrific appalling outrageous outrage angry anger sad tragic tragedy stupid idiot idiots liar liars lies lying bigot bigots bigoted
    nazi nazis fascist fascists pathetic vile cruel wicked scam fake ridiculous nonsense rubbish worst bad despicable disgusted
    abhorrent heartbreaking heartbroken shocking shocked dangerous corrupt hypocrite hypocrites hypocrisy useless garbage trash
    nasty creepy deluded clowns clown misogynist homophobic transphobic extremist extremists cult insane crazy dreadful`, -1),
  // Spanish
  ...W(`gracias bendiciones bendiga bendito bendita amén orar oración oraciones rezo rezamos rezando excelente bravo felicidades
    enhorabuena valiente valientes apoyo apoyamos firmado firmé firmada maravilloso maravillosa hermoso hermosa bueno buena genial
    fuerza esperanza alegría feliz ánimo adelante gloria victoria`, 1),
  ...W(`odio asco vergüenza vergonzoso vergonzosa malo mala horrible terrible triste mentira mentiras mentiroso mentirosos ridículo
    ridícula basura estúpido estúpida idiota idiotas fascista fascistas nazi malvado malvada indignante repugnante asqueroso asquerosa
    lamentable patético patética peligroso corrupto corruptos hipócrita hipócritas inútil secta`, -1),
};
const PHRASES = [
  [/\bwell done\b|\bgod bless\b|\bthank you\b|\bkeep (it )?up\b|\bspot on\b|\bgreat work\b|\bdios (te |os |les )?bendiga\b|\bmuchas gracias\b|\bmuy bien\b/gi, 1],
  [/\bshame on\b|\bhow dare\b|\bgo away\b|\bget lost\b|\bshut up\b|\bqu[ée] verg[üu]enza\b|\bda asco\b/gi, -1],
];
const EMOJI = [
  [/🙏|❤️|❤|♥️|😍|🥰|👏|💪|😊|🙂|👍|✝️|🎉|💙|💚|💛|💜|🤍|😇|🌹|✨/gu, 1],
  [/😡|🤬|😠|👎|🤮|🤢|😢|😭|💔|🙄|😤|🖕/gu, -1],
];
const NEGATORS = new Set('not no never dont don\'t doesnt doesn\'t isnt isn\'t wasnt wasn\'t cant can\'t cannot wont won\'t nothing nor hardly nunca ni tampoco nada'.split(' '));
const BOOST = new Set('very so really extremely truly absolutely totally such muy tan realmente totalmente súper super'.split(' '));
const BUT = new Set(['but', 'however', 'pero', 'aunque']);

function toneOf(text, { lang } = {}) {
  const t = String(text || '');
  if (!t.trim()) return null;
  let score = 0, hits = 0, pos = 0, neg = 0;
  const add = (v) => { score += v; hits++; if (v > 0) pos += v; else neg -= v; };
  for (const [re, v] of EMOJI) for (const _ of t.match(re) || []) add(v); // eslint-disable-line no-unused-vars
  const readWords = !lang || lang === 'en' || lang === 'es';
  if (readWords) {
    let rest = t.toLowerCase();
    // A phrase becomes one stand-in word, scored in the word loop so "not well done" is flipped too.
    for (const [re, v] of PHRASES) rest = rest.replace(re, () => (v > 0 ? ' zzphrasepos ' : ' zzphraseneg '));
    // Words with a stop after them (. , ! ? ; :) end a "not ..." so "No! This is evil" stays negative.
    const tokens = rest.replace(/[’]/g, "'").match(/[\p{L}']+|[.,!?;:¡¿]+/gu) || [];
    let flip = 0, boost = 1, weight = 1;
    for (const w of tokens) {
      if (!/\p{L}/u.test(w)) { flip = 0; boost = 1; continue; }
      if (BUT.has(w)) { weight = 1.5; continue; } // what follows "but" counts for more
      if (NEGATORS.has(w)) { flip = 3; continue; }
      if (BOOST.has(w)) { boost = 1.5; continue; }
      const v = w === 'zzphrasepos' ? 1 : w === 'zzphraseneg' ? -1 : WORDS[w];
      if (v) { add(v * (flip ? -1 : 1) * boost * weight); boost = 1; }
      if (flip) flip--;
    }
  }
  if (!hits) return readWords ? { tone: 'neutral', score: 0, hits: 0 } : null;
  score = Math.round(score * 10) / 10;
  // Both sides, and the weaker at least half the stronger: mixed.
  const tone = pos && neg && Math.min(pos, neg) / Math.max(pos, neg) >= 0.5 ? 'mixed' : score >= 1 ? 'positive' : score <= -1 ? 'negative' : pos && neg ? 'mixed' : 'neutral';
  return { tone, score, hits };
}

// Counts of each tone across a list of texts (null = couldn't tell).
function toneMix(texts, opts = {}) {
  const out = { positive: 0, negative: 0, mixed: 0, neutral: 0, unknown: 0 };
  for (const x of texts) { const r = toneOf(x, opts.langOf ? { lang: opts.langOf(x) } : {}); out[r ? r.tone : 'unknown']++; }
  return out;
}

module.exports = { toneOf, toneMix };
