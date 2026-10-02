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

// What kind of post each one is, exactly, from X's conversation_id and
// in_reply_to_user_id (view x_post_latest.thread_role), never from timing.
const ROLE_LABEL = { original: 'Post', thread_start: 'Thread start', thread: 'Thread', reply: 'Reply', quote: 'Quote' };
const role = (r) => ROLE_LABEL[r.thread_role] || '—';
const TYPES = {
  all: null,
  posts: ['original', 'thread_start', 'quote'],   // what appears on the profile's Posts tab
  threads: ['thread_start', 'thread'],
  replies: ['reply'],
  quotes: ['quote'],
};
const TYPE_PROP = { type: 'string', enum: Object.keys(TYPES),
  description: 'Which posts: all (default); posts = top-level posts only (no replies or later thread posts); threads = every post of our own threads; replies = replies to other accounts; quotes = quote posts.' };

// The window a list covers: a month or a from/to range when given (the same
// parsing as x_period_summary), otherwise the last N days.
function windowFor({ month, from, to, days }, dfltDays) {
  if (month || from || to) {
    const per = periodFor({ month, from, to });
    if (per.error) return { error: per.error };
    return { since: per.from, until: per.to, label: per.label };
  }
  const d = clampDays(days, dfltDays);
  return { since: sinceFor(d), until: undefined, label: d ? `last ${d} days` : 'all collected' };
}

// Paging. Every list can walk through all the posts we hold: page size up to
// 200 (what fits in one response), offset for the next page. The note tells the
// reader exactly which slice this is and how to get the next one, so a page is
// never mistaken for the whole (1 Oct 2026: 39 of 76 posts summed as August).
const PAGE_MAX = 200;
function pageNote(offset, shown, total, noun = 'Posts') {
  if (total === null || total === undefined) return '';
  const first = total ? offset + 1 : 0; const last = offset + shown;
  if (last < total) {
    return `\n\n_${noun} ${n(first)}-${n(last)} of ${n(total)}. For the next page, call again with offset ${last}. For totals over all ${n(total)}, use x_period_summary rather than adding up pages._`;
  }
  return offset > 0 ? `\n\n_${noun} ${n(first)}-${n(last)} of ${n(total)}: this is the last page._` : '';
}
const offsetOf = (v) => Math.max(0, Math.floor(Number(v) || 0));

async function topPosts(store, { account_id, days, month, from, to, sort = 'impressions', type = 'all', limit = 10, offset = 0 } = {}) {
  const w = windowFor({ month, from, to, days }, 30);
  if (w.error) return { text: w.error };
  const order = SORTS[sort] || 'impressions';
  const roles = TYPES[type] || null;
  const off = offsetOf(offset);
  const total = await store.xPostCount({ account_id, since: w.since, until: w.until, roles });
  const rows = await store.xPosts({ account_id, since: w.since, until: w.until, order, roles, limit: clampRows(limit, 10, PAGE_MAX), offset: off });
  if (!rows.length) return { text: total && off >= total ? `There are only ${n(total)} posts in this window; offset ${off} is past the end.` : `No X posts collected (${w.label}).` };
  // Long pages get shorter post text so a full page of 200 stays inside the
  // connector's response limit.
  const width = rows.length > 100 ? 45 : 70;
  return {
    text: `**X ${type === 'all' || !TYPES[type] ? 'posts' : type} by ${sort}, ${w.label}**\n\n` + table(
      ['#', 'Account', 'Post', 'Date', 'Type', 'Impressions', 'Likes', 'Reposts', 'Replies', 'Bookmarks', 'Link clicks', 'Eng. rate'],
      rows.map((r, i) => [String(off + i + 1), `@${r.username}`, link(r, truncate(r.text, width)), String(r.created_at).slice(0, 10), role(r),
        n(r.impressions), n(r.likes), n(r.reposts), n(r.replies), n(r.bookmarks), n(r.url_link_clicks), p(r.engagement_rate_pct)]),
    ) + pageNote(off, rows.length, total) + privateNote(rows) + spokesNote(rows),
    rows, total, offset: off,
  };
}

