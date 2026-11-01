'use strict';
// uk_digest (1 Nov 2026): the daily UK monitoring digest - what moved yesterday
// among our allies and opponents - decided here, in code, so the scheduled
// Claude task that sends it only delivers it (the breakout-alerts pattern).
//
// Four signals, each a rule from docs/phase2-monitoring-scope.md:
//   1. Opponent post taking off: posted yesterday (UK date), 5x its own normal.
//   2. Ally post taking off: the same, for UK allies.
//   3. Converging hashtag: on 3+ watched accounts in the last 48 hours, and on
//      none of them in the 30 days before - the signature of a coordinated push.
//   4. Opponent ads: ads first seen in the last 24 hours, per organisation;
//      3 or more is flagged as a burst.
// A post is only ever "yesterday's" once, so nothing is announced twice. When
// nothing crosses a line the digest says so in one line and is not sent.

const n = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-GB'));
const cell = (s, len = 110) => {
  const one = String(s || '').replace(/[[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return one.length > len ? one.slice(0, len - 1) + '…' : one;
};
const HOUR = 3_600_000;
const BREAKOUT = 5;
const CONVERGE_ACCOUNTS = 3;
const AD_BURST = 3;
const NOTHING = 'Nothing crossed the line today.';

// The UK calendar date of an instant, so "yesterday" means the same to the
// reader in London whatever the server's clock is set to.
const ukDate = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
const hashtags = (caption) => [...new Set((String(caption || '').match(/#[\p{L}\p{N}_]{3,}/gu) || []).map((h) => h.toLowerCase()))];
const isUk = (p) => p.stance === 'opponent' || String(p.country || '').toUpperCase() === 'UK';

// Pure, exported for the tests. posts: peer_ig_latest rows from the last 30
// days; ads: opponent_ads rows first seen in the last 24 hours.
function buildDigest({ posts, ads, now = new Date() }) {
  const yesterday = ukDate(now.getTime() - 24 * HOUR);
  const uk = posts.filter(isUk);
  const takingOff = (stance) => uk
    .filter((p) => p.stance === stance && ukDate(p.timestamp) === yesterday && Number(p.vs_median) >= BREAKOUT)
    .sort((a, b) => b.vs_median - a.vs_median).slice(0, 5);
  const opp = takingOff('opponent');
  const ally = takingOff('ally');

  // Convergence: who used each tag recently, and was it new to all of them.
  const recentCut = now.getTime() - 48 * HOUR;
  const recent = new Map(); const before = new Set();
  for (const p of uk) {
    const t = Date.parse(p.timestamp);
    for (const h of hashtags(p.caption)) {
      if (t >= recentCut) {
        if (!recent.has(h)) recent.set(h, new Map());
        recent.get(h).set(p.username, p);
      } else before.add(h);
    }
  }
  const converging = [...recent].filter(([h, who]) => who.size >= CONVERGE_ACCOUNTS && !before.has(h))
    .map(([h, who]) => ({ tag: h, posts: [...who.values()] }))
    .sort((a, b) => b.posts.length - a.posts.length).slice(0, 5);

  const byOrg = new Map();
  for (const a of ads) {
    const k = a.label || a.page_name;
    if (!byOrg.has(k)) byOrg.set(k, { name: k, ads: [], lo: 0, hi: 0, cur: a.currency });
    const e = byOrg.get(k);
    e.ads.push(a); e.lo += Number(a.spend_lower) || 0; e.hi += Number(a.spend_upper) || Number(a.spend_lower) || 0;
  }
  const adOrgs = [...byOrg.values()].sort((a, b) => b.ads.length - a.ads.length);

  const sections = [];
  const postLine = (p) => `• **${cell(p.label || '@' + p.username, 40)}**: ${Number(p.vs_median).toLocaleString('en-GB', { maximumFractionDigits: 1 })}× its normal `
    + `(${n((Number(p.like_count) || 0) + (Number(p.comments_count) || 0))} likes + comments). `
    + (p.permalink ? `[${cell(p.caption, 90) || 'Open post'}](${p.permalink})` : cell(p.caption, 90));
  if (opp.length) sections.push(`**🔴 Opponent posts taking off**\n${opp.map(postLine).join('\n')}`);
  if (adOrgs.length) {
    sections.push(`**💸 New opponent ads (Meta Ad Library, UK issue ads)**\n` + adOrgs.map((e) => {
      const latest = e.ads.slice().sort((a, b) => String(b.delivery_start).localeCompare(String(a.delivery_start)))[0];
      const text = latest.link_titles || latest.bodies;
      return `• **${cell(e.name, 40)}**: ${e.ads.length} new ad${e.ads.length === 1 ? '' : 's'}${e.ads.length >= AD_BURST ? ' ⚠️ burst' : ''}, `
        + `spend ${e.cur || ''} ${n(e.lo)}–${n(e.hi)} so far. `
        + (latest.snapshot_url ? `[${cell(text, 90) || 'Latest ad'}](${latest.snapshot_url})` : cell(text, 90));
    }).join('\n'));
  }
  if (converging.length) {
    sections.push(`**🔗 Hashtags several accounts started using together**\n` + converging.map((c) => {
      const sides = [...new Set(c.posts.map((p) => p.stance))];
      const who = c.posts.map((p) => (p.permalink ? `[${cell(p.label || p.username, 30)}](${p.permalink})` : cell(p.label || p.username, 30))).join(', ');
      return `• **${c.tag}** on ${c.posts.length} accounts (${sides.length > 1 ? 'allies and opponents' : sides[0] === 'opponent' ? 'opponents' : 'allies'}), new in the last 48 hours: ${who}`;
    }).join('\n'));
  }
  if (ally.length) sections.push(`**🟢 Ally posts taking off (UK)**\n${ally.map(postLine).join('\n')}`);

  if (!sections.length) return { nothing: true, text: NOTHING, counts: { opp: 0, ally: 0, converging: 0, adOrgs: 0 } };
  const head = `_Automated UK monitoring digest for ${yesterday}: what moved among our allies and opponents yesterday._`;
  const foot = '_"× its normal" is likes + comments against that account\'s own median, so small and large accounts compare fairly. Opponents are UK organisations in their public role, from free public sources. Ask Claude with opponent_watch or ally_watch for more._';
  return { nothing: false, text: [head, ...sections, foot].join('\n\n'), counts: { opp: opp.length, ally: ally.length, converging: converging.length, adOrgs: adOrgs.length } };
}

async function ukDigest(store, args = {}) {
  const now = args.date && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? new Date(`${args.date}T08:00:00Z`) : new Date();
  const [posts, ads] = await Promise.all([
    store.peerRecent({ since: new Date(now.getTime() - 30 * 24 * HOUR).toISOString() }),
    store.opponentAdsSeen({ since: new Date(now.getTime() - 24 * HOUR).toISOString(), until: now.toISOString() }),
  ]);
  const d = buildDigest({ posts, ads, now });
  return { text: d.text, nothing: d.nothing, counts: d.counts };
}

const DIGEST_TOOLS = [
  {
    name: 'uk_digest',
    description: 'The daily UK monitoring digest, ready to send: opponent and ally posts that took off yesterday (5× their normal), new opponent ads (Meta Ad Library), and hashtags several watched accounts started using together. Returns the message text exactly as it should be sent, or "Nothing crossed the line today." when there is nothing to send. Use for "what moved yesterday" or to send the digest.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Build the digest as it would have been on this morning (YYYY-MM-DD). Omit for today.' },
      },
      additionalProperties: false,
    },
    handler: ukDigest,
  },
];

module.exports = { DIGEST_TOOLS, buildDigest, ukDigest, hashtags, ukDate, NOTHING };
