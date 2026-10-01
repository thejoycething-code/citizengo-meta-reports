'use strict';
// X (Twitter) tools. GROUNDWORK - exposed only when X_TOOLS_ENABLED=true, so
// nothing changes for connector users until the source is live. Same rules as
// mcp/tools.js: read the latest-snapshot view, never the append-only table;
// NULL is "X did not serve this", never zero; say what is missing.
//
// Two facts every answer must carry, because they are where X differs from
// Meta and where a confident wrong answer comes from:
//   * private metrics (link clicks, profile clicks, organic/promoted split)
//     exist only for posts collected while X still served them (documented 30
//     days, observed ~89 on 30 Sep 2026);
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
// Two different reasons a click column is empty, and they must not be
// confused: X had stopped serving private metrics when the post was collected,
// or the post simply had no link (X then returns no link-click field at all).
const privateNote = (rows) => {
  const closed = rows.filter((r) => !r.private_window_open).length;
  const noLink = rows.filter((r) => r.private_window_open && r.url_link_clicks === null).length;
  const parts = [];
  if (closed) parts.push(`${closed} of ${rows.length} posts have no link or profile clicks because X no longer served private metrics when they were collected (X keeps them for roughly the first 30 to 90 days).`);
  if (noLink) parts.push(`${noLink} show "—" for link clicks because the post contained no link.`);
  return parts.length ? `\n\n_${parts.join(' ')}_` : '';
};

// ---------------------------------------------------------------------------
// Which account. Staff ask for "@CitizenGO" or "the UK account", not a numeric
// id; on 1 Oct 2026 Claude told Filip the tools "won't let me filter to
// @CitizenGO alone" because they only took account_id. Every tool now takes
// `account` as a handle, a label or an id, and resolves it here.
// ---------------------------------------------------------------------------
async function resolveAccount(store, value) {
  if (value === undefined || value === null || String(value).trim() === '') return { id: undefined };
  const raw = String(value).trim();
  if (/^\d{5,}$/.test(raw)) return { id: raw };
  const want = raw.replace(/^@/, '').toLowerCase();
  const accounts = await store.xAccounts();
  const norm = (v) => String(v || '').toLowerCase();
  const exact = accounts.filter((a) => norm(a.username) === want || norm(a.label) === want || norm(a.name) === want);
  if (exact.length === 1) return { id: exact[0].account_id, account: exact[0] };
  const partial = accounts.filter((a) => norm(a.username).includes(want) || norm(a.label).includes(want));
  if (partial.length === 1) return { id: partial[0].account_id, account: partial[0] };
  const list = accounts.map((a) => `@${a.username} (${a.label})`).join(', ');
  return { error: partial.length > 1
    ? `"${raw}" matches more than one X account: ${partial.map((a) => '@' + a.username).join(', ')}. Say which.`
    : `No connected X account matches "${raw}". Connected: ${list}.` };
}
const withAccount = (fn) => async (store, args = {}) => {
  const r = await resolveAccount(store, args.account !== undefined ? args.account : args.account_id);
  if (r.error) return { text: r.error };
  const { account, ...rest } = args;
  return fn(store, { ...rest, account_id: r.id });
};

// Said whenever a ranked list is cut short, so nobody adds up a top-N list and
// takes it for a total (the 1 Oct 2026 failure: 39 of 76 posts summed as August).
const cutNote = (shown, total) => (total !== null && total !== undefined && total > shown
  ? `\n\n_Showing ${shown} of ${n(total)} posts in this window. This is a ranked list, not a total: for monthly or period totals use x_period_summary._`
  : '');

const ACCOUNT_PROP = { type: 'string', description: 'One account, by handle (e.g. "@CitizenGO" or "CitizenGO_GB"), name (e.g. "CitizenGO UK") or id. Omit for every account.' };

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
  const total = await store.xPostCount({ account_id, since: sinceFor(d) });
  return {
    text: `**Top X posts by ${sort}${d ? `, last ${d} days` : ''}**\n\n` + table(
      ['Account', 'Post', 'Date', 'Impressions', 'Likes', 'Reposts', 'Replies', 'Bookmarks', 'Link clicks', 'Eng. rate'],
      rows.map((r) => [`@${r.username}`, link(r, truncate(r.text, 70)), String(r.created_at).slice(0, 10),
        n(r.impressions), n(r.likes), n(r.reposts), n(r.replies), n(r.bookmarks), n(r.url_link_clicks), p(r.engagement_rate_pct)]),
    ) + cutNote(rows.length, total) + privateNote(rows) + spokesNote(rows),
    rows,
  };
}

