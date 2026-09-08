'use strict';
// X (Twitter) tools. GROUNDWORK - exposed only when X_TOOLS_ENABLED=true, so
// nothing changes for connector users until the source is live. Same rules as
// mcp/tools.js: read the latest-snapshot view, never the append-only table;
// NULL is "X did not serve this", never zero; say what is missing.
//
// Two facts every answer must carry, because they are where X differs from
// Meta and where a confident wrong answer comes from:
//   * private metrics (link clicks, profile clicks, organic/promoted split)
//     exist only for posts collected inside their first 30 days;
//   * a spokesperson account is collected ONLY for posts carrying a CitizenGO
//     link, so its totals are not the account's totals.

const sched = require('../lib/xschedule');

const enabled = () => String(process.env.X_TOOLS_ENABLED || '').toLowerCase() === 'true';

const n = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-GB'));
const p = (v) => (v === null || v === undefined ? '—' : Number(v).toFixed(1) + '%');
const sinceFor = (days) => (!days || days <= 0 ? undefined : new Date(Date.now() - days * 86400000).toISOString());
const clampRows = (v, dflt, max = 200) => Math.min(Math.max(Number(v) || dflt, 1), max);
const clampDays = (v, dflt) => (v === undefined || v === null ? dflt : Math.min(Math.max(Number(v) || 0, 0), 3650));

function table(headers, rows) {
  if (!rows.length) return '_No rows._';
  const head = `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |`;
  return head + '\n' + rows.map((r) => `| ${r.join(' | ')} |`).join('\n');
}
function link(r, label) {
  const safe = String(label).replace(/\|/g, '\\|').replace(/\]/g, ')');
  return r.permalink_url ? `[${safe}](${r.permalink_url})` : safe;
}
function truncate(s, len) {
  const one = (s || '(no text)').replace(/\s+/g, ' ');
  return one.length > len ? one.slice(0, len - 1) + '…' : one;
}
const spokesNote = (rows) => (rows.some((r) => r.kind === 'spokesperson')
  ? '\n\n_Spokesperson accounts are collected only for posts that carry a CitizenGO link. Their figures describe those posts, not the whole account._' : '');
const privateNote = (rows) => {
  const closed = rows.filter((r) => r.url_link_clicks === null).length;
  return closed ? `\n\n_${closed} of ${rows.length} posts show "—" for clicks: X serves link and profile clicks only inside a post's first 30 days, and these were not collected in that window._` : '';
};

async function listAccounts(store) {
  const rows = await store.xAccounts();
  if (!rows.length) return { text: 'No X accounts have been connected yet.' };
  return {
    text: `**${rows.length} X account(s) connected**\n\n` + table(
      ['Account', 'Handle', 'Kind', 'Country', 'Followers', 'Credential'],
      rows.map((a) => [a.name || a.label || a.account_id, `@${a.username}`, a.kind, a.country || '—',
        n(a.followers_count), a.credential_status || '—']),
    ) + spokesNote(rows),
    accounts: rows.map((a) => ({ account_id: a.account_id, username: a.username, kind: a.kind, country: a.country })),
  };
}

const SORTS = { impressions: 'impressions', engagement: 'interactions', rate: 'engagement_rate_pct',
  clicks: 'url_link_clicks', reposts: 'reposts', bookmarks: 'bookmarks', recent: 'created_at' };

async function topPosts(store, { account_id, days = 30, sort = 'impressions', limit = 10 } = {}) {
  const d = clampDays(days, 30);
  const order = SORTS[sort] || 'impressions';
  const rows = await store.xPosts({ account_id, since: sinceFor(d), order, limit: clampRows(limit, 10) });
  if (!rows.length) return { text: `No X posts collected${d ? ` in the last ${d} days` : ''}.` };
  return {
    text: `**Top X posts by ${sort}${d ? `, last ${d} days` : ''}**\n\n` + table(
      ['Account', 'Post', 'Date', 'Impressions', 'Likes', 'Reposts', 'Replies', 'Bookmarks', 'Link clicks', 'Eng. rate'],
      rows.map((r) => [`@${r.username}`, link(r, truncate(r.text, 70)), String(r.created_at).slice(0, 10),
        n(r.impressions), n(r.likes), n(r.reposts), n(r.replies), n(r.bookmarks), n(r.url_link_clicks), p(r.engagement_rate_pct)]),
    ) + privateNote(rows) + spokesNote(rows),
    rows,
  };
}

