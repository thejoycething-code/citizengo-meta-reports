'use strict';
// topic_performance (30 Oct 2026): how one topic did across Facebook, Instagram
// and X in a single answer (Asana 1218612679195558, Candela's cross-platform
// topic question).
//
// The three platforms count different things - Facebook views, Instagram
// reach, X impressions - so their totals are never added together. What IS
// comparable is each post against its own account's normal: a surrogacy post
// that did 3x what CitizenGO Italia usually does means the same on every
// platform. So every matched post is scored against the median of ALL its
// account's posts in the same window, and each platform reports how the typical
// topic post did against that normal.

const xt = require('./x-tools');

const n = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-GB'));
const cell = (s, len = 70) => {
  const one = String(s || '').replace(/\|/g, '\\|').replace(/[[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return one.length > len ? one.slice(0, len - 1) + '…' : one;
};
function table(headers, rows) {
  return `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n` + rows.map((r) => `| ${r.join(' | ')} |`).join('\n');
}
function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const times = (r) => (r === null || r === undefined ? '—' : `${r >= 10 ? Math.round(r) : r.toFixed(1)}×`);

// How each platform's rows are read: who the account is, what is searched, and
// the one audience figure that platform gives us.
const PLATFORMS = {
  facebook: { label: 'Facebook', metric: 'views', account: (r) => r.page_id, name: (r) => r.page_name,
    text: (r) => [r.message], value: (r) => r.views_total, when: (r) => r.created_time, link: (r) => r.permalink_url },
  instagram: { label: 'Instagram', metric: 'reach', account: (r) => r.ig_username || r.page_id, name: (r) => (r.ig_username ? '@' + r.ig_username : r.page_name),
    text: (r) => [r.caption, r.transcript], value: (r) => r.reach, when: (r) => r.timestamp, link: (r) => r.permalink },
  x: { label: 'X', metric: 'impressions', account: (r) => r.account_id, name: (r) => '@' + r.username,
    text: (r) => [r.text], value: (r) => r.impressions, when: (r) => r.created_at, link: (r) => r.permalink_url },
};

// "assisted dying, eutanasia, suicidio asistido" -> three alternatives. Our
// estate posts in a dozen languages, so a topic is a list of words, not one.
function termsOf(query) {
  return [...new Set(String(query || '').split(/[,;\n]| OR /).map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 2))];
}

// Pure, exported for the tests. corpus: { facebook: rows|null, instagram, x }.
function summarise(corpus, terms) {
  const out = {};
  for (const [key, P] of Object.entries(PLATFORMS)) {
    if (corpus[key] === null || corpus[key] === undefined) { out[key] = null; continue; }
    // A spokesperson's X account holds only the posts that link to or mention
    // CitizenGO (lib/xschedule.js isAboutUs), so it has no "all posts" to take a
    // share of, and its normal is not that account's normal. Left out.
    const rows = corpus[key].filter((r) => r.kind !== 'spokesperson');
    // Each account's normal over the whole window, on posts that have a figure.
    // Fewer than 3 posts is no baseline at all, and the post is left unscored.
    const byAccount = new Map();
    for (const r of rows) {
      const v = P.value(r);
      if (v === null || v === undefined) continue;
      const a = P.account(r);
      if (!byAccount.has(a)) byAccount.set(a, []);
      byAccount.get(a).push(Number(v));
    }
    const normal = new Map([...byAccount].map(([a, vs]) => [a, vs.length >= 3 ? median(vs) : null]));
    const matched = rows.filter((r) => P.text(r).some((t) => t && terms.some((term) => String(t).toLowerCase().includes(term))))
      .map((r) => {
        const v = P.value(r); const base = normal.get(P.account(r));
        return { ...r, _value: v === null || v === undefined ? null : Number(v), _ratio: v !== null && v !== undefined && base > 0 ? Number(v) / base : null };
      });
    const scored = matched.filter((r) => r._ratio !== null);
    const accounts = new Map();
    for (const r of matched) {
      const a = P.account(r);
      if (!accounts.has(a)) accounts.set(a, { name: P.name(r), posts: 0, total: 0, ratios: [] });
      const e = accounts.get(a);
      e.posts++; e.total += r._value || 0; if (r._ratio !== null) e.ratios.push(r._ratio);
    }
    out[key] = {
      estatePosts: rows.length,
      posts: matched.length,
      accounts: accounts.size,
      // Posts without a figure (not yet collected, or Meta served none) are
      // counted as unmeasured, never as zero audience.
      measured: matched.filter((r) => r._value !== null).length,
      total: matched.some((r) => r._value !== null) ? matched.reduce((s, r) => s + (r._value || 0), 0) : null,
      typical: scored.length ? median(scored.map((r) => r._ratio)) : null,
      aboveNormal: scored.filter((r) => r._ratio > 1).length,
      scored: scored.length,
      top: [...scored].sort((a, b) => b._ratio - a._ratio).slice(0, 3),
      byAccount: [...accounts.values()].map((e) => ({ ...e, typical: e.ratios.length ? median(e.ratios) : null }))
        .sort((a, b) => b.total - a.total),
    };
  }
  return out;
}

function verdict(s) {
  if (!s || !s.scored) return '';
  if (s.typical >= 1.5) return 'beats normal';
  if (s.typical >= 0.8) return 'about normal';
  return 'below normal';
}

async function topicPerformance(store, args = {}) {
  const terms = termsOf(args.query);
  if (!terms.length) return { text: 'Give a topic: a word or phrase, or several separated by commas for translations and synonyms, e.g. "assisted dying, eutanasia, suicidio asistido".' };
  const w = xt.windowFor({ month: args.month, from: args.from, to: args.to, days: Math.min(Number(args.days ?? 30) || 0, 365) || 365 }, 30);
  if (w.error) return { text: w.error };
  const corpus = await store.topicCorpus({ since: w.since, until: w.until });
  const sum = summarise(corpus, terms);
  const keys = Object.keys(PLATFORMS);

  const overview = table(['Platform', 'Topic posts', 'Share of all posts', 'Accounts', 'Audience', 'Typical topic post vs its account\'s normal', 'Above normal', ''],
    keys.map((k) => {
      const P = PLATFORMS[k]; const s = sum[k];
      if (!s) return [P.label, '—', '—', '—', '—', '_not collected_', '—', ''];
      const audience = s.total === null ? (s.posts ? '_not measured yet_' : '—')
        : `${n(s.total)} ${P.metric}${s.measured < s.posts ? ` (${n(s.measured)} of ${n(s.posts)} posts measured)` : ''}`;
      return [P.label, n(s.posts), s.estatePosts ? `${((s.posts / s.estatePosts) * 100).toFixed(1)}%` : '—', n(s.accounts),
        audience, times(s.typical), s.scored ? `${n(s.aboveNormal)} of ${n(s.scored)}` : '—', verdict(s)];
    }));

  const sections = keys.filter((k) => sum[k] && sum[k].posts).map((k) => {
    const P = PLATFORMS[k]; const s = sum[k];
    const best = s.top.length ? table(['Posted', 'Account', 'Post', P.metric[0].toUpperCase() + P.metric.slice(1), '× normal'],
      s.top.map((r) => [String(P.when(r) || '').slice(0, 10), cell(P.name(r), 30),
        P.link(r) ? `[${cell(P.text(r).find(Boolean), 60) || 'open'}](${P.link(r)})` : cell(P.text(r).find(Boolean), 60), n(r._value), times(r._ratio)])) : '_No scored posts._';
    const acc = s.byAccount.slice(0, 8).map((a) => `${a.name || '—'}: ${n(a.posts)} post${a.posts === 1 ? '' : 's'}, ${n(a.total)} ${P.metric}, typical ${times(a.typical)}`).join(' · ');
    return `**${P.label}: best against their account's normal**\n\n${best}\n\n_By account (largest audience first):_ ${acc}${s.byAccount.length > 8 ? ` · and ${s.byAccount.length - 8} more` : ''}`;
  });

  const notes = [
    `Matched on any of: ${terms.map((t) => `"${t}"`).join(', ')} (case-insensitive, anywhere in the text). Facebook: post text. Instagram: caption and what is said in the video. X: post text. Add translations to cover every country: a post that never uses the words is not found.`,
    '"× normal" is a post\'s audience against the median of ALL its own account\'s posts in the same window, so a small page and a large one are comparable, and so are the three platforms. 1× is an ordinary post for that account. The audiences themselves are different measures (Facebook views, Instagram reach, X impressions) and must not be added together.',
    'Recent posts are still growing, so a window that ends today understates the newest posts.',
  ];
  if (corpus.x && corpus.x.some((r) => r.kind === 'spokesperson')) notes.push('X spokesperson accounts are left out: only their posts about CitizenGO are collected, so they have no normal to compare against. Use x_search_posts for them.');
  if (keys.some((k) => !sum[k])) notes.push(`Not collected here: ${keys.filter((k) => !sum[k]).map((k) => PLATFORMS[k].label).join(', ')}.`);
  notes.push('Google Trends (what the public is searching for) is not connected yet; this covers CitizenGO\'s own posts only. For allies, use ally_watch.');

  const head = `**Topic performance: ${terms.join(' / ')}, ${w.label}**`;
  return { text: `${head}\n\n${overview}\n\n${sections.join('\n\n')}${sections.length ? '\n\n' : ''}${notes.map((x) => `_${x}_`).join('\n\n')}`, summary: sum };
}

const TOPIC_TOOLS = [
  {
    name: 'topic_performance',
    description: 'How one topic did across ALL our platforms at once (Facebook, Instagram including what was said in videos, and X): how many posts, which accounts, the audience on each platform, and whether topic posts beat each account\'s normal, with the best posts. Use for "how is surrogacy doing across our channels", "compare assisted dying on Facebook, Instagram and X", "is gender ideology content working this quarter". Give translations and synonyms separated by commas so every country is covered, e.g. "assisted dying, eutanasia, suicidio asistido, fine vita". For a list of every matching post use search_posts and x_search_posts.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The topic: a word or phrase, or several separated by commas (translations, synonyms, hashtags).' },
        days: { type: 'number', description: 'Posts from the last N days (default 30, max 365).' },
        month: { type: 'string', description: 'A month, e.g. "2026-10" or "October 2026", instead of days.' },
        from: { type: 'string', description: 'Start date (YYYY-MM-DD), instead of days.' },
        to: { type: 'string', description: 'End date inclusive (YYYY-MM-DD).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: topicPerformance,
  },
];

module.exports = { TOPIC_TOOLS, topicPerformance, summarise, termsOf };