async function searchPosts(store, { query, account_id, days = 0, limit = 15 } = {}) {
  const rows = await store.xPosts({ q: query, account_id, since: sinceFor(clampDays(days, 0)), order: 'impressions', limit: clampRows(limit, 15) });
  if (!rows.length) return { text: `No X posts matching "${query}".` };
  const total = await store.xPostCount({ q: query, account_id, since: sinceFor(clampDays(days, 0)) });
  return {
    text: `**X posts matching "${query}"** (${rows.length})\n\n` + table(
      ['Account', 'Post', 'Date', 'Impressions', 'Interactions', 'Link clicks'],
      rows.map((r) => [`@${r.username}`, link(r, truncate(r.text, 80)), String(r.created_at).slice(0, 10),
        n(r.impressions), n(r.interactions), n(r.url_link_clicks)]),
    ) + cutNote(rows.length, total) + privateNote(rows) + spokesNote(rows),
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
  const total = await store.xPostCount({ account_id, since: sinceFor(d), linkOnly: true });
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
    ) + cutNote(rows.length, total) + privateNote(rows) + '\n\n_Clicks are X\'s count of taps on the link. Signatures and donations from those clicks are in the Bluebook under the UTM shown, not here._',
    rows,
  };
}

// ---------------------------------------------------------------------------
// Period totals - the monthly X report. Built for Filip's sheet (engagements,
// engagement rate, impressions per account per month), which campaigners fill
// by hand from X Analytics.
//
// The basis differs from X Analytics and every answer says so: X Analytics
// counts activity that HAPPENED in the period, on any post; this counts posts
// PUBLISHED in the period, with their totals to date. On August 2026 the two
// agreed within ~10% for most accounts, and diverged where a post kept growing
// after the month ended (one Mexico post: 40,767 impressions).
// ---------------------------------------------------------------------------
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function periodFor({ month, from, to } = {}, now = new Date()) {
  const iso = (d) => d.toISOString();
  if (from || to) {
    const f = from ? new Date(String(from).slice(0, 10) + 'T00:00:00Z') : null;
    const t = to ? new Date(new Date(String(to).slice(0, 10) + 'T00:00:00Z').getTime() + 86400000) : now;
    if (!f || Number.isNaN(f.getTime()) || Number.isNaN(t.getTime()) || t <= f) return { error: 'Give "from" and "to" as dates like 2026-08-01, with "to" on or after "from".' };
    return { from: iso(f), to: iso(t), label: `${String(from).slice(0, 10)} to ${to ? String(to).slice(0, 10) : 'today'}` };
  }
  let y; let m;
  if (month) {
    const t = String(month).trim().toLowerCase();
    let mm = t.match(/^(\d{4})-(\d{1,2})$/);
    if (mm) { y = Number(mm[1]); m = Number(mm[2]) - 1; } else {
      const name = MONTHS.findIndex((x) => t.startsWith(x.slice(0, 3)));
      mm = t.match(/(\d{4})/);
      if (name === -1) return { error: 'Give the month as 2026-08 or "August 2026".' };
      m = name; y = mm ? Number(mm[1]) : now.getUTCFullYear();
    }
  } else {
    y = now.getUTCFullYear(); m = now.getUTCMonth() - 1;
    if (m < 0) { m = 11; y -= 1; }
  }
  if (!(m >= 0 && m <= 11)) return { error: 'Give the month as 2026-08 or "August 2026".' };
  const f = new Date(Date.UTC(y, m, 1)); const t = new Date(Date.UTC(y, m + 1, 1));
  return { from: iso(f), to: iso(t), label: `${MONTHS[m][0].toUpperCase()}${MONTHS[m].slice(1)} ${y}` };
}