async function searchPosts(store, { query, account_id, days = 0, limit = 15 } = {}) {
  const rows = await store.xPosts({ q: query, account_id, since: sinceFor(clampDays(days, 0)), order: 'impressions', limit: clampRows(limit, 15) });
  if (!rows.length) return { text: `No X posts matching "${query}".` };
  return {
    text: `**X posts matching "${query}"** (${rows.length})\n\n` + table(
      ['Account', 'Post', 'Date', 'Impressions', 'Interactions', 'Link clicks'],
      rows.map((r) => [`@${r.username}`, link(r, truncate(r.text, 80)), String(r.created_at).slice(0, 10),
        n(r.impressions), n(r.interactions), n(r.url_link_clicks)]),
    ) + privateNote(rows) + spokesNote(rows),
    rows,
  };
}

async function accountGrowth(store, { account_id, days = 30 } = {}) {
  const d = clampDays(days, 30);
  const rows = await store.xAccountGrowth({ account_id, since: sinceFor(d) ? sinceFor(d).slice(0, 10) : undefined });
  if (!rows.length) return { text: 'No X follower history collected yet.' };
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.account_id)) by.set(r.account_id, { username: r.username, first: r, last: r, days: 0, change: 0 });
    const a = by.get(r.account_id);
    a.last = r; a.days += 1; a.change += Number(r.followers_change) || 0;
  }
  const out = [...by.values()].sort((a, b) => (b.change - a.change));
  return {
    text: `**X follower movement, last ${d} days**\n\n` + table(
      ['Account', 'Followers now', 'Change', 'Days observed', 'Posts (total)'],
      out.map((a) => [`@${a.username}`, n(a.last.followers_count), (a.change >= 0 ? '+' : '') + n(a.change), String(a.days), n(a.last.post_count)]),
    ) + '\n\n_Change is the sum of day-to-day differences in the follower count over the days collected. X serves no per-post follower attribution._',
    rows,
  };
}

