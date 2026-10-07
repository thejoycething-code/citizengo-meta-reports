'use strict';
// Two explicit stores, no implicit fallback.
//
// The Vercel functions construct supabaseStore ONLY and fail loudly without
// credentials. A silent fallback to local files would let a misconfigured
// deployment serve stale data that looks fine — the worst possible failure for
// a reporting tool.

const fs = require('fs');
const path = require('path');
const { withRetry } = require('./retry');

const TABLES = ['meta_pages', 'meta_posts', 'meta_post_metrics'];

function fileStore({ dir }) {
  function read(table) {
    const f = path.join(dir, `${table}.ndjson`);
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
  return {
    name: 'ndjson',
    async loadAll() {
      return { pages: read('meta_pages'), posts: read('meta_posts'), metrics: read('meta_post_metrics') };
    },
    // The collector's NDJSON sink writes no Instagram, so the local backend has
    // none to give. Empty rather than absent, so the mirror reports "0 rows"
    // instead of throwing.
    async igFeed() { return []; },
    // Same contract as the Supabase store so the tools cannot tell them apart.
    // All three filter server-side. At 36 pages a demographics table alone is
    // thousands of rows, and no tool needs them all in memory.
    // The local backend holds only pages, posts and post metrics — the
    // collector's NDJSON sink writes nothing else. These return empty so the
    // tools degrade to "no data yet" rather than throwing.
    // Pages per run, latest against the best of the last 30 days.
    async pageCoverage() {
      const rows = read('meta_collection_runs');
      if (!rows.length) return null;
      const byRun = new Map();
      for (const r of rows) {
        if (!byRun.has(r.run_id)) byRun.set(r.run_id, { started: r.started_at, pages: 0 });
        byRun.get(r.run_id).pages += 1;
      }
      const runs = [...byRun.values()].sort((a, b) => String(b.started).localeCompare(String(a.started)));
      return { latest: runs[0].pages, best: Math.max(...runs.slice(0, 30).map((r) => r.pages)) };
    },
    async counts() {
      return {
        meta_pages: read('meta_pages').length,
        meta_posts: read('meta_posts').length,
        meta_post_metrics: read('meta_post_metrics').length,
      };
    },
    async freshness() {
      const rows = read('meta_post_metrics');
      const dates = rows.map((r) => r.collected_date).filter(Boolean).sort();
      return { latest: dates.length ? dates[dates.length - 1] : null, recentFailures: 0 };
    },
    async pageGrowth() { return []; },
    async latestRuns() { return []; },
    async igAccountGrowth() { return []; },
    async igMedia() { return []; },
    async searchIgMedia() { return []; },
    async adSpend() { return []; },
    // X source: the NDJSON sink writes x_* files on a dry run, but the tools
    // read the x_post_latest VIEW, which only Postgres can serve. Empty, not
    // absent, so the tools say "nothing collected" rather than throwing.
    async xAccounts() { return read('x_accounts'); },
    async xPosts() { return []; },
    async xAccountGrowth() { return []; },
    async xFreshness() { return { latest: null, recentFailures: 0, posts: 0, withPrivate: 0 }; },
    async xSpend() { return null; },
    async xPeriodSummary() { return []; },
    async xPostCount() { return 0; },
    async xThreads() { return []; },
    async xThreadCount() { return 0; },
    async xTagSummary() { return []; },
    async xLinkProblems() { return []; },
    async xWithheld() { return []; },
    // The Page Inviter config lives only in Postgres.
    async inviterConfigs() { return []; },
    async inviterConfigById() { return null; },
    async insertInviterConfig() { throw new Error('The inviter config can only be edited against Supabase.'); },
    async searchPosts({ q, page_id, since, limit = 25 }) {
      const { shapeFeed } = require('./shape');
      const data = {
        pages: read('meta_pages'), posts: read('meta_posts'), metrics: read('meta_post_metrics'),
      };
      let rows = shapeFeed(data, { page_id, since, sort: 'reach' }).rows;
      if (q) {
        const needle = String(q).toLowerCase();
        rows = rows.filter((r) => (r.message || '').toLowerCase().includes(needle));
      }
      return rows.slice(0, Number(limit) || 25);
    },
  };
}

// The filters every X post read shares (x_post_latest), so a list and its
// count can never disagree about what they are counting.
//   hashtag / topic match the lower-cased JSON columns tags_text / topics_text;
//   a hashtag must match a whole tag, a topic any part of a label.
//   video: posts with a video. refreshed: read since 2 Oct 2026, the posts that
//   carry topics and hashtags at all.
function postFilter({ q, account_id, since, until, linkOnly, roles, hashtag, topic, video, refreshed } = {}) {
  const clean = (v) => String(v).replace(/[(),*"\\]/g, ' ').trim();
  const parts = [];
  if (q) parts.push(`text=ilike.*${encodeURIComponent(clean(q))}*`);
  if (account_id) parts.push(`account_id=eq.${encodeURIComponent(account_id)}`);
  if (since) parts.push(`created_at=gte.${encodeURIComponent(since)}`);
  if (until) parts.push(`created_at=lt.${encodeURIComponent(until)}`);
  if (linkOnly) parts.push('has_citizengo_link=is.true');
  if (roles && roles.length) parts.push(`thread_role=in.(${roles.filter((r) => /^[a-z_]+$/.test(r)).join(',')})`);
  if (hashtag) parts.push(`tags_text=ilike.*${encodeURIComponent('"' + clean(hashtag).replace(/^#/, '').toLowerCase() + '"')}*`);
  if (topic) parts.push(`topics_text=ilike.*${encodeURIComponent(clean(topic).toLowerCase())}*`);
  if (video) parts.push('video_duration_ms=not.is.null');
  if (refreshed) parts.push('is_long_post=not.is.null');
  return parts;
}

function threadFilter({ account_id, since, until }) {
  const parts = [];
  if (account_id) parts.push(`account_id=eq.${encodeURIComponent(account_id)}`);
  if (since) parts.push(`started_at=gte.${encodeURIComponent(since)}`);
  if (until) parts.push(`started_at=lt.${encodeURIComponent(until)}`);
  return parts;
}

function supabaseStore({ url, serviceKey }) {
  const headersFor = () => ({ apikey: serviceKey, Authorization: `Bearer ${serviceKey}` });
  const base = url.trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
  async function read(table, query = 'select=*&limit=100000') {
    const res = await withRetry(`read ${table}`, async () => {
      const r = await fetch(`${base}/rest/v1/${table}?${query}`, {
        headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey },
      });
      const text = await r.text();
      let body = null;
      if (text) { try { body = JSON.parse(text); } catch (e) { body = text; } }
      return { status: r.status, ok: r.ok, body };
    }, { onRetry: (l, n, why) => process.stderr.write(`  retry ${n}: ${l} (${why})\n`) });
    if (!res.ok) {
      // The PostgREST body carries table names, column names and Postgres error
      // codes. It reached the caller verbatim through the MCP tool-error path,
      // handing an authenticated reader a free map of the schema. Log it where
      // an operator can see it; tell the caller only what went wrong.
      console.error(`read ${table} failed: HTTP ${res.status} ${JSON.stringify(res.body)}`);
      const e = new Error(`Could not read ${table} (HTTP ${res.status}).`);
      e.code = 'READ_FAILED';
      e.status = res.status;
      // Machine-readable, and never part of the message the caller sees.
      e.pgCode = res.body && res.body.code ? String(res.body.code) : null;
      throw e;
    }
    return res.body;
  }
  // Exact match count via Content-Range, so a capped result can say what it is
  // hiding. Costs one extra request and returns no rows.
  async function countMatching(table, parts) {
    const query = parts.filter((x) => !x.startsWith('limit=') && !x.startsWith('order='))
      .concat('limit=1').join('&');
    try {
      const res = await fetch(`${base}/rest/v1/${table}?${query}`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Prefer: 'count=exact' },
      });
      const range = res.headers.get('content-range') || '';
      const total = range.includes('/') ? Number(range.split('/')[1]) : null;
      return Number.isFinite(total) ? total : null;
    } catch (e) {
      // A missing count must not fail the search it annotates.
      return null;
    }
  }

  // PostgREST caps every response at db-max-rows, 1000 on Supabase by default,
  // and IGNORES a larger limit in the query string without saying so. Asking for
  // 100000 returned exactly 1000 and looked like a complete answer.
  //
  // Worse than merely losing rows: posts and metrics were truncated
  // INDEPENDENTLY, so posts whose metric rows fell outside the first 1000
  // appeared to have no metrics at all. That is where a reported "343 posts with
  // no metrics" came from when the real figure was 78.
  //
  // A stable sort key is required: offset paging without ORDER BY can repeat or
  // skip rows between requests.
  const PAGE_SIZE = 1000;
  const SORT_KEY = {
    meta_pages: 'page_id',
    meta_posts: 'post_id',
    meta_post_metrics: 'id',
  };

  // Row count for a filter (Prefer: count=exact), or null if unknown.
  async function countRows(table, parts) {
    const r = await fetch(`${base}/rest/v1/${table}?${[...parts, 'limit=1'].join('&')}`, { headers: { ...headersFor(), Prefer: 'count=exact' } });
    const cr = r.headers.get('content-range') || '';
    const total = cr.includes('/') ? Number(cr.split('/')[1]) : null;
    return Number.isFinite(total) ? total : null;
  }

  async function readAll(table) {
    const order = SORT_KEY[table] || 'id';
    const out = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const batch = await read(table, `select=*&order=${order}.asc&limit=${PAGE_SIZE}&offset=${offset}`);
      if (!Array.isArray(batch) || !batch.length) break;
      out.push(...batch);
      if (batch.length < PAGE_SIZE) break;
      // Runaway guard. Loud rather than silent, because a silent cap here is the
      // very bug this function exists to fix.
      if (out.length >= 200000) {
        throw new Error(`${table}: refusing to read beyond 200000 rows — something is wrong`);
      }
    }
    return out;
  }

  // readAll's pagination, but for a chosen column list, a view, or a descending
  // window. readAll selects * from a base table; several readers need neither,
  // and each one that hand-rolled `limit=<big number>` instead got silently
  // capped at 1000 by PostgREST - which is exactly the bug the comment above
  // readAll was written to prevent. Route them through here instead.
  async function readPaged(table, select, order, { desc = false, max = 200000 } = {}) {
    const dir = desc ? 'desc' : 'asc';
    const out = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const batch = await read(table,
        `select=${select}&order=${order}.${dir}&limit=${PAGE_SIZE}&offset=${offset}`);
      if (!Array.isArray(batch) || !batch.length) break;
      out.push(...batch);
      if (batch.length < PAGE_SIZE) break;
      if (out.length >= max) break;
    }
    return out;
  }

  // True row counts, measured INDEPENDENTLY of loadAll. PostgREST reports the
  // total in Content-Range when asked for an exact count, so this needs no rows
  // and cannot itself be truncated - which is the whole point. Comparing it
  // against what loadAll returns is how a silent cap gets caught rather than
  // discovered by accident months later.
  async function counts() {
    const out = {};
    for (const table of TABLES) {
      const res = await fetch(`${base}/rest/v1/${table}?select=*&limit=1`, {
        headers: {
          apikey: serviceKey,
          Authorization: 'Bearer ' + serviceKey,
          Prefer: 'count=exact',
        },
      });
      const range = res.headers.get('content-range') || '';
      const total = range.includes('/') ? Number(range.split('/')[1]) : null;
      out[table] = Number.isFinite(total) ? total : null;
    }
    return out;
  }

  async function pageCoverage() {
    // One row per page per run, so counting rows per run_id gives pages reached.
    // Newest first, paginated: asking for 2000 in one request returned 1000,
    // so "best of the last 30 runs" was really the best of about 27.
    const rows = await readPaged('meta_collection_runs', 'run_id,started_at',
      'started_at', { desc: true, max: 3000 });
    if (!Array.isArray(rows) || !rows.length) return null;
    const byRun = new Map();
    for (const r of rows) {
      if (!byRun.has(r.run_id)) byRun.set(r.run_id, { started: r.started_at, pages: 0 });
      byRun.get(r.run_id).pages += 1;
    }
    const runs = [...byRun.values()].sort((a, b) => String(b.started).localeCompare(String(a.started)));
    // Best of the last 3 runs, not the single latest. Targeted backfills are
    // legitimate and tiny - a HazteOir-only run collects exactly 1 page - and
    // judging on the latest run alone reports every one of those as a 97%
    // collapse. A token granting fewer Pages affects EVERY subsequent run, so
    // sustained coverage is the thing to measure.
    const recent = Math.max(...runs.slice(0, 3).map((r) => r.pages));
    return { latest: recent, best: Math.max(...runs.slice(0, 30).map((r) => r.pages)) };
  }

  // Retention for the brute-force audit log.
  //
  // N2, second security review: a cleanup function existed and was documented as
  // housekeeping, but nothing ever called it - no cron, no workflow, no code
  // path. The table grew without bound while reading as maintained, which is
  // this project's recurring failure: a control that looks done and does nothing.
  //
  // Now a plain DELETE issued by the daily watchdog with the credentials it
  // already holds. Nothing older than a day can affect a ten-minute window, so
  // that is the cutoff.
  async function pruneAuthFailures(olderThanDays = 1) {
    const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString();
    const res = await fetch(
      `${base}/rest/v1/meta_auth_failures?at=lt.${encodeURIComponent(cutoff)}`,
      { method: 'DELETE', headers: { ...headersFor(), Prefer: 'return=representation' } },
    );
    if (!res.ok) throw new Error(`prune failed: HTTP ${res.status}`);
    const rows = await res.json().catch(() => []);
    return Array.isArray(rows) ? rows.length : 0;
  }

  // Instagram coverage. Reduced to the LATEST ROW PER MEDIA, not to the latest
  // collection date - the same rule the rest of this project applies to
  // append-only tables, and for the same reason. Judging by date is wrong here:
  // a targeted single-page run creates a newer date covering one account, and
  // measuring against it reported "5 of 5" while 698 fully-collected rows sat
  // one day earlier.
  // Ad spend collects through a DIFFERENT permission (ads_read) from everything
  // else, so it can stop dead while every nightly run stays green: adspend.js
  // logs "unavailable" and deliberately does not fail the collection. It did
  // exactly that from 29 Aug 2026, and nothing surfaced it for seventeen days
  // because no reader ever looked at how old the newest row was.
  async function adSpendCoverage() {
    const rows = await read('meta_post_ad_spend',
      'select=date_stop&order=date_stop.desc&limit=1');
    if (!Array.isArray(rows) || !rows.length) return { rows: 0, latest: null };
    return { rows: 1, latest: rows[0].date_stop };
  }

  async function igCoverage() {
    // Reads meta_ig_latest, which is ALREADY one row per media at its latest
    // collection - the exact shape this needs, and ~860 rows rather than the
    // whole metrics history.
    //
    // It used to fold the history down itself, reading meta_ig_media_metrics
    // with `limit=20000&order=collected_date.asc`. PostgREST capped that at
    // 1000 without saying so, and because the order was ASCENDING those were
    // the OLDEST rows: on 15 Sept 2026 this reported "696 of 698 posts have
    // reach, as of 2026-08-30" when the truth was 860 of 863, current to the
    // 14th. A health check that quietly ages by a day each night is worse than
    // no health check, because it is the thing you consult to decide whether to
    // trust everything else.
    const kept = await readPaged('meta_ig_latest', 'media_id,collected_date,reach', 'media_id');
    if (!kept.length) {
      // The view inner-joins metrics, so media with no metrics at all never
      // appear in it. Distinguish "no Instagram" from "collected, not measured".
      const any = await read('meta_ig_media', 'select=media_id&limit=1');
      return { hasMedia: Array.isArray(any) && any.length > 0, latest: null, total: 0, withReach: 0 };
    }
    return {
      hasMedia: true,
      latest: kept.reduce((a, r) => (r.collected_date > a ? r.collected_date : a), ''),
      total: kept.length,
      withReach: kept.filter((r) => r.reach !== null).length,
    };
  }

  // CitizenGO Page Inviter config (inviter_config, one row per version, newest
  // wins). The ONLY table the MCP request path writes to, and only through
  // update_inviter_config, which is limited to INVITER_CONFIG_ADMINS. See
  // mcp/inviter-tools.js.
  const INVITER_COLS = 'select=id,config,note,updated_at';
  async function inviterConfigs(limit = 1) {
    const n = Math.min(50, Math.max(1, Number(limit) || 1));
    return read('inviter_config', `${INVITER_COLS}&order=id.desc&limit=${n}`);
  }
  async function inviterConfigById(id) {
    const rows = await read('inviter_config', `${INVITER_COLS}&id=eq.${Number(id)}`);
    return rows && rows[0] ? rows[0] : null;
  }
  async function insertInviterConfig({ config, note }) {
    const r = await fetch(`${base}/rest/v1/inviter_config?${INVITER_COLS}`, {
      method: 'POST',
      headers: { ...headersFor(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ config, note }),
    });
    const text = await r.text();
    if (!r.ok) {
      // Same rule as read(): the PostgREST body stays in the operator's log.
      console.error(`insert inviter_config failed: HTTP ${r.status} ${text}`);
      throw new Error(`Could not save the inviter config (HTTP ${r.status}).`);
    }
    const rows = JSON.parse(text);
    return rows[0];
  }

  return {
    name: 'supabase',
    counts,
    pageCoverage,
    pruneAuthFailures,
    igCoverage,
    adSpendCoverage,
    inviterConfigs,
    inviterConfigById,
    insertInviterConfig,
    async loadAll() {
      const [pages, posts, metrics] = await Promise.all(TABLES.map((t) => readAll(t)));
      return { pages, posts, metrics };
    },
    // Deliberately tiny: one row, newest collection date only. Called on every
    // tool invocation, so it must not cost anything meaningful.
    async freshness() {
      const rows = await read('meta_post_metrics',
        'select=collected_date&order=collected_date.desc&limit=1');
      const latest = rows && rows[0] ? rows[0].collected_date : null;
      const stalePages = await read('meta_collection_runs',
        'select=page_id,status,started_at&status=eq.failed&order=started_at.desc&limit=50');
      return { latest, recentFailures: (stalePages || []).length };
    },
    // The newest collection run for each of a few pages, so list_pages can say
    // whether a page with no posts was read cleanly or failed. Small by
    // construction: one row per page per run, a handful of pages.
    async latestRuns(pageIds) {
      if (!pageIds || !pageIds.length) return [];
      const ids = pageIds.map((id) => encodeURIComponent(id)).join(',');
      const rows = await read('meta_collection_runs',
        `select=page_id,status,started_at,posts_seen,error_message&page_id=in.(${ids})&order=started_at.desc&limit=${Math.min(pageIds.length * 10, 1000)}`);
      const first = new Map();
      for (const r of rows || []) if (!first.has(r.page_id)) first.set(r.page_id, r);
      return [...first.values()];
    },
    // All of these filter server-side. At 36 pages the demographics table alone
    // runs to thousands of rows and no tool needs them in memory.
    // Paginated, and the cap is a ceiling rather than the page size. It used to
    // be one request with limit=400 ordered by date ascending, so an all-pages
    // call over 30 days (36 pages x 30 = ~1,080 rows) got the OLDEST eleven
    // days and silently dropped the rest - totals for "last 30 days" that were
    // really the first third of it, with nothing to say so.
    async pageGrowth({ page_id, since, until, limit = 20000 }) {
      const parts = ['select=*'];
      if (page_id) parts.push(`page_id=eq.${encodeURIComponent(page_id)}`);
      if (since) parts.push(`metric_date=gte.${encodeURIComponent(String(since).slice(0, 10))}`);
      // Inclusive: callers pass a calendar end date, not an exclusive bound.
      if (until) parts.push(`metric_date=lte.${encodeURIComponent(String(until).slice(0, 10))}`);
      // page_id breaks ties so the offset pages are stable within a date.
      parts.push('order=metric_date.asc,page_id.asc');
      const cap = Math.max(1, Number(limit) || 20000);
      const out = [];
      for (let offset = 0; out.length < cap; offset += PAGE_SIZE) {
        const batch = await read('meta_page_growth',
          `${parts.join('&')}&limit=${PAGE_SIZE}&offset=${offset}`);
        if (!Array.isArray(batch) || !batch.length) break;
        out.push(...batch);
        if (batch.length < PAGE_SIZE) break;
      }
      if (out.length >= cap) throw new Error(`meta_page_growth: more than ${cap} rows for this window — narrow it rather than report a truncated total`);
      return out;
    },
    // Instagram account days for page_growth: follows, unfollows and the
    // follower count. Paginated for the same reason as pageGrowth above - ~15
    // accounts x 90 days is past any single-request limit worth trusting.
    async igAccountGrowth({ page_id, since, until }) {
      const parts = ['select=page_id,ig_username,metric_date,followers_snapshot,follower_count,daily_follows,daily_unfollows'];
      if (page_id) parts.push(`page_id=eq.${encodeURIComponent(page_id)}`);
      if (since) parts.push(`metric_date=gte.${encodeURIComponent(String(since).slice(0, 10))}`);
      if (until) parts.push(`metric_date=lte.${encodeURIComponent(String(until).slice(0, 10))}`);
      parts.push('order=metric_date.asc,ig_username.asc');
      const out = [];
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const batch = await read('meta_ig_account_metrics',
          `${parts.join('&')}&limit=${PAGE_SIZE}&offset=${offset}`);
        if (!Array.isArray(batch) || !batch.length) break;
        out.push(...batch);
        if (batch.length < PAGE_SIZE) break;
        if (out.length >= 20000) throw new Error('meta_ig_account_metrics: more than 20000 rows for this window — narrow it');
      }
      return out;
    },
    // The WHOLE Instagram feed, paginated, for the Sheet mirror. igMedia below
    // is the capped read the MCP tools use; this one must not be capped or the
    // mirror silently stops at 200 rows - the same truncation that made every
    // Facebook aggregate wrong on 30 Aug 2026.
    async igFeed() {
      const out = [];
      const PAGE = 1000;
      for (let offset = 0; ; offset += PAGE) {
        const batch = await read('meta_ig_latest',
          `select=*&order=timestamp.desc&limit=${PAGE}&offset=${offset}`);
        if (!Array.isArray(batch) || !batch.length) break;
        out.push(...batch);
        if (batch.length < PAGE) break;
        if (out.length >= 100000) throw new Error('meta_ig_latest: refusing to read beyond 100000 rows');
      }
      return out;
    },
    // type narrows to one format server-side, so "how long do people watch our
    // Reels" reads every Reel rather than the Reels that happen to sit in the
    // top N by views (12 of the 45 most-viewed, in Miguel's test of 7 Oct 2026).
    async igMedia({ page_id, since, until, sort = 'reach', type, limit = 20, offset = 0 }) {
      const order = { reach: 'reach', saved: 'saved', views: 'views',
        interactions: 'total_interactions', recent: 'timestamp', watch: 'reels_avg_watch_seconds' }[sort] || 'reach';
      const parts = ['select=*'];
      if (page_id) parts.push(`page_id=eq.${encodeURIComponent(page_id)}`);
      if (since) parts.push(`timestamp=gte.${encodeURIComponent(since)}`);
      if (until) parts.push(`timestamp=lt.${encodeURIComponent(until)}`);
      const TYPE = {
        reels: 'media_product_type=eq.REELS',
        stories: 'media_product_type=eq.STORY',
        carousels: 'media_type=eq.CAROUSEL_ALBUM',
        images: 'media_type=eq.IMAGE',
        feed: 'media_product_type=eq.FEED',
      }[type];
      if (TYPE) parts.push(TYPE);
      parts.push(`order=${order}.desc.nullslast,media_id.asc`);
      const capped = Math.min(Number(limit) || 20, 200);
      parts.push(`limit=${capped}`);
      if (offset) parts.push(`offset=${Math.max(0, Math.floor(Number(offset)) || 0)}`);
      const rows = await read('meta_ig_latest', parts.join('&'));
      if (Array.isArray(rows)) {
        rows.matchedTotal = (rows.length === capped || offset)
          ? await countMatching('meta_ig_latest', parts.filter((x) => !x.startsWith('offset=')))
          : rows.length;
      }
      return rows;
    },
    async adSpend({ page_id, since, limit = 30 }) {
      const parts = ['select=*'];
      if (page_id) parts.push(`post_id=like.${encodeURIComponent(page_id)}*`);
      if (since) parts.push(`created_time=gte.${encodeURIComponent(since)}`);
      parts.push('order=total_spend.desc.nullslast');
      parts.push(`limit=${Math.min(Number(limit) || 30, 200)}`);
      return read('meta_post_paid_vs_organic', parts.join('&'));
    },
    // Filters server-side rather than pulling every post into memory. At 36
    // pages over 90 days that is thousands of rows per call, and a text search
    // has no business shipping all of them across the wire.
    // Reactions on the post against reactions including reshares. See
    // sql/schema.sql for why only rows from 2026-08-30 qualify.
    async amplification({ page_id, since, limit = 20 }) {
      const parts = ['select=*', 'amplification=not.is.null'];
      if (page_id) parts.push(`page_id=eq.${encodeURIComponent(page_id)}`);
      if (since) parts.push(`created_time=gte.${encodeURIComponent(since)}`);
      parts.push('order=amplification.desc');
      parts.push(`limit=${Math.min(Number(limit) || 20, 200)}`);
      return read('meta_post_amplification', parts.join('&'));
    },

    // -----------------------------------------------------------------------
    // X source. All server-side filtered; all read views, never the append-only
    // metrics table. Each returns [] / empty when the x_* objects do not exist
    // yet (PGRST205 / 42P01), so the tools can be enabled before the schema is
    // applied without turning every call into an error.
    // -----------------------------------------------------------------------
    async xAccounts() {
      let accounts;
      try { accounts = await read('x_accounts', 'select=*&is_active=eq.true&order=username.asc&limit=1000'); }
      catch (e) { if (e.pgCode === '42P01' || e.status === 404) return []; throw e; }
      let tokens = [];
      try { tokens = await read('x_oauth_tokens', 'select=account_id,revoked_at,last_error&order=authorized_at.desc&limit=2000'); }
      catch (e) { tokens = []; }
      const status = new Map();
      for (const t of tokens) {
        if (status.has(t.account_id)) continue;
        status.set(t.account_id, t.revoked_at ? 'needs re-authorisation' : (t.last_error ? 'live (last refresh errored)' : 'live'));
      }
      return accounts.map((a) => ({ ...a, credential_status: status.get(a.account_id) || 'never authorised' }));
    },
    // One PAGE of posts. limit is the page size (max 200, the most that fits in
    // a tool response); offset walks through everything we hold, however many
    // posts that is. post_id breaks ties so pages never repeat or skip a post
    // when many share a value (offset paging without a stable order does both).
    async xPosts({ order = 'impressions', limit = 25, offset = 0, ...filters } = {}) {
      const parts = ['select=*', ...postFilter(filters)];
      const col = /^[a-z_]+$/.test(String(order)) ? order : 'impressions';
      parts.push(`order=${col}.desc.nullslast,post_id.asc`);
      parts.push(`limit=${Math.min(Math.max(Number(limit) || 25, 1), 200)}`);
      if (Number(offset) > 0) parts.push(`offset=${Math.floor(Number(offset))}`);
      try { return await read('x_post_latest', parts.join('&')); }
      catch (e) { if (e.pgCode === '42P01' || e.status === 404) return []; throw e; }
    },
    async xAccountGrowth({ account_id, since, limit = 2000 } = {}) {
      const parts = ['select=*'];
      if (account_id) parts.push(`account_id=eq.${encodeURIComponent(account_id)}`);
      if (since) parts.push(`metric_date=gte.${encodeURIComponent(String(since).slice(0, 10))}`);
      parts.push('order=metric_date.asc');
      parts.push(`limit=${Math.min(Number(limit) || 2000, 5000)}`);
      try { return await read('x_account_growth', parts.join('&')); }
      catch (e) { if (e.pgCode === '42P01' || e.status === 404) return []; throw e; }
    },
    async xFreshness() {
      try {
        const [latest, failed, total, priv] = await Promise.all([
          read('x_post_metrics', 'select=collected_date&order=collected_date.desc&limit=1'),
          read('x_collection_runs', 'select=account_id&status=eq.failed&order=started_at.desc&limit=50'),
          fetch(`${base}/rest/v1/x_posts?select=post_id&limit=1`, { headers: { ...headersFor(), Prefer: 'count=exact' } })
            .then((r) => { const cr = r.headers.get('content-range') || ''; return cr.includes('/') ? Number(cr.split('/')[1]) : null; }),
          fetch(`${base}/rest/v1/x_post_latest?select=post_id&private_window_open=is.true&limit=1`, { headers: { ...headersFor(), Prefer: 'count=exact' } })
            .then((r) => { const cr = r.headers.get('content-range') || ''; return cr.includes('/') ? Number(cr.split('/')[1]) : null; }),
        ]);
        return { latest: latest && latest[0] ? latest[0].collected_date : null, recentFailures: (failed || []).length,
          posts: Number.isFinite(total) ? total : null, withPrivate: Number.isFinite(priv) ? priv : null };
      } catch (e) {
        if (e.pgCode === '42P01' || e.status === 404) return { latest: null, recentFailures: 0, posts: 0, withPrivate: 0 };
        throw e;
      }
    },
    // Totals for a period, per account, computed in Postgres by
    // x_period_summary (migration 1 Oct 2026). Every post in the window is
    // counted, so a monthly total is never capped the way a ranked list is -
    // the 200-row ceiling on x_top_posts cut @CitizenGO's August from 76 posts
    // to the 39 above ~690 impressions, and Filip's total with it.
    async xPeriodSummary({ from, to, account_id } = {}) {
      const r = await fetch(`${base}/rest/v1/rpc/x_period_summary`, {
        method: 'POST',
        headers: { ...headersFor(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_from: from, p_to: to, p_account: account_id || null }),
      });
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        console.error(`x_period_summary failed: HTTP ${r.status} ${body.slice(0, 300)}`);
        const e = new Error(`Could not compute the period summary (HTTP ${r.status}).`);
        e.code = 'READ_FAILED'; e.status = r.status;
        throw e;
      }
      return r.json();
    },
    // How many posts match, so a capped list can say what it left out.
    async xPostCount(filters = {}) {
      const parts = ['select=post_id', ...postFilter(filters)];
      return countRows('x_post_latest', parts);
    },
    // Threads: a conversation one of our posts started and our own replies
    // continued (view x_thread_summary). Paged like xPosts.
    async xThreads({ account_id, since, until, order = 'impressions', limit = 25, offset = 0 } = {}) {
      const parts = ['select=*', ...threadFilter({ account_id, since, until })];
      const col = /^[a-z_]+$/.test(String(order)) ? order : 'impressions';
      parts.push(`order=${col}.desc.nullslast,conversation_id.asc`);
      parts.push(`limit=${Math.min(Math.max(Number(limit) || 25, 1), 200)}`);
      if (Number(offset) > 0) parts.push(`offset=${Math.floor(Number(offset))}`);
      try { return await read('x_thread_summary', parts.join('&')); }
      catch (e) { if (e.pgCode === '42P01' || e.status === 404) return []; throw e; }
    },
    async xThreadCount({ account_id, since, until } = {}) {
      return countRows('x_thread_summary', ['select=conversation_id', ...threadFilter({ account_id, since, until })]);
    },
    // Hashtags or X topic labels ranked over a window (function x_tag_summary).
    async xTagSummary({ kind, from, to, account_id, limit = 200 } = {}) {
      const r = await fetch(`${base}/rest/v1/rpc/x_tag_summary`, {
        method: 'POST', headers: { ...headersFor(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_kind: kind, p_from: from, p_to: to, p_account: account_id || null, p_limit: limit }),
      });
      if (!r.ok) {
        console.error(`x_tag_summary failed: HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 300)}`);
        const e = new Error(`Could not rank ${kind}s (HTTP ${r.status}).`); e.code = 'READ_FAILED'; e.status = r.status; throw e;
      }
      return r.json();
    },
    // Links X could not load (HTTP status >= minStatus), newest posts first.
    async xLinkProblems({ minStatus = 400, oursOnly = true, limit = 200 } = {}) {
      const parts = ['select=post_id,username,created_at,permalink_url,url,status,is_ours', `status=gte.${Number(minStatus) || 400}`];
      if (oursOnly) parts.push('is_ours=is.true');
      parts.push('order=created_at.desc', `limit=${Math.min(Number(limit) || 200, 1000)}`);
      try { return await read('x_post_link_status', parts.join('&')); }
      catch (e) { if (e.pgCode === '42P01' || e.status === 404) return []; throw e; }
    },
    // Posts X withholds in one or more countries.
    async xWithheld({ limit = 200 } = {}) {
      try {
        return await read('x_post_latest', `select=post_id,username,created_at,permalink_url,text,withheld_in&withheld_in=not.is.null&order=created_at.desc&limit=${Math.min(Number(limit) || 200, 1000)}`);
      } catch (e) { if (e.pgCode === '42P01' || e.pgCode === '42703' || e.status === 404) return []; throw e; }
    },
    async xSpend() {
      try {
        const rows = await read('x_spend_month_to_date', 'select=*');
        const r = Array.isArray(rows) && rows[0] ? rows[0] : { est_cost_usd: 0, post_reads: 0, user_reads: 0 };
        return { ...r, budget: Number(process.env.X_MONTHLY_BUDGET_USD || 100) };
      } catch (e) {
        if (e.pgCode === '42P01' || e.status === 404) return null;
        throw e;
      }
    },

    async searchPosts({ q, page_id, since, limit = 25 }) {
      const parts = ['select=*'];
      if (q) {
        // ilike with wildcards; commas and parens would break PostgREST's
        // filter grammar, so they are stripped rather than escaped.
        const safe = String(q).replace(/[(),*]/g, ' ').trim();
        parts.push(`message=ilike.*${encodeURIComponent(safe)}*`);
      }
      if (page_id) parts.push(`page_id=eq.${encodeURIComponent(page_id)}`);
      if (since) parts.push(`created_time=gte.${encodeURIComponent(since)}`);
      parts.push('order=views_unique.desc.nullslast');
      const capped = Math.min(Number(limit) || 25, 200);
      parts.push(`limit=${capped}`);
      // How many MATCHED, not how many are being returned. Without it a
      // truncated result is indistinguishable from a complete one, and the
      // reader concludes those are all the posts on the topic.
      const rows = await read('meta_post_latest', parts.join('&'));
      if (Array.isArray(rows) && rows.length === capped) {
        rows.matchedTotal = await countMatching('meta_post_latest', parts);
      }
      return rows;
    },

    // The Instagram half of searchPosts, over both the caption the page wrote
    // and what was said in the video. Captions have been collected since the
    // start and are 99.8% populated, but nothing searched them until now, so a
    // topic search silently reported Facebook's half as the whole answer.
    // Same filter grammar caveat as searchPosts above.
    async searchIgMedia({ q, page_id, since, limit = 25 }) {
      const parts = ['select=*'];
      if (q) {
        const safe = String(q).replace(/[(),*]/g, ' ').trim();
        // or= needs the whole disjunction in one parameter. A dot or a comma
        // inside the term would split it, and both are already stripped above.
        parts.push(`or=(caption.ilike.*${encodeURIComponent(safe)}*,transcript.ilike.*${encodeURIComponent(safe)}*)`);
      }
      if (page_id) parts.push(`page_id=eq.${encodeURIComponent(page_id)}`);
      if (since) parts.push(`timestamp=gte.${encodeURIComponent(since)}`);
      parts.push('order=reach.desc.nullslast');
      parts.push(`limit=${Math.min(Number(limit) || 25, 200)}`);
      return read('meta_ig_searchable', parts.join('&'));
    },
  };
}

// For the serverless functions: throws rather than degrading.
function requireSupabaseStore() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    const err = new Error('server_misconfigured: SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
    err.code = 'CONFIG';
    throw err;
  }
  return supabaseStore({ url, serviceKey: key });
}

module.exports = { fileStore, supabaseStore, requireSupabaseStore, postFilter };