async function periodSummary(store, { month, from, to, account_id } = {}) {
  const per = periodFor({ month, from, to });
  if (per.error) return { text: per.error };
  const rows = await store.xPeriodSummary({ from: per.from, to: per.to, account_id });
  if (!rows.length) return { text: 'No connected X accounts.' };
  const tot = rows.reduce((t, r) => ({
    posts: t.posts + Number(r.posts || 0), imp: t.imp + Number(r.impressions || 0), eng: t.eng + Number(r.engagements || 0),
  }), { posts: 0, imp: 0, eng: 0 });
  const follow = (r) => {
    if (r.followers_first === null || r.followers_first === undefined) return '—';
    if (r.followers_first_date === r.followers_last_date) return `${n(r.followers_last)} (one day only)`;
    const d = Number(r.followers_last) - Number(r.followers_first);
    return `${d >= 0 ? '+' : ''}${n(d)}`;
  };
  const rate = (r) => (r.engagement_rate_pct === null || r.engagement_rate_pct === undefined ? '—' : `${Number(r.engagement_rate_pct).toFixed(2)}%`);
  const top = (r) => (r.top_post_url
    ? `[${truncate(r.top_post_text, 40).replace(/\|/g, '\\|').replace(/\]/g, ')')}](${r.top_post_url}) (${n(r.top_post_impressions)})` : '—');
  const body = table(
    ['Account', 'Posts', 'Impressions', 'Engagements', 'Eng. rate', 'Link clicks', 'Followers', 'Top post'],
    rows.map((r) => [r.label || `@${r.username}`, n(r.posts), n(r.impressions), n(r.engagements), rate(r), n(r.link_clicks), follow(r), top(r)]),
  );
  const notes = [
    `Totals cover every post published in ${per.label} (UTC), with each post's figures to date. That is a different basis from X Analytics, which counts activity that happened during the period on any post, so the two differ most when a post keeps growing after the period ends.`,
    "Engagement rate is X's own engagements divided by impressions, as in X Analytics. Retweets are not collected.",
    'Follower change is only available from 30 September 2026, when daily follower snapshots began. A dash means no snapshots in the period.',
  ];
  const idle = rows.filter((r) => !Number(r.posts)).map((r) => r.label || r.username);
  if (idle.length) notes.push(`No posts in the period: ${idle.join(', ')}.`);
  return {
    text: `**X summary, ${per.label}**${account_id ? '' : ` · ${rows.length} accounts · ${n(tot.posts)} posts · ${n(tot.imp)} impressions · ${n(tot.eng)} engagements`}\n\n`
      + body + '\n\n' + notes.map((x) => `_${x}_`).join('\n\n') + spokesNote(rows),
    rows, period: per,
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
  lines.push('', '_Private metrics (link clicks, profile clicks, organic/promoted split) exist only for posts collected while X still served them: documented as 30 days, observed to about 89. Link clicks appear only on posts that contain a link. Public metrics (impressions, likes, reposts, replies, bookmarks) have no window. Retweets are not collected. Spend is our estimate from resources returned; the X developer console is the invoice._');
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
        account: ACCOUNT_PROP,
        account_id: { type: 'string', description: 'Same as account; kept for older prompts.' },
        days: { type: 'number', description: 'Look back this many days (default 30). 0 for all collected data.' },
        sort: { type: 'string', enum: Object.keys(SORTS), description: 'Ranking metric (default impressions).' },
        limit: { type: 'number', description: 'How many posts (default 10, max 200).' },
      },
      additionalProperties: false,
    },
    handler: withAccount(topPosts),
  },
  {
    name: 'x_search_posts',
    description: 'Search the text of collected X posts across every account, ranked by impressions. Use for questions about a topic, campaign or specific post on X.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Word or phrase in the post text. Case-insensitive.' },
        account: ACCOUNT_PROP,
        account_id: { type: 'string', description: 'Same as account; kept for older prompts.' },
        days: { type: 'number', description: 'Only posts from the last N days. Omit or 0 for all.' },
        limit: { type: 'number', description: 'Maximum posts (default 15, max 200).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: withAccount(searchPosts),
  },
  {
    name: 'x_account_growth',
    description: 'Follower movement per X account over a period, from daily snapshots. Use for "are we growing on X" or "which X account gained most followers".',
    inputSchema: {
      type: 'object',
      properties: {
        account: ACCOUNT_PROP,
        account_id: { type: 'string', description: 'Same as account; kept for older prompts.' },
        days: { type: 'number', description: 'Window in days (default 30).' },
      },
      additionalProperties: false,
    },
    handler: withAccount(accountGrowth),
  },
  {
    name: 'x_link_posts',
    description: 'Every X post that carried a CitizenGO link (citizengo.org, hazteoir.org, cgo.ac), with the link, its UTM campaign and source, and the link clicks X recorded. Use for attribution questions: "which tracking link did <spokesperson> share", "did anyone click the link in our X posts". Signatures from those clicks are in the Bluebook under the same UTM.',
    inputSchema: {
      type: 'object',
      properties: {
        account: ACCOUNT_PROP,
        account_id: { type: 'string', description: 'Same as account; kept for older prompts.' },
        days: { type: 'number', description: 'Look back this many days (default 90, 0 for all).' },
        limit: { type: 'number', description: 'Maximum posts (default 50, max 200).' },
      },
      additionalProperties: false,
    },
    handler: withAccount(linkPosts),
  },
  {
    name: 'x_period_summary',
    description: 'Totals per X account for a month or date range: posts, impressions, engagements, engagement rate, link clicks, follower change and the top post, counted over EVERY post in the period (no row cap). Use this for monthly X reports and any "how many impressions did we get in August" question, never by adding up x_top_posts. Defaults to last calendar month.',
    inputSchema: {
      type: 'object',
      properties: {
        month: { type: 'string', description: 'A month, e.g. "2026-08" or "August 2026". Default: last calendar month.' },
        from: { type: 'string', description: 'Start date (YYYY-MM-DD), instead of month.' },
        to: { type: 'string', description: 'End date inclusive (YYYY-MM-DD). Default today.' },
        account: ACCOUNT_PROP,
      },
      additionalProperties: false,
    },
    handler: withAccount(periodSummary),
  },
  {
    name: 'x_data_health',
    description: 'Coverage, freshness, credentials needing re-authorisation and estimated month-to-date X API spend against budget. Call before presenting X numbers as complete.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (store) => dataHealth(store),
  },
];

module.exports = { X_TOOLS, enabled, resolveAccount, periodFor, cutNote };