// The attribution tool: every post that carried one of our links, which link,
// its UTM tags, and the clicks X recorded. This is the answer to "which tracking
// link did <spokesperson> use and did anyone click it".
async function linkPosts(store, { account_id, days = 90, limit = 50 } = {}) {
  const d = clampDays(days, 90);
  const rows = await store.xPosts({ account_id, since: sinceFor(d), order: 'created_at', limit: clampRows(limit, 50), linkOnly: true });
  if (!rows.length) return { text: `No X posts carrying a CitizenGO link${d ? ` in the last ${d} days` : ''}.` };
  const lines = [];
  for (const r of rows) {
    for (const url of (r.citizengo_urls || [])) {
      const utm = sched.utmOf(url) || {};
      lines.push([`@${r.username}`, link(r, String(r.created_at).slice(0, 10)), truncate(url.replace(/^https?:\/\//, ''), 60),
        utm.utm_campaign || utm.campaign || '—', utm.utm_source || '—', n(r.url_link_clicks), n(r.impressions)]);
    }
  }
  return {
    text: `**X posts carrying CitizenGO links${d ? `, last ${d} days` : ''}** (${rows.length} posts, ${lines.length} links)\n\n` + table(
      ['Account', 'Posted', 'Link', 'utm_campaign', 'utm_source', 'Link clicks', 'Impressions'], lines,
    ) + privateNote(rows) + '\n\n_Clicks are X\'s count of taps on the link. Signatures and donations from those clicks are in the Bluebook under the UTM shown, not here._',
    rows,
  };
}

async function dataHealth(store) {
  const [accounts, fresh, spend] = await Promise.all([store.xAccounts(), store.xFreshness(), store.xSpend()]);
  const lines = [`**X data health**`, ''];
  lines.push(`- Accounts connected: **${accounts.length}** (${accounts.filter((a) => a.kind === 'spokesperson').length} spokesperson)`);
  const needs = accounts.filter((a) => a.credential_status && a.credential_status !== 'live');
  if (needs.length) lines.push(`- **Needs re-authorisation:** ${needs.map((a) => '@' + a.username).join(', ')}`);
  lines.push(`- Most recent collection: **${fresh.latest || 'never'}**${fresh.recentFailures ? ` · ${fresh.recentFailures} failed run(s) recently` : ''}`);
  lines.push(`- Posts held: **${n(fresh.posts)}** · with private metrics: **${n(fresh.withPrivate)}**`);
  if (spend) {
    lines.push(`- Estimated X spend this month: **$${Number(spend.est_cost_usd || 0).toFixed(2)}** of $${spend.budget} budget (${n(spend.post_reads)} post reads, ${n(spend.user_reads)} user reads)`);
  }
  lines.push('', '_Private metrics (link clicks, profile clicks, organic/promoted split) exist only for posts collected inside their first 30 days. Public metrics (impressions, likes, reposts, replies, bookmarks) have no window. Spend is our estimate from resources returned; the X developer console is the invoice._');
  return { text: lines.join('\n') };
}

const X_TOOLS = [
  {
    name: 'x_list_accounts',
    description: 'List every X (Twitter) account being collected, with handle, kind (organisation or spokesperson), country, follower count and whether its credential is live. Call this first for an account_id.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (store) => listAccounts(store),
  },
  {
    name: 'x_top_posts',
    description: 'Rank X posts by impressions, engagement, engagement rate, link clicks, reposts or bookmarks. Use for "which of our X posts did best". Link clicks exist only for posts collected within 30 days of posting.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Restrict to one account. Omit for all. Get ids from x_list_accounts.' },
        days: { type: 'number', description: 'Look back this many days (default 30). 0 for all collected data.' },
        sort: { type: 'string', enum: Object.keys(SORTS), description: 'Ranking metric (default impressions).' },
        limit: { type: 'number', description: 'How many posts (default 10, max 200).' },
      },
      additionalProperties: false,
    },
    handler: (store, args) => topPosts(store, args),
  },
  {
    name: 'x_search_posts',
    description: 'Search the text of collected X posts across every account, ranked by impressions. Use for questions about a topic, campaign or specific post on X.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Word or phrase in the post text. Case-insensitive.' },
        account_id: { type: 'string', description: 'Restrict to one account.' },
        days: { type: 'number', description: 'Only posts from the last N days. Omit or 0 for all.' },
        limit: { type: 'number', description: 'Maximum posts (default 15, max 200).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: (store, args) => searchPosts(store, args),
  },
  {
    name: 'x_account_growth',
    description: 'Follower movement per X account over a period, from daily snapshots. Use for "are we growing on X" or "which X account gained most followers".',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Restrict to one account. Omit for all.' },
        days: { type: 'number', description: 'Window in days (default 30).' },
      },
      additionalProperties: false,
    },
    handler: (store, args) => accountGrowth(store, args),
  },
  {
    name: 'x_link_posts',
    description: 'Every X post that carried a CitizenGO link (citizengo.org, hazteoir.org, cgo.ac), with the link, its UTM campaign and source, and the link clicks X recorded. Use for attribution questions: "which tracking link did <spokesperson> share", "did anyone click the link in our X posts". Signatures from those clicks are in the Bluebook under the same UTM.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Restrict to one account (e.g. a spokesperson).' },
        days: { type: 'number', description: 'Look back this many days (default 90, 0 for all).' },
        limit: { type: 'number', description: 'Maximum posts (default 50, max 200).' },
      },
      additionalProperties: false,
    },
    handler: (store, args) => linkPosts(store, args),
  },
  {
    name: 'x_data_health',
    description: 'Coverage, freshness, credentials needing re-authorisation and estimated month-to-date X API spend against budget. Call before presenting X numbers as complete.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (store) => dataHealth(store),
  },
];

module.exports = { X_TOOLS, enabled };
