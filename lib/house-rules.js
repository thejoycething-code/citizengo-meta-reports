'use strict';
// House rules [Priority Two 33, 3 Nov 2026]: each team's voice, tone and rules,
// shown and edited in desk Settings and read by the desk's Claude features
// (Compose and Inbox drafts). A team starts from the built-in default below and
// amends it; the saved copy lives in engine_desk_docs (collection houseRules,
// id hr_<team>). The morning run can read it through engine_house_rules.

const SECTIONS = [
  ['voice', 'Voice'],
  ['tone', 'Tone'],
  ['audience', 'Audience'],
  ['always', 'Always'],
  ['never', 'Never'],
  ['style', 'Spelling and style'],
];

const EN = {
  voice: 'Warm, direct and hopeful. We talk to supporters as friends and fellow campaigners, never as a crowd to be stirred up.',
  tone: 'Calm and confident, even when the news is bad. Grateful to people who act. Firm on the issue, kind to people.',
  audience: 'People of faith and goodwill who care about life, family and freedom, many of them over 45 and mostly on Facebook.',
  always: 'Give one clear action (sign, share, write to your MP). Name the decision-maker and the date when we know them. Thank people who act.',
  never: 'Insults, mockery or arguing with critics. Predictions about what opponents will do. Facts, names or numbers we cannot source.',
  style: 'Plain words, short sentences, no em dashes. At most two emoji in a post.',
};
const ES = {
  voice: 'Cercana, directa y esperanzadora. Hablamos a quienes nos apoyan como amigos y compañeros de campaña.',
  tone: 'Tranquilo y seguro, aunque la noticia sea mala. Agradecido con quien actúa. Firme en el tema, amable con las personas.',
  audience: 'Personas de fe y de buena voluntad que defienden la vida, la familia y la libertad en México y Latinoamérica.',
  always: 'Una sola acción clara (firma, comparte, escribe). Nombra a quien decide y la fecha cuando se sepan. Da las gracias a quien actúa.',
  never: 'Insultos, burlas o discusiones con críticos. Predicciones sobre lo que harán los opositores. Datos o cifras sin fuente.',
  style: 'Español de México, palabras sencillas, frases cortas, sin rayas largas. Como mucho dos emojis por publicación.',
};
const RULES_EN = [
  'One clear action in every post',
  'No engagement bait ("share if", "comment YES")',
  'Never mock or argue with critics',
  'Only facts, names and numbers we can source',
  'British spelling',
  'No hashtags in Inbox replies',
  'No more than two emoji',
];
const RULES_ES = [
  'Una sola acción clara en cada publicación',
  'Nada de cebos ("comparte si", "comenta SÍ")',
  'Nunca burlarse ni discutir con críticos',
  'Solo datos, nombres y cifras con fuente',
  'Español de México',
  'Sin hashtags en las respuestas del Inbox',
  'Como mucho dos emojis',
];
const SPANISH = new Set(['mx', 'mexico', 'latam']);

function defaults(team) {
  const es = SPANISH.has(String(team || '').toLowerCase());
  const rules = (es ? RULES_ES : RULES_EN).map((text, i) => ({ id: `d${i + 1}`, text, by: 'default', on: { compose: true, inbox: !/^(One clear action|Una sola acción)/.test(text), morning: !/(Inbox)/.test(text) } }));
  return { team, sections: { ...(es ? ES : EN) }, rules, is_default: true };
}

// The saved copy over the default: missing sections fall back to it.
function merge(team, saved) {
  const d = defaults(team);
  if (!saved) return d;
  const sections = { ...d.sections };
  for (const [k] of SECTIONS) if (saved.sections && typeof saved.sections[k] === 'string') sections[k] = saved.sections[k].slice(0, 2000);
  const rules = Array.isArray(saved.rules) ? saved.rules.filter((r) => r && r.text).slice(0, 60).map((r) => ({ id: String(r.id || ''), text: String(r.text).slice(0, 300), by: r.by || null, at: r.at || null, on: { compose: r.on ? r.on.compose !== false : true, inbox: r.on ? r.on.inbox !== false : true, morning: r.on ? !!r.on.morning : false } })) : d.rules;
  return { team, sections, rules, is_default: false, updated_by: saved.updated_by || null, updated_at: saved.updated_at || null };
}

// Prompt text for one place: compose, inbox or morning.
function text(h, where = 'compose') {
  const lines = SECTIONS.map(([k, l]) => (h.sections[k] ? `${l}: ${h.sections[k]}` : '')).filter(Boolean);
  const rules = h.rules.filter((r) => r.on && r.on[where]).map((r) => `- ${r.text}`);
  return `House rules for this team (follow them):\n${lines.join('\n')}${rules.length ? `\nRules:\n${rules.join('\n')}` : ''}`;
}

module.exports = { SECTIONS, defaults, merge, text };
