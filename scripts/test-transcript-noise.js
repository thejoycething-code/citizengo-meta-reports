// The noise guard, against the strings the first real batch actually produced.
const src = require('fs').readFileSync('collector/transcribe-ig.js', 'utf8');
const body = src.slice(src.indexOf('function looksLikeNoise'), src.indexOf('async function pending'));
const looksLikeNoise = new Function(`${body}; return looksLikeNoise;`)();

let bad = 0;
const t = (label, input, want) => {
  const got = looksLikeNoise(input);
  const ok = got === want;
  if (!ok) bad++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label} — noise=${got}, wanted ${want}`);
};

console.log('looksLikeNoise (observed hallucinations)');
t('Georgian run from a 47s music Reel', 'ლლლლლ\nლლლლლლლლლლლლლლლლლლლლლლლლლლლლლლლლლლ', true);
t('Khmer run from a 14s clip', 'ḍ្្្្្្្្', true);
t('Turkish music tag, repeated', '[MÜZİK ÇALIYOR]\n[MÜZİK ÇALIYOR]', true);
t('bracketed tag, single', '[MUSIC]', true);
t('parenthesised tag in Spanish', '(música de fondo)', true);
t('empty', '', true);
t('whitespace only', '   \n  ', true);
t('one word repeated to fill the clip', 'gracias gracias gracias gracias gracias gracias', true);

console.log('\nreal speech must survive');
t('Spanish, from the first batch', 'Acto de irse acercado a la manifestación por la vida para reivindicar principalmente dos cosas.', false);
t('Spanish, short', 'Muy buenos días a todos desde Badajoz.', false);
t('Italian', 'Oggi parliamo di eutanasia e di cosa significa davvero per i malati.', false);
t('short but real', 'Firma la petición.', false);
t('a real line that happens to contain a tag', '[Música] Hoy hablamos del aborto en España y de lo que viene.', false);
t('two distinct words repeated is a chant, not noise', 'vida sí vida sí vida sí muerte no', false);

console.log(bad ? `\n${bad} failed` : '\nall passed');
process.exit(bad ? 1 : 0);
