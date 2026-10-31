'use strict';
// ally_watch (30 Oct 2026): what peer organisations on our side are posting on
// Instagram, and which of their posts are doing well above that account's normal.
//
// Reads the peer_ig_latest view (sql/peer-schema.sql), filled by
// collector/peers-ig.js from config/peers-ig.json through business_discovery.
// Only likes and comments exist for other accounts (no reach, views or shares),
// so a post is never compared with ours: "x normal" is its likes + comments over
// its OWN account's median, which is what makes a 2,000-follower group's breakout
// as visible as a 200,000-follower one's.

const xt = require('./x-tools');

const n = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-GB'));
const clampRows = (v, dflt, max = 200) => Math.min(Math.max(Number(v) || dflt, 1), max);
const cell = (s, len = 70) => {
  const one = String(s || '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');
  return one.length > len ? one.slice(0, len - 1) + '…' : one;
};
function table(headers, rows) {
  return `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n` + rows.map((r) => `| ${r.join(' | ')} |`).join('\n');
}

const SORTS = { normal: 'vs_median', engagement: 'engagement', recent: 'timestamp' };
const typeOf = (r) => (r.media_product_type === 'REELS' ? 'Reel' : r.media_type === 'CAROUSEL_ALBUM' ? 'Carousel' : r.media_type === 'VIDEO' ? 'Video' : 'Photo');
// A post younger than three days is still gathering likes, so its multiple is a
// floor, not a final figure - and that is exactly the early signal worth seeing.
const multiple = (r) => (r.vs_median === null || r.vs_median === undefined ? '—' : `${Number(r.vs_median).toLocaleString('en-GB', { maximumFractionDigits: 1 })}×${r.settled ? '' : ' ↑'}`);

// Pure rendering, exported for the tests.
const WORDS = {
  ally: { title: 'Ally watch', who: 'Ally', plural: 'ally' },
  opponent: { title: 'Opponent watch', who: 'Organisation', plural: 'opponent' },
};
const stanceOf = (a) => a.stance || 'ally';

function render({ rows, accounts, label, off, min, limit, stance = 'ally' }) {
  const W = WORDS[stance];
  const read = accounts.filter((a) => a.last_status === 'ok');
  const lastRead = accounts.map((a) => a.last_checked_at).filter(Boolean).sort().pop();
  const head = `**${W.title} (Instagram), posts ${label}**\n\n${n(read.length)} ${W.plural} accounts read`
    + (lastRead ? `, last on ${String(lastRead).slice(0, 10)}` : '') + '.';
  const body = rows.length
    ? table([W.who, 'Country', 'Posted', 'Type', 'Caption', 'Likes', 'Comments', '× normal'], rows.map((r) => [
      cell(r.label || '@' + r.username, 40), r.country || '—',
      r.permalink ? `[${String(r.timestamp).slice(0, 10)}](${r.permalink})` : String(r.timestamp).slice(0, 10),
      typeOf(r), cell(r.caption, 80), n(r.like_count), n(r.comments_count), multiple(r)]))
    : `_No ${W.plural} posts${min ? ` at ${min}× normal or more` : ''} in this window._`;
  const notes = [
    '"× normal" is likes + comments against that account\'s own median over its last 120 days, so small and large groups are comparable. 5× or more is a breakout for that account.',
    '↑ marks posts under three days old: still gathering likes, so the multiple can only rise.',
    'Instagram only gives likes and comments for other organisations\' accounts: no reach, views or shares, so never compare these figures with our own posts.',
  ];
  const more = rows.length && rows.length === limit ? `\n\n_More may follow: call again with offset ${off + rows.length}._` : '';
  return `${head}\n\n${body}${more}\n\n${notes.map((x) => `_${x}_`).join('\n\n')}`;
}