async function searchPosts(store, { query, hashtag, topic, account_id, days, month, from, to, type = 'all', limit = 15, offset = 0 } = {}) {
  if (!query && !hashtag && !topic) return { text: 'Give a query (words in the post), a hashtag or a topic.' };
  const w = windowFor({ month, from, to, days }, 0);
  if (w.error) return { text: w.error };
  const roles = TYPES[type] || null;
  const off = offsetOf(offset);
  const f = { q: query, hashtag, topic, account_id, since: w.since, until: w.until, roles };
  const what = [query && `"${query}"`, hashtag && `#${String(hashtag).replace(/^#/, '')}`, topic && `topic "${topic}"`].filter(Boolean).join(' + ');
  const total = await store.xPostCount(f);
  const rows = await store.xPosts({ ...f, order: 'impressions', limit: clampRows(limit, 15, PAGE_MAX), offset: off });
  const cover = (hashtag || topic) ? await coverageNote(store, { account_id, since: w.since, until: w.until }) : '';
  if (!rows.length) return { text: (total && off >= total ? `Only ${n(total)} posts match; offset ${off} is past the end.` : `No X posts matching ${what} (${w.label}).`) + cover };
  const width = rows.length > 100 ? 50 : 80;
  return {
    text: `**X posts matching ${what}, ${w.label}** (${n(total)} in all)\n\n` + table(
      ['#', 'Account', 'Post', 'Date', 'Type', 'Impressions', 'Interactions', 'Link clicks'],
      rows.map((r, i) => [String(off + i + 1), `@${r.username}`, link(r, truncate(r.text, width)), String(r.created_at).slice(0, 10), role(r),
        n(r.impressions), n(r.interactions), n(r.url_link_clicks)]),
    ) + pageNote(off, rows.length, total) + cover + privateNote(rows) + spokesNote(rows),
    rows, total, offset: off,
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

// Topics and hashtags were first collected on 2 Oct 2026, so only posts read
// since then carry them. Said whenever they are used, so a thin result is not
// read as "we never post about this".
async function coverageNote(store, { account_id, since, until }) {
  const [all, read] = await Promise.all([
    store.xPostCount({ account_id, since, until }), store.xPostCount({ account_id, since, until, refreshed: true })]);
  if (!all || read === null || read === undefined || read >= all) return '';
  return `\n\n_Hashtags and X topic labels exist on ${n(read)} of the ${n(all)} posts in this window: those read since 2 October 2026, when collection of them began. Posts read later fill in as they come up for their scheduled reads._`;
}

// Which hashtags or X topic labels go with posts that do well. min_posts keeps
// one viral post from topping the list on its own.
async function topTags(store, { kind = 'topic', account_id, days, month, from, to, min_posts = 3, limit = 25 } = {}) {
  const k = kind === 'hashtag' ? 'hashtag' : 'topic';
  const w = windowFor({ month, from, to, days }, 90);
  if (w.error) return { text: w.error };
  const since = w.since || '2000-01-01T00:00:00.000Z'; const until = w.until || new Date(Date.now() + 864e5).toISOString();
  const all = await store.xTagSummary({ kind: k, from: since, to: until, account_id, limit: 200 });
  const min = Math.max(1, Math.floor(Number(min_posts) || 1));
  const rows = all.filter((r) => Number(r.posts) >= min).slice(0, clampRows(limit, 25, PAGE_MAX));
  const cover = await coverageNote(store, { account_id, since: w.since, until: w.until });
  if (!rows.length) return { text: `No ${k}s on at least ${min} posts (${w.label}).${cover}` };
  return {
    text: `**X ${k === 'topic' ? 'topics (X\'s own labels)' : 'hashtags'} by impressions, ${w.label}**${min > 1 ? ` · on at least ${min} posts` : ''}\n\n` + table(
      ['#', k === 'topic' ? 'Topic' : 'Hashtag', ...(k === 'topic' ? ['Kind'] : []), 'Posts', 'Accounts', 'Impressions', 'Median per post', 'Engagements', 'Eng. rate'],
      rows.map((r, i) => [String(i + 1), String(r.tag).replace(/\|/g, '/'), ...(k === 'topic' ? [r.domains || '—'] : []),
        n(r.posts), n(r.accounts), n(r.impressions), n(Math.round(Number(r.median_impressions))), n(r.engagements), p(r.engagement_rate_pct)]),
    ) + `\n\n_${k === 'topic' ? 'Topics are labels X attaches to posts itself (people, organisations, interests). ' : ''}A post with several ${k}s counts under each. Median per post is the fairer comparison: one viral post can carry a total. To see the posts, use x_search_posts with ${k} set._` + cover,
    rows,
  };
}

// Video drop-off: of the people who started a video, how many reached a
// quarter, half, three quarters and the end. Quartiles are private metrics, so
// they exist only while X serves them (about 89 days) and from 2 Oct 2026.
async function videoPosts(store, { account_id, days, month, from, to, sort = 'views', limit = 20, offset = 0 } = {}) {
  const w = windowFor({ month, from, to, days }, 90);
  if (w.error) return { text: w.error };
  const order = { views: 'video_views', impressions: 'impressions', recent: 'created_at' }[sort] || 'video_views';
  const off = offsetOf(offset);
  const f = { account_id, since: w.since, until: w.until, video: true };
  const total = await store.xPostCount(f);
  const rows = await store.xPosts({ ...f, order, limit: clampRows(limit, 20, PAGE_MAX), offset: off });
  if (!rows.length) return { text: total && off >= total ? `Only ${n(total)} video posts here; offset ${off} is past the end.` : `No X video posts (${w.label}).` };
  const pct = (r, q) => (Number(r.video_playback_0) > 0 && r[`video_playback_${q}`] !== null && r[`video_playback_${q}`] !== undefined
    ? `${Math.round(100 * Number(r[`video_playback_${q}`]) / Number(r.video_playback_0))}%` : '—');
  const len = (ms) => (ms === null || ms === undefined ? '—' : `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}`);
  const width = rows.length > 100 ? 40 : 60;
  const withQ = rows.filter((r) => Number(r.video_playback_0) > 0).length;
  return {
    text: `**X video posts by ${sort}, ${w.label}** (${n(total)} in all)\n\n` + table(
      ['#', 'Account', 'Post', 'Date', 'Length', 'Views', 'Started', '25%', '50%', '75%', 'Watched to end'],
      rows.map((r, i) => [String(off + i + 1), `@${r.username}`, link(r, truncate(r.text, width)), String(r.created_at).slice(0, 10),
        len(r.video_duration_ms), n(r.video_views), n(r.video_playback_0), pct(r, 25), pct(r, 50), pct(r, 75), pct(r, 100)]),
    ) + pageNote(off, rows.length, total)
      + `\n\n_Percentages are of the people who started the video. Drop-off is a private metric: X gives it only for about 89 days after posting, and we collect it from 2 October 2026, so ${n(rows.length - withQ)} of these ${n(rows.length)} have none yet. Views are X's video view count._`,
    rows, total, offset: off,
  };
}

// Threads, found exactly: a conversation (X's conversation_id) that one of our
// posts started and the same account's own replies continued. No timing
// heuristic, so it holds for accounts whose posting gaps have no natural break.
const THREAD_SORTS = { impressions: 'impressions', engagement: 'engagements', rate: 'engagement_rate_pct',
  posts: 'posts', clicks: 'link_clicks', recent: 'started_at' };
async function listThreads(store, { account_id, days, month, from, to, sort = 'impressions', limit = 20, offset = 0 } = {}) {
  const w = windowFor({ month, from, to, days }, 90);
  if (w.error) return { text: w.error };
  const off = offsetOf(offset);
  const total = await store.xThreadCount({ account_id, since: w.since, until: w.until });
  const rows = await store.xThreads({ account_id, since: w.since, until: w.until, order: THREAD_SORTS[sort] || 'impressions',
    limit: clampRows(limit, 20, PAGE_MAX), offset: off });
  if (!rows.length) return { text: total && off >= total ? `Only ${n(total)} threads here; offset ${off} is past the end.` : `No X threads (${w.label}).` };
  const width = rows.length > 100 ? 45 : 70;
  const share = (r) => (Number(r.impressions) > 0 && r.first_post_impressions !== null && r.first_post_impressions !== undefined
    ? `${Math.round(100 * Number(r.first_post_impressions) / Number(r.impressions))}%` : '—');
  return {
    text: `**X threads by ${sort}, ${w.label}** (${n(total)} threads in all)\n\n` + table(
      ['#', 'Account', 'First post', 'Started', 'Posts', 'Impressions', 'On first post', 'Engagements', 'Eng. rate', 'Link clicks'],
      rows.map((r, i) => [String(off + i + 1), `@${r.username}`, link(r, truncate(r.first_post_text, width)), String(r.started_at).slice(0, 10),
        n(r.posts), n(r.impressions), share(r), n(r.engagements), p(r.engagement_rate_pct), n(r.link_clicks)]),
    ) + pageNote(off, rows.length, total, 'Threads')
      + '\n\n_A thread is a post continued by the same account\'s own replies, identified by X\'s conversation id. Impressions and engagements are summed over every post in the thread; "On first post" is the first post\'s share of them. Engagements are likes, reposts, quotes, replies and bookmarks._',
    rows, total, offset: off,
  };
}

// The attribution tool: every post that carried one of our links, which link,
// its UTM tags, and the clicks X recorded. This is the answer to "which tracking
// link did <spokesperson> use and did anyone click it".
async function linkPosts(store, { account_id, days, month, from, to, limit = 50, offset = 0 } = {}) {
  const w = windowFor({ month, from, to, days }, 90);
  if (w.error) return { text: w.error };
  const off = offsetOf(offset);
  const total = await store.xPostCount({ account_id, since: w.since, until: w.until, linkOnly: true });
  const rows = await store.xPosts({ account_id, since: w.since, until: w.until, order: 'created_at', limit: clampRows(limit, 50, PAGE_MAX), offset: off, linkOnly: true });
  if (!rows.length) return { text: total && off >= total ? `Only ${n(total)} posts carry a link here; offset ${off} is past the end.` : `No X posts carrying a CitizenGO link (${w.label}).` };
  const lines = [];
  for (const r of rows) {
    for (const url of (r.citizengo_urls || [])) {
      const utm = sched.utmOf(url) || {};
      lines.push([`@${r.username}`, link(r, String(r.created_at).slice(0, 10)), truncate(url.replace(/^https?:\/\//, ''), rows.length > 100 ? 40 : 60),
        truncate(utm.utm_campaign || utm.campaign || '—', rows.length > 100 ? 40 : 90), utm.utm_source || '—', n(r.url_link_clicks), n(r.impressions)]);
    }
  }
  return {
    text: `**X posts carrying CitizenGO links, ${w.label}** (${n(total)} posts in all)\n\n` + table(
      ['Account', 'Posted', 'Link', 'utm_campaign', 'utm_source', 'Link clicks', 'Impressions'], lines,
    ) + pageNote(off, rows.length, total) + privateNote(rows) + '\n\n_Clicks are X\'s count of taps on the link. Signatures and donations from those clicks are in the Bluebook under the UTM shown, not here._',
    rows, total, offset: off,
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
    ['Account', 'Posts', 'Impressions', 'Engagements', 'Eng. rate', 'Link clicks', 'Profile clicks', 'Followers', 'Top post'],
    rows.map((r) => [r.label || `@${r.username}`, n(r.posts), n(r.impressions), n(r.engagements), rate(r), n(r.link_clicks), n(r.profile_clicks), follow(r), top(r)]),
  );
  const notes = [
    `Totals cover every post published in ${per.label} (UTC), with each post's figures to date. That is a different basis from X Analytics, which counts activity that happened during the period on any post, so the two differ most when a post keeps growing after the period ends.`,
    "Engagements are likes, reposts, quotes, replies and bookmarks, the same definition as X Analytics, and engagement rate is engagements divided by impressions. X Analytics also counts Shares, which X does not make available to collect, so ours can run slightly lower. Link and profile clicks are reported separately and are not part of engagements. Retweets are not collected.",
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
  // Broken links and withheld posts: things someone should act on.
  const [broken, withheld] = await Promise.all([
    store.xLinkProblems({ minStatus: 400, oursOnly: true }).catch(() => []),
    store.xWithheld().catch(() => []),
  ]);
  const cutoff = new Date(Date.now() - 90 * 864e5).toISOString();
  const recent = broken.filter((b) => String(b.created_at) >= cutoff);
  if (recent.length) {
    lines.push(`- **Broken CitizenGO links in posts from the last 90 days: ${recent.length}** (X could not load the page)`);
    for (const b of recent.slice(0, 10)) lines.push(`  - @${b.username} ${String(b.created_at).slice(0, 10)}: ${b.url} → HTTP ${b.status} · [post](${b.permalink_url})`);
  } else {
    lines.push('- Broken CitizenGO links in posts from the last 90 days: none');
  }
  if (broken.length > recent.length) lines.push(`  - ${broken.length - recent.length} more in older posts, most likely campaign pages that have since closed`);
  if (withheld.length) {
    lines.push(`- **Posts X withholds in a country: ${withheld.length}**`);
    for (const w of withheld.slice(0, 10)) lines.push(`  - @${w.username} ${String(w.created_at).slice(0, 10)}, withheld in ${(w.withheld_in || []).join(', ')} · [post](${w.permalink_url})`);
  } else {
    lines.push('- Posts X withholds in a country: none');
  }
  lines.push('', '_Link status is the HTTP status X recorded when it fetched the page, on posts read since 2 October 2026; a site that blocks bots can show 403 while working for people. Private metrics (link clicks, profile clicks, organic/promoted split) exist only for posts collected while X still served them: documented as 30 days, observed to about 89. Link clicks appear only on posts that contain a link. Public metrics (impressions, likes, reposts, replies, bookmarks) have no window. Retweets are not collected. Spend is our estimate from resources returned; the X developer console is the invoice._');
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
    description: 'List X posts ranked by impressions, engagement, engagement rate, link clicks, reposts or bookmarks, or newest first. Covers every post we hold: pages of up to 200, with offset for the next page, so an account\'s whole month can be listed (pass account and month). For totals use x_period_summary instead of adding up pages. Link clicks exist only for posts collected while X served them, about the first 89 days.',
    inputSchema: {
      type: 'object',
      properties: {
        account: ACCOUNT_PROP,
        account_id: { type: 'string', description: 'Same as account; kept for older prompts.' },
        days: { type: 'number', description: 'Look back this many days (default 30). 0 for all collected data.' },
        month: { type: 'string', description: 'A month, e.g. "2026-08" or "August 2026", instead of days.' },
        from: { type: 'string', description: 'Start date (YYYY-MM-DD), instead of days.' },
        to: { type: 'string', description: 'End date inclusive (YYYY-MM-DD).' },
        offset: { type: 'number', description: 'Where the page starts, for paging through every post (0 = first). Each answer gives the offset of the next page.' },
        sort: { type: 'string', enum: Object.keys(SORTS), description: 'Ranking metric (default impressions; "recent" for newest first).' },
        type: TYPE_PROP,
        limit: { type: 'number', description: 'Posts per page (default 10, max 200).' },
      },
      additionalProperties: false,
    },
    handler: withAccount(topPosts),
  },
  {
    name: 'x_search_posts',
    description: 'Search every X post we hold by words in the text, by hashtag, or by X\'s own topic label, across all accounts or one, ranked by impressions, in pages of up to 200 with offset for the next. Use for questions about a topic, campaign or specific post on X. Give at least one of query, hashtag, topic.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Word or phrase in the post text (the full text, long posts included). Case-insensitive.' },
        hashtag: { type: 'string', description: 'A hashtag the post carries, with or without #. Whole tag, any case.' },
        topic: { type: 'string', description: 'An X topic label, or part of one (e.g. "Gavin Newsom", "abortion"). See x_topics for the labels in use.' },
        account: ACCOUNT_PROP,
        account_id: { type: 'string', description: 'Same as account; kept for older prompts.' },
        days: { type: 'number', description: 'Only posts from the last N days. Omit or 0 for all.' },
        month: { type: 'string', description: 'A month, e.g. "2026-08" or "August 2026", instead of days.' },
        from: { type: 'string', description: 'Start date (YYYY-MM-DD), instead of days.' },
        to: { type: 'string', description: 'End date inclusive (YYYY-MM-DD).' },
        offset: { type: 'number', description: 'Where the page starts, for paging through every post (0 = first). Each answer gives the offset of the next page.' },
        type: TYPE_PROP,
        limit: { type: 'number', description: 'Posts per page (default 15, max 200).' },
      },

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
    name: 'x_topics',
    description: 'Rank the topics (X\'s own labels: people, organisations, issues) or hashtags on our X posts by impressions, with posts, accounts, median impressions per post and engagement rate. Use for "which topics or hashtags do best on X". Default: topics, last 90 days, on at least 3 posts.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['topic', 'hashtag'], description: 'topic (default) or hashtag.' },
        account: ACCOUNT_PROP,
        account_id: { type: 'string', description: 'X account id. Prefer "account".' },
        days: { type: 'number', description: 'Posts from the last N days (default 90, 0 for all).' },
        month: { type: 'string', description: 'A month, e.g. "2026-08", instead of days.' },
        from: { type: 'string', description: 'Start date (YYYY-MM-DD), instead of days.' },
        to: { type: 'string', description: 'End date inclusive (YYYY-MM-DD).' },
        min_posts: { type: 'number', description: 'Only tags on at least this many posts (default 3; 1 for all).' },
        limit: { type: 'number', description: 'How many (default 25, max 200).' },
      },
      additionalProperties: false,
    },
    handler: withAccount(topTags),
  },
  {
    name: 'x_video_posts',
    description: 'List X posts with video: length, views, and how many viewers reached 25%, 50%, 75% and the end (as a share of those who started). Use for "how long do people watch our videos" or which videos hold attention. Pages of up to 200 with offset.',
    inputSchema: {
      type: 'object',
      properties: {
        account: ACCOUNT_PROP,
        account_id: { type: 'string', description: 'X account id. Prefer "account".' },
        days: { type: 'number', description: 'Posts from the last N days (default 90, 0 for all).' },
        month: { type: 'string', description: 'A month, e.g. "2026-08", instead of days.' },
        from: { type: 'string', description: 'Start date (YYYY-MM-DD), instead of days.' },
        to: { type: 'string', description: 'End date inclusive (YYYY-MM-DD).' },
        sort: { type: 'string', enum: ['views', 'impressions', 'recent'], description: 'Ranking (default views).' },
        limit: { type: 'number', description: 'Posts per page (default 20, max 200).' },
        offset: { type: 'number', description: 'Where the page starts (0 = first).' },
      },
      additionalProperties: false,
    },
    handler: withAccount(videoPosts),
  },
  {
    name: 'x_threads',
    description: 'List X threads: posts continued by the same account\'s own replies, found exactly from X\'s conversation id (no timing guesswork). Each row is one thread with its post count and impressions, engagements and link clicks summed over every post, and how much of that the first post drew. Ranked by impressions, engagement, rate, posts, clicks or newest; pages of up to 200 with offset; takes an account, days, month or from/to.',
    inputSchema: {
      type: 'object',
      properties: {
        account: ACCOUNT_PROP,
        account_id: { type: 'string', description: 'X account id (see x_list_accounts). Prefer "account".' },
        days: { type: 'number', description: 'Threads started in the last N days (default 90, 0 for all).' },
        month: { type: 'string', description: 'A month, e.g. "2026-08" or "August 2026", instead of days.' },
        from: { type: 'string', description: 'Start date (YYYY-MM-DD), instead of days.' },
        to: { type: 'string', description: 'End date inclusive (YYYY-MM-DD).' },
        sort: { type: 'string', enum: Object.keys(THREAD_SORTS), description: 'Ranking (default impressions).' },
        limit: { type: 'number', description: 'Threads per page (default 20, max 200).' },
        offset: { type: 'number', description: 'Where the page starts (0 = first). Each answer gives the offset of the next page.' },
      },
      additionalProperties: false,
    },
    handler: withAccount(listThreads),
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
        month: { type: 'string', description: 'A month, e.g. "2026-08" or "August 2026", instead of days.' },
        from: { type: 'string', description: 'Start date (YYYY-MM-DD), instead of days.' },
        to: { type: 'string', description: 'End date inclusive (YYYY-MM-DD).' },
        offset: { type: 'number', description: 'Where the page starts, for paging through every post (0 = first). Each answer gives the offset of the next page.' },
        limit: { type: 'number', description: 'Posts per page (default 50, max 200).' },
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
    description: 'Coverage, freshness, credentials needing re-authorisation, estimated month-to-date X API spend against budget, broken CitizenGO links in recent posts, and posts X withholds in a country. Call before presenting X numbers as complete.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (store) => dataHealth(store),
  },
];

module.exports = { X_TOOLS, enabled, resolveAccount, periodFor, pageNote, windowFor, PAGE_MAX };
