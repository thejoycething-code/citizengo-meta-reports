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
function render({ rows, accounts, label, off, min, limit }) {
  const read = accounts.filter((a) => a.last_status === 'ok');
  const lastRead = accounts.map((a) => a.last_checked_at).filter(Boolean).sort().pop();
  const head = `**Ally watch (Instagram), posts ${label}**\n\n${n(read.length)} ally accounts read`
    + (lastRead ? `, last on ${String(lastRead).slice(0, 10)}` : '') + '.';
  const body = rows.length
    ? table(['Ally', 'Country', 'Posted', 'Type', 'Caption', 'Likes', 'Comments', '× normal'], rows.map((r) => [
      cell(r.label || '@' + r.username, 40), r.country || '—',
      r.permalink ? `[${String(r.timestamp).slice(0, 10)}](${r.permalink})` : String(r.timestamp).slice(0, 10),
      typeOf(r), cell(r.caption, 80), n(r.like_count), n(r.comments_count), multiple(r)]))
    : `_No ally posts${min ? ` at ${min}× normal or more` : ''} in this window._`;
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
  const accounts = await store.peerAccounts();
  if (!accounts.length) return { text: 'Ally watch has not collected anything yet. The list of ally accounts is config/peers-ig.json; the "Peer watch (Instagram)" workflow reads them.' };
  const off = Math.max(Number(args.offset) || 0, 0);
  const limit = clampRows(args.limit, 25);
  const min = Number(args.min_multiple) > 0 ? Number(args.min_multiple) : null;
  const rows = await store.peerPosts({ account: args.account, country: args.country, topic: args.topic, q: args.query,
    min, since: w.since, until: w.until, order: SORTS[args.sort] || 'vs_median', limit, offset: off });
  return { text: render({ rows, accounts, label: w.label, off, min, limit }), rows };
}

const PEER_TOOLS = [
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

module.exports = { PEER_TOOLS, allyWatch, render };