async function allyWatch(store, args = {}) {
  const w = xt.windowFor({ month: args.month, from: args.from, to: args.to, days: args.days }, 7);
  if (w.error) return { text: w.error };
  const accounts = (await store.peerAccounts()).filter((a) => stanceOf(a) === 'ally');
  if (!accounts.length) return { text: 'Ally watch has not collected anything yet. The list of ally accounts is config/peers-ig.json; the "Peer watch (Instagram)" workflow reads them.' };
  const off = Math.max(Number(args.offset) || 0, 0);
  const limit = clampRows(args.limit, 25);
  const min = Number(args.min_multiple) > 0 ? Number(args.min_multiple) : null;
  const rows = await store.peerPosts({ stance: 'ally', account: args.account, country: args.country, topic: args.topic, q: args.query,
    min, since: w.since, until: w.until, order: SORTS[args.sort] || 'vs_median', limit, offset: off });
  return { text: render({ rows, accounts, label: w.label, off, min, limit }), rows };
}

// Opponents' paid campaigns, from the Ad Library rows. Pure, for the tests.
// Spend is a sum of Meta's published ranges, so it is reported as a range.
function renderAds(ads, label) {
  if (!ads.length) return `**Their ads (Meta Ad Library, UK issue ads), started ${label}**\n\n_No ads started in this window._`;
  const by = new Map();
  for (const a of ads) {
    const k = a.label || a.page_name;
    if (!by.has(k)) by.set(k, { name: k, ads: 0, running: 0, lo: 0, hi: 0, cur: a.currency, latest: a });
    const e = by.get(k);
    e.ads++; if (!a.delivery_stop) e.running++;
    e.lo += Number(a.spend_lower) || 0; e.hi += Number(a.spend_upper) || Number(a.spend_lower) || 0;
    if (String(a.delivery_start) > String(e.latest.delivery_start)) e.latest = a;
  }
  const rows = [...by.values()].sort((a, b) => b.hi - a.hi).map((e) => [
    cell(e.name, 40), n(e.ads), n(e.running), `${e.cur || ''} ${n(e.lo)}–${n(e.hi)}`.trim(),
    e.latest.snapshot_url ? `[${cell(e.latest.link_titles || e.latest.bodies || 'latest ad', 60)}](${e.latest.snapshot_url})` : cell(e.latest.link_titles || e.latest.bodies, 60)]);
  return `**Their ads (Meta Ad Library, UK issue ads), started ${label}**\n\n`
    + table(['Organisation', 'Ads started', 'Still running', 'Spend (Meta\'s ranges, summed)', 'Latest ad'], rows);
}

// The ads are labelled by organisation name, not Instagram handle, so a handle
// such as @bpas_1968 is turned into that account's name before filtering ads.
function adAccount(account, accounts) {
  if (!account) return account;
  const h = String(account).trim().replace(/^@/, '').toLowerCase();
  const hit = accounts.find((a) => String(a.username || '').toLowerCase() === h);
  return hit && hit.label ? hit.label : account;
}

async function opponentWatch(store, args = {}) {
  const w = xt.windowFor({ month: args.month, from: args.from, to: args.to, days: args.days }, 7);
  if (w.error) return { text: w.error };
  const accounts = (await store.peerAccounts()).filter((a) => stanceOf(a) === 'opponent');
  const off = Math.max(Number(args.offset) || 0, 0);
  const limit = clampRows(args.limit, 25);
  const min = Number(args.min_multiple) > 0 ? Number(args.min_multiple) : null;
  const [rows, ads] = await Promise.all([
    accounts.length ? store.peerPosts({ stance: 'opponent', account: args.account, topic: args.topic, q: args.query,
      min, since: w.since, until: w.until, order: SORTS[args.sort] || 'vs_median', limit, offset: off }) : [],
    store.opponentAds({ account: adAccount(args.account, accounts), topic: args.topic, q: args.query, since: w.since, until: w.until }),
  ]);
  if (!accounts.length && !ads.length) return { text: 'Opponent watch has not collected anything yet. The list is config/opponents-ig.json; the "Peer watch (Instagram)" workflow reads it daily.' };
  const posts = accounts.length ? render({ rows, accounts, label: w.label, off, min, limit, stance: 'opponent' }) : '_No opponent Instagram accounts read yet._';
  const note = '_UK organisations campaigning against us, in their public role only. Collected from free public sources and deleted after 120 days. Use it to see what they are pushing and spending on, early enough to respond._';
  return { text: `${posts}\n\n${renderAds(ads, w.label)}\n\n${note}`, rows, ads };
}

const PEER_TOOLS = [
  {
    name: 'opponent_watch',
    description: 'What UK organisations campaigning against us are doing: their Instagram posts ranked by how far each beats that account\'s normal, and the issue ads they are running on Facebook and Instagram (Meta Ad Library: ads started, still running, spend ranges, latest ad). Covers BPAS, Dignity in Dying, Stonewall, Mermaids, Good Law Project and others on abortion, assisted dying, gender and secularism. Use for "what are our opponents pushing this week", "is Dignity in Dying running ads", "how much is Good Law Project spending on trans ads", or to spot a campaign early enough to respond. Filter by organisation, topic or words.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'An organisation, by name or Instagram handle; partial names match.' },
        topic: { type: 'string', description: 'abortion, assisted-dying, gender, sex-education or secularism.' },
        query: { type: 'string', description: 'Word or phrase in the post caption or ad text. Case-insensitive.' },
        min_multiple: { type: 'number', description: 'Only posts at least this many times their account\'s normal, e.g. 5.' },
        sort: { type: 'string', enum: Object.keys(SORTS), description: 'normal (default), engagement, or recent.' },
        days: { type: 'number', description: 'Posts and ads from the last N days (default 7, 0 for all).' },
        month: { type: 'string', description: 'A month, e.g. "2026-10", instead of days.' },
        from: { type: 'string', description: 'Start date (YYYY-MM-DD).' },
        to: { type: 'string', description: 'End date inclusive (YYYY-MM-DD).' },
        limit: { type: 'number', description: 'Posts per page (default 25, max 200).' },
        offset: { type: 'number', description: 'Where the page starts (0 = first).' },
      },
      additionalProperties: false,
    },
    handler: opponentWatch,
  },
  {
    name: 'ally_watch',
    description: 'What allied organisations (Right To Life UK, SPUC, CARE, Christian Institute, Live Action and about 60 others in the UK, US, Ireland, Canada and Australia) are posting on Instagram, ranked by how far each post beats that account\'s own normal. Use for "what are our allies posting", "which ally posts are taking off this week", "what are pro-life groups saying about assisted dying", or to find content to reshare or adapt. Filter by account, country (UK, US, IE, CA, AU), topic (pro-life, family, gender, end-of-life, faith, persecution, policy, religious-freedom) or words in the caption. Likes and comments only; not comparable with our own posts.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'An ally, by Instagram handle or name; partial names match.' },
        country: { type: 'string', description: 'Country code: UK, US, IE, CA, AU.' },
        topic: { type: 'string', description: 'The ally\'s group: pro-life, family, gender, end-of-life, faith, persecution, policy, religious-freedom.' },
        query: { type: 'string', description: 'Word or phrase in the caption, e.g. "assisted suicide". Case-insensitive.' },
        min_multiple: { type: 'number', description: 'Only posts at least this many times their account\'s normal, e.g. 5 for breakouts.' },
        sort: { type: 'string', enum: Object.keys(SORTS), description: 'normal (default): most above the account\'s normal first; engagement: most likes + comments; recent: newest first.' },
        days: { type: 'number', description: 'Posts from the last N days (default 7, 0 for all).' },
        month: { type: 'string', description: 'A month, e.g. "2026-10", instead of days.' },
        from: { type: 'string', description: 'Start date (YYYY-MM-DD).' },
        to: { type: 'string', description: 'End date inclusive (YYYY-MM-DD).' },
        limit: { type: 'number', description: 'Posts per page (default 25, max 200).' },
        offset: { type: 'number', description: 'Where the page starts (0 = first).' },
      },
      additionalProperties: false,
    },
    handler: allyWatch,
  },
];

module.exports = { PEER_TOOLS, allyWatch, opponentWatch, render, renderAds, adAccount };
