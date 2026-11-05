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
    async igAccountMonths() { return []; },
    async igMonthPosts() { return []; },
    async igAudience() { return []; },
    async socialTags() { return []; },
    async igProfileActions() { return []; },
    async videoRetention() { return []; },
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
    // Link performance lives only in Postgres (sql/links-schema.sql).
    async linkPosts() { return []; },
    async linkSignatures() { return []; },
    async linkFreshness() { return { pulledAt: null, registryAt: null }; },
    async linkPostReach() { return []; },
    async igConnectedAccounts() { return []; },
    async igConnectedPosts() { return []; },
    async peerAccounts() { return []; },
    async peerPosts() { return []; },
    async opponentAds() { return []; },
    async peerRecent() { return []; },
    async peerDayMetrics() { return []; },
    async listenHashtagMedia() { return []; },
    async listenNews() { return []; },
    async opponentAdsSeen() { return []; },
    async topicCorpus() { return { facebook: [], instagram: [], x: [] }; },
    // The Page Inviter config lives only in Postgres.
    async inviterConfigs() { return []; },
    async inviterConfigById() { return null; },
    async insertInviterConfig() { throw new Error('The inviter config can only be edited against Supabase.'); },
    async upsertInviterUsage() { throw new Error('Page Inviter usage can only be saved to Supabase.'); },
    async inviterUsage() { return []; },
    // The Content Engine lives only in Postgres.
    async engineTeams() { return []; },
    async engineMembers() { return []; },
    async engineRights() { return []; },
    async enginePosts() { return []; },
    async enginePost() { return null; },
    async engineInsertPost() { throw new Error('The Content Engine needs Supabase.'); },
    async engineUpdatePost() { throw new Error('The Content Engine needs Supabase.'); },
    async engineEvent() {},
    async engineKeyDates() { return []; },
    async engineRequests() { return []; },
    async engineEvergreen() { return []; },
    async enginePageToken() { return null; },
    async engineConnectedTokens() { return []; },
    async engineMyConnections() { return []; },
    async enginePauses() { return []; },
    async engineInsertPause() { throw new Error('The Content Engine needs Supabase.'); },
    async engineResumePause() { throw new Error('The Content Engine needs Supabase.'); },
    async engineMetaRights() { return []; },
    async engineDropRight() { throw new Error('The Content Engine needs Supabase.'); },
    async engineTouchRight() { throw new Error('The Content Engine needs Supabase.'); },
    async engineMediaUpload() { throw new Error('The Content Engine needs Supabase.'); },
    async engineMediaUrl() { return null; },
    async engineMediaList() { return []; },
    async engineMediaDownload() { return null; },
    async engineMediaFolders() { return []; },
    async engineInbox() { return []; },
    async engineInboxItem() { return null; },
    async engineInboxUpsert() { throw new Error('The Content Engine needs Supabase.'); },
    async engineInboxUpdate() { throw new Error('The Content Engine needs Supabase.'); },
    async engineInboxActions() { return []; },
    async engineInboxRules() { return []; },
    async igGridMedia() { return []; },
    async engineBio() { return null; },
    async engineSaveBio() { throw new Error('The Content Engine needs Supabase.'); },
    async engineBioClick() { return null; },
    async engineBioClicks() { return []; },
    async linkPostsSince() { return []; },
    async petitionStatus() { return []; },
    async igMediaByIds() { return []; },
    async listenPictures() { return {}; },
    async engineBios() { return []; },
    async bioSignatures() { return []; },
    async engineAutomations() { return []; },
    async engineAllRights() { return []; },
    async engineCopilotAuth() { return null; },
    async engineAccessLimits() { return []; },
    async engineSetAccessLimit() { throw new Error('The Content Engine needs Supabase.'); },
    async engineAllRightsFor() { return []; },
    async engineSaveCopilotAuth() { throw new Error('The Content Engine needs Supabase.'); },
    async engineTrackedLink() { return null; },
    async engineSaveTrackedLink() { return null; },
    async enginePeople() { return []; },
    async engineSetInitials() { throw new Error('The Content Engine needs Supabase.'); },
    async engineInsertAutomation() { throw new Error('The Content Engine needs Supabase.'); },
    async engineUpdateAutomation() { return null; },
    async engineInboxAutomationUnchecked() { return []; },
    async engineInboxAlerts() { return []; },
    async engineInsertInboxAlert() { throw new Error('The Content Engine needs Supabase.'); },
    async engineUpdateInboxAlert() { return null; },
    async engineInboxUnchecked() { return []; },
    async engineInsertInboxRule() { throw new Error('The Content Engine needs Supabase.'); },
    async engineDeleteInboxRule() { return null; },
    async engineInboxInsertAction() { throw new Error('The Content Engine needs Supabase.'); },
    async engineInboxUpdateAction() { return null; },
    async engineSetNeedsCheck() { return null; },
    async enginePrefs() { return {}; },
    async engineSavePrefs() { throw new Error('Settings need Supabase.'); },
    async engineMediaRemove() {},
    async engineInsertEvergreen() { throw new Error('The Content Engine needs Supabase.'); },
    async engineUpdateEvergreen() { throw new Error('The Content Engine needs Supabase.'); },
    async engineInsertRequest() { throw new Error('The Content Engine needs Supabase.'); },
    async engineUpdateRequest() { throw new Error('The Content Engine needs Supabase.'); },
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

  // Page Inviter usage (inviter_usage): the extension's daily invite totals per
  // Page. Upserted, because each report carries the running total for the day.
  async function upsertInviterUsage(rows) {
    if (!rows.length) return 0;
    const r = await fetch(`${base}/rest/v1/inviter_usage?on_conflict=day,user_email,device_id,page_id`, {
      method: 'POST',
      headers: { ...headersFor(), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows),
    });
    if (!r.ok) {
      console.error(`upsert inviter_usage failed: HTTP ${r.status} ${await r.text()}`);
      throw new Error(`Could not save Page Inviter usage (HTTP ${r.status}).`);
    }
    return rows.length;
  }
  // Content Engine (sql/engine-schema.sql). Writes go through these four
  // helpers only; the rules about who may write live in lib/engine.js.
  const ENGINE_POST_COLS = 'select=id,team_id,status,title,post_at,doc,version,source_team,source_post,created_at,created_by,updated_at,updated_by';
  async function engineWrite(method, path, body, prefer = 'return=representation') {
    const r = await fetch(`${base}/rest/v1/${path}`, {
      method, headers: { ...headersFor(), 'Content-Type': 'application/json', Prefer: prefer }, body: JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) {
      console.error(`${method} ${path.split('?')[0]} failed: HTTP ${r.status} ${text}`);
      const e = new Error(`Could not save to the Content Engine (HTTP ${r.status}).`);
      e.status = r.status;
      throw e;
    }
    return text ? JSON.parse(text) : null;
  }
  const inList = (xs) => `(${xs.map((x) => `"${String(x).replace(/["\\]/g, '')}"`).join(',')})`;
  async function engineTeams() { return read('engine_teams', 'select=*&order=id.asc'); }
  async function engineMembers({ who, team_id } = {}) {
    const parts = ['select=team_id,who,role,needs_check'];
    if (who) parts.push(`who=ilike.${encodeURIComponent(String(who).replace(/[%_*]/g, ''))}`);
    if (team_id) parts.push(`team_id=eq.${encodeURIComponent(team_id)}`);
    return read('engine_members', parts.join('&'));
  }
  // A person's rights come from Facebook (source meta) or the maintainer's
  // hand seeding; a team admin can narrow them per account and kind (post,
  // reply, moderate), never widen them. kind omitted = the rights as proven.
  async function engineRights({ who, kind } = {}) {
    const w = encodeURIComponent(String(who).replace(/[%_*]/g, ''));
    const rows = await read('engine_publish_rights', `select=who,account_key,checked_at,source&who=ilike.${w}`);
    if (!kind) return rows;
    const limits = await read('engine_access_limits', `select=account_key,can_post,can_reply,can_moderate&who=ilike.${w}`);
    const off = new Set(limits.filter((l) => l[`can_${kind}`] === false).map((l) => l.account_key));
    return rows.filter((r) => !off.has(r.account_key));
  }
  async function engineAccessLimits({ team_id, who } = {}) {
    const parts = ['select=team_id,who,account_key,can_post,can_reply,can_moderate,can_analytics,set_by,set_at'];
    if (team_id) parts.push(`team_id=eq.${encodeURIComponent(team_id)}`);
    if (who) parts.push(`who=ilike.${encodeURIComponent(String(who).replace(/[%_*]/g, ''))}`);
    return read('engine_access_limits', parts.join('&'));
  }
  async function engineSetAccessLimit(row) {
    const open = ['can_post', 'can_reply', 'can_moderate', 'can_analytics'].every((k) => row[k] !== false);
    if (open) return engineWrite('DELETE', `engine_access_limits?team_id=eq.${encodeURIComponent(row.team_id)}&who=eq.${encodeURIComponent(row.who)}&account_key=eq.${encodeURIComponent(row.account_key)}`, undefined, 'return=minimal');
    return engineWrite('POST', 'engine_access_limits?on_conflict=team_id,who,account_key', row, 'resolution=merge-duplicates,return=minimal');
  }
  async function engineAllRightsFor({ whos }) {
    if (!whos || !whos.length) return [];
    return read('engine_publish_rights', `select=who,account_key,checked_at,source&who=in.${encodeURIComponent(inList(whos))}`);
  }
  async function enginePosts({ team_ids, statuses, from, to, limit = 500 } = {}) {
    const parts = [ENGINE_POST_COLS];
    if (team_ids) { if (!team_ids.length) return []; parts.push(`team_id=in.${encodeURIComponent(inList(team_ids))}`); }
    if (statuses && statuses.length) parts.push(`status=in.${encodeURIComponent(inList(statuses))}`);
    if (from) parts.push(`post_at=gte.${encodeURIComponent(from)}`);
    if (to) parts.push(`post_at=lt.${encodeURIComponent(to)}`);
    parts.push('order=updated_at.desc', `limit=${Math.min(1000, Math.max(1, Number(limit) || 500))}`);
    return read('engine_posts', parts.join('&'));
  }
  // CitizenGO-wide dates (team_id null) and the given teams' own, overlapping
  // [from, to).
  async function engineKeyDates({ team_ids = [], from, to }) {
    const teams = team_ids.length ? `,team_id.in.${inList(team_ids)}` : '';
    const parts = ['select=team_id,starts,ends,title,kind,confidence,angle', `or=${encodeURIComponent(`(team_id.is.null${teams})`)}`];
    if (to) parts.push(`starts=lt.${encodeURIComponent(to)}`);
    if (from) parts.push(`and=${encodeURIComponent(`(or(ends.gte.${from},and(ends.is.null,starts.gte.${from})))`)}`);
    parts.push('order=starts.asc', 'limit=500');
    return read('engine_key_dates', parts.join('&'));
  }
  const ENGINE_REQ_COLS = 'select=id,team_id,for_date,title,angle,source,status,post_id,evergreen_id,requested_by,requested_at,done_at,done_by';
  const ENGINE_EG_COLS = 'select=id,team_id,title,url,format,account_key,last_out,result,why,status,snoozed_until,source_post,added_by,added_at,updated_by,updated_at';
  // Sealed Page tokens (Connect Facebook). Only the Mini can open one.
  async function enginePageToken({ who, account_key }) {
    const rows = await read('engine_page_tokens', `select=who,account_key,page_id,ig_id,sealed&who=ilike.${encodeURIComponent(String(who).replace(/[%_*]/g, ''))}&account_key=eq.${encodeURIComponent(account_key)}`);
    return (rows && rows[0]) || null;
  }
  // Pause everything: the pauses still on (resumed_at null; `until` is
  // checked by lib/engine.js pauseActive), newest first.
  const ENGINE_PAUSE_COLS = 'select=id,scope,team_id,account_keys,reason,paused_by,paused_at,until,resumed_at,resumed_by';
  async function enginePauses() {
    return read('engine_pauses', `${ENGINE_PAUSE_COLS}&resumed_at=is.null&order=paused_at.desc&limit=200`);
  }
  async function engineInsertPause(row) {
    const rows = await engineWrite('POST', `engine_pauses?${ENGINE_PAUSE_COLS}`, row);
    return (rows && rows[0]) || null;
  }
  async function engineResumePause(id, who) {
    const rows = await engineWrite('PATCH', `engine_pauses?${ENGINE_PAUSE_COLS}&id=eq.${Number(id)}&resumed_at=is.null`, { resumed_at: new Date().toISOString(), resumed_by: who });
    return (rows && rows[0]) || null;
  }
  // Nightly rights re-check (collector/rights-check.js): every sealed token,
  // the rights Connect Facebook gave, and removing one person's right + token.
  // The bell and the renewal banner [Priority One 20C/21A]: when this person
  // connected each account. Never the sealed token.
  async function engineMyConnections(who) {
    return read('engine_page_tokens', `select=account_key,connected_at&who=ilike.${encodeURIComponent(String(who).replace(/[%_*]/g, ''))}`);
  }
  async function engineConnectedTokens() {
    return read('engine_page_tokens', 'select=who,account_key,page_id,ig_id,sealed,connected_at&limit=5000');
  }
  async function engineMetaRights() {
    return read('engine_publish_rights', 'select=who,account_key,checked_at,source&source=eq.meta&limit=5000');
  }
  const rightKey = ({ who, account_key }) => `who=eq.${encodeURIComponent(who)}&account_key=eq.${encodeURIComponent(account_key)}`;
  async function engineDropRight(r) {
    await engineWrite('DELETE', `engine_publish_rights?${rightKey(r)}&source=eq.meta`, undefined, 'return=minimal');
    await engineWrite('DELETE', `engine_page_tokens?${rightKey(r)}`, undefined, 'return=minimal');
  }
  async function engineTouchRight(r, at) {
    await engineWrite('PATCH', `engine_publish_rights?${rightKey(r)}&source=eq.meta`, { checked_at: at }, 'return=minimal');
  }
  // Finished post images, in the private engine-media bucket. The publisher
  // hands Facebook and Instagram a short-lived signed link, never the bucket.
  const MEDIA_BUCKET = 'engine-media';
  async function engineMediaUpload(path, buffer, contentType) {
    const r = await fetch(`${base}/storage/v1/object/${MEDIA_BUCKET}/${path}`, {
      method: 'POST', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': contentType, 'x-upsert': 'true' }, body: buffer,
    });
    if (!r.ok) { console.error(`media upload ${path}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`); throw new Error(`Could not store the image (HTTP ${r.status}).`); }
    return path;
  }
  // Video pieces: what's stored under a prefix (name and size), and one piece.
  async function engineMediaList(prefix) {
    const r = await fetch(`${base}/storage/v1/object/list/${MEDIA_BUCKET}`, {
      method: 'POST', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, limit: 1000, offset: 0, sortBy: { column: 'name', order: 'asc' } }),
    });
    if (!r.ok) throw new Error(`Could not list the video pieces (HTTP ${r.status}).`);
    return (await r.json()).filter((o) => o.id || o.metadata).map((o) => ({ name: o.name, size: Number((o.metadata && o.metadata.size) || 0) }));
  }
  // Inbox: items (people's columns are never in a collector upsert, so a
  // re-read can't undo a Done or an assignment) and actions (the queue and the
  // moderation history).
  const INBOX_COLS = 'select=id,team_id,account_key,platform,kind,thread_id,object_id,parent_id,post_text,post_url,is_ad,author_id,author_name,text,created_at,from_us,hidden,status,assigned_to,labels,replied_at,deleted_at,updated_at,updated_by,tone_set,tone_set_by';
  const INBOX_ACT_COLS = 'select=id,item_id,team_id,account_key,action,text,detail,by,created_at,run_after,status,result,done_at';
  async function engineInbox({ team_ids, statuses, platform, kind, thread_id, author_id, since, before, account_keys, q, limit = 200 } = {}) {
    const parts = [INBOX_COLS];
    if (account_keys && account_keys.length) parts.push(`account_key=in.${encodeURIComponent(inList(account_keys))}`);
    // Search: words in the comment, the person's name or the post's text.
    // PostgREST's or=() needs commas and brackets kept out of the words.
    const qq = String(q || '').replace(/[%_*(),:"\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (qq) parts.push(`or=${encodeURIComponent(`(text.ilike.*${qq}*,author_name.ilike.*${qq}*,post_text.ilike.*${qq}*)`)}`);
    if (team_ids) { if (!team_ids.length) return []; parts.push(`team_id=in.${encodeURIComponent(inList(team_ids))}`); }
    if (statuses && statuses.length) parts.push(`status=in.${encodeURIComponent(inList(statuses))}`);
    if (platform) parts.push(`platform=eq.${encodeURIComponent(platform)}`);
    if (kind) parts.push(`kind=eq.${encodeURIComponent(kind)}`);
    if (thread_id) parts.push(`thread_id=eq.${encodeURIComponent(thread_id)}`);
    if (author_id) parts.push(`author_id=eq.${encodeURIComponent(author_id)}`);
    if (since) parts.push(`created_at=gte.${encodeURIComponent(since)}`);
    if (before) parts.push(`created_at=lt.${encodeURIComponent(before)}`);
    parts.push('deleted_at=is.null', `order=created_at.${thread_id ? 'asc' : 'desc'}`, `limit=${Math.min(1000, Math.max(1, Number(limit) || 200))}`);
    return read('engine_inbox', parts.join('&'));
  }
  // 28A/B (Priority Two, 3 Nov): allies beside our own Instagram accounts over
  // the same days. Likes + comments for both, so the comparison is fair: the
  // ally figures come from business discovery, which gives no reach or saves.
  async function allyBenchmark({ country, since, ig_ids = [] } = {}) {
    const c = country ? `&country=eq.${encodeURIComponent(country)}` : '';
    const s = encodeURIComponent(since);
    const [accts, posts] = await Promise.all([
      read('peer_ig_accounts', `select=username,label,country,topic,followers_count,media_count,last_status&stance=eq.ally&last_status=eq.ok${c}&limit=300`),
      read('peer_ig_latest', `select=username,media_id,like_count,comments_count,timestamp,permalink,caption,media_product_type&stance=eq.ally${c}&timestamp=gte.${s}&order=timestamp.desc&limit=1000`),
    ]);
    const ours = [];
    for (const x of ig_ids.filter(Boolean).slice(0, 6)) {
      const id = typeof x === 'object' ? x.ig_id : x, handle = typeof x === 'object' ? x.handle : null;
      const w = id ? `ig_user_id=eq.${encodeURIComponent(id)}` : handle ? `ig_username=eq.${encodeURIComponent(String(handle).toLowerCase())}` : null;
      if (!w) continue;
      const [m, a] = await Promise.all([
        read('meta_ig_media', `select=media_id,ig_username,permalink,caption,timestamp,media_product_type&${w}&timestamp=gte.${s}&or=(media_product_type.is.null,media_product_type.neq.STORY)&order=timestamp.desc&limit=300`),
        read('meta_ig_account_metrics', `select=ig_username,followers_snapshot,metric_date&${w}&followers_snapshot=not.is.null&order=metric_date.desc&limit=1`),
      ]);
      const ids = (m || []).map((x) => x.media_id);
      const met = [];
      for (let i = 0; i < ids.length; i += 100) met.push(...await read('meta_ig_latest', `select=media_id,likes,comments&media_id=in.(${ids.slice(i, i + 100).map(encodeURIComponent).join(',')})`));
      ours.push({ ig_id: id || null, key: typeof x === 'object' ? x.key : null, username: (a && a[0] && a[0].ig_username) || (m && m[0] && m[0].ig_username) || null, followers: a && a[0] ? a[0].followers_snapshot : null, media: m || [], metrics: met });
    }
    return { accounts: accts || [], posts: posts || [], ours };
  }
  // Priority Two (3 Nov): several items by id (the comments our past replies answered).
  async function engineInboxByIds(ids) {
    const l = [...new Set((ids || []).map(String))].filter(Boolean).slice(0, 300);
    if (!l.length) return [];
    return read('engine_inbox', `${INBOX_COLS}&id=in.${encodeURIComponent(inList(l))}&limit=${l.length}`);
  }
  // 10A: the post a conversation is on, with its newest nightly figures.
  // Facebook: meta_posts + the newest meta_post_metrics row. Instagram:
  // meta_ig_media (its thumbnail can be shown) + the newest metrics row.
  async function postFigures({ platform, id }) {
    const pid = encodeURIComponent(String(id || ''));
    if (!pid) return null;
    if (platform === 'instagram') {
      const [m, x] = await Promise.all([
        read('meta_ig_media', `select=media_id,media_type,media_product_type,caption,permalink,thumbnail_url,timestamp&media_id=eq.${pid}&limit=1`),
        read('meta_ig_media_metrics', `select=collected_date,reach,views,likes,comments,shares,saved,total_interactions&media_id=eq.${pid}&order=collected_date.desc&limit=1`),
      ]);
      const a = (m && m[0]) || null, b = (x && x[0]) || null;
      if (!a && !b) return null;
      return { platform, at: a && a.timestamp, text: a && a.caption, url: a && a.permalink, img: (a && a.thumbnail_url) || null, type: a && (a.media_product_type === 'REELS' ? 'Reel' : a.media_type === 'CAROUSEL_ALBUM' ? 'Carousel' : a.media_type === 'VIDEO' ? 'Video' : 'Photo'),
        collected_date: b && b.collected_date, views: b && (b.views ?? b.reach), reactions: b ? { total: b.likes, like: b.likes } : null, shares: b && b.shares, comments: b && b.comments, saved: b && b.saved };
    }
    const [p, x] = await Promise.all([
      read('meta_posts', `select=post_id,created_time,message,permalink_url,media_type,status_type&post_id=eq.${pid}&limit=1`),
      read('meta_post_metrics', `select=collected_date,views_total,reactions_total,reactions_like,reactions_love,reactions_wow,reactions_haha,reactions_sorry,reactions_anger,shares_total,comments_total&post_id=eq.${pid}&order=collected_date.desc&limit=1`),
    ]);
    const a = (p && p[0]) || null, b = (x && x[0]) || null;
    if (!a && !b) return null;
    return { platform: 'facebook', at: a && a.created_time, text: a && a.message, url: a && a.permalink_url, img: null, type: a && (a.media_type || a.status_type) || null,
      collected_date: b && b.collected_date, views: b && b.views_total,
      reactions: b ? { total: b.reactions_total, like: b.reactions_like, love: b.reactions_love, wow: b.reactions_wow, haha: b.reactions_haha, sorry: b.reactions_sorry, anger: b.reactions_anger } : null,
      shares: b && b.shares_total, comments: b && b.comments_total };
  }
  async function engineInboxItem(id) {
    const rows = await read('engine_inbox', `${INBOX_COLS}&id=eq.${encodeURIComponent(id)}`);
    return (rows && rows[0]) || null;
  }
  async function engineInboxUpsert(rows) {
    if (!rows.length) return 0;
    await engineWrite('POST', 'engine_inbox?on_conflict=id', rows.map((r) => ({ ...r, seen_at: new Date().toISOString() })), 'resolution=merge-duplicates,return=minimal');
    return rows.length;
  }
  async function engineInboxUpdate(id, fields) {
    const rows = await engineWrite('PATCH', `engine_inbox?${INBOX_COLS}&id=eq.${encodeURIComponent(id)}`, fields);
    return (rows && rows[0]) || null;
  }
  async function engineInboxActions({ team_ids, item_ids, statuses, due_before, limit = 200 } = {}) {
    const parts = [INBOX_ACT_COLS];
    if (team_ids) { if (!team_ids.length) return []; parts.push(`team_id=in.${encodeURIComponent(inList(team_ids))}`); }
    if (item_ids) { if (!item_ids.length) return []; parts.push(`item_id=in.${encodeURIComponent(inList(item_ids))}`); }
    if (statuses && statuses.length) parts.push(`status=in.${encodeURIComponent(inList(statuses))}`);
    if (due_before) parts.push(`run_after=lte.${encodeURIComponent(due_before)}`);
    parts.push(`order=${due_before ? 'run_after.asc' : 'created_at.desc'}`, `limit=${Math.min(1000, Math.max(1, Number(limit) || 200))}`);
    return read('engine_inbox_actions', parts.join('&'));
  }
  async function engineInboxInsertAction(row) {
    const rows = await engineWrite('POST', `engine_inbox_actions?${INBOX_ACT_COLS}`, row);
    return (rows && rows[0]) || null;
  }
  // Pile-on alerts.
  const ALERT_COLS = 'select=id,team_id,account_key,thread_id,post_text,post_url,is_ad,at,comments_hour,hostile_hour,baseline,status,seen_by,seen_at';
  async function engineInboxAlerts({ team_ids, statuses, since }) {
    if (!team_ids || !team_ids.length) return [];
    const parts = [ALERT_COLS, `team_id=in.${encodeURIComponent(inList(team_ids))}`];
    if (statuses && statuses.length) parts.push(`status=in.${encodeURIComponent(inList(statuses))}`);
    if (since) parts.push(`at=gte.${encodeURIComponent(since)}`);
    parts.push('order=at.desc', 'limit=100');
    return read('engine_inbox_alerts', parts.join('&'));
  }
  async function engineInsertInboxAlert(row) {
    const rows = await engineWrite('POST', `engine_inbox_alerts?${ALERT_COLS}`, row);
    return (rows && rows[0]) || null;
  }
  async function engineUpdateInboxAlert(id, team_id, fields) {
    const rows = await engineWrite('PATCH', `engine_inbox_alerts?${ALERT_COLS}&id=eq.${Number(id)}&team_id=eq.${encodeURIComponent(team_id)}`, fields);
    return (rows && rows[0]) || null;
  }
  // Tracked links [gaps §6]: the engine's Campaign Copilot sign-in (service
  // key only; a refresh saves only if nobody refreshed first), the links made,
  // and each person's initials.
  async function engineCopilotAuth() { const rows = await read('engine_copilot_auth', 'select=client_id,access_token,refresh_token,expires_at,owner,signed_in_by,updated_at&id=eq.1'); return (rows && rows[0]) || null; }
  async function engineSaveCopilotAuth(fields, { ifRefresh } = {}) {
    if (ifRefresh === undefined) return engineWrite('POST', 'engine_copilot_auth?on_conflict=id', { id: 1, ...fields }, 'resolution=merge-duplicates,return=minimal');
    return engineWrite('PATCH', `engine_copilot_auth?id=eq.1&refresh_token=eq.${encodeURIComponent(ifRefresh)}`, fields, 'return=minimal');
  }
  async function engineTrackedLink(code) { const rows = await read('engine_tracked_links', `select=code,short_url,long_url,via,petition_id,mark,who,created_at&code=eq.${encodeURIComponent(code)}`); return (rows && rows[0]) || null; }
  async function engineSaveTrackedLink(row) { return engineWrite('POST', 'engine_tracked_links?on_conflict=code', row, 'resolution=merge-duplicates,return=minimal'); }
  async function enginePeople() { return read('engine_people', 'select=who,initials,updated_at,updated_by&order=who.asc'); }
  async function engineSetInitials(who, initials, by) { return engineWrite('POST', 'engine_people?on_conflict=who', { who, initials, updated_at: new Date().toISOString(), updated_by: by }, 'resolution=merge-duplicates,return=representation'); }
  // Signatures from social (Looker, nightly on the Mini) by campaign code;
  // markers: reply and DM links (…-DM_xx_…, RE, ADM, ARE).
  async function engineSignatures({ codes = [], markers = false } = {}) {
    const cols = 'select=campaign_code,source,signatures,new_members,reactivated_members,pulled_at';
    const out = [];
    const uniq = [...new Set(codes.map((c) => String(c).toLowerCase()).filter(Boolean))];
    for (let i = 0; i < uniq.length; i += 80) out.push(...await read('link_signatures', `${cols}&campaign_code=in.${encodeURIComponent(inList(uniq.slice(i, i + 80)))}`));
    if (markers) out.push(...await read('link_signatures', `${cols}&campaign_code=match.${encodeURIComponent('^[^-]+-[^-]+-(dm|re|adm|are)_')}&limit=5000`));
    return out;
  }
  // Tools › Health check: when Looker signatures were last pulled.
  async function linkSignaturesPulled() { const rows = await read('link_signatures', 'select=pulled_at&order=pulled_at.desc.nullslast&limit=1'); return (rows && rows[0] && rows[0].pulled_at) || null; }
  // Computed results kept for a few minutes (Analytics, Listening).
  async function engineCacheGet(key) { const rows = await read('engine_cache', `select=value,computed_at&key=eq.${encodeURIComponent(key)}`); return (rows && rows[0]) || null; }
  async function engineCacheSet(key, value) { return engineWrite('POST', 'engine_cache?on_conflict=key', { key, value, computed_at: new Date().toISOString() }, 'resolution=merge-duplicates,return=minimal'); }
  // Every publishing right, for the go-live preflight.
  async function engineAllRights() { return read('engine_publish_rights', 'select=who,account_key,source,checked_at&limit=5000'); }
  // Comment-to-DM automations, and the new Facebook comments they haven't seen.
  const AUTO_COLS = 'select=id,team_id,name,keywords,dm_text,reply_text,reply_texts,scope,post_type,platforms,skip_repeat,tag,hand_to,thread_id,active,created_by,created_at,updated_at,updated_by';
  async function engineAutomations({ team_ids }) {
    if (!team_ids || !team_ids.length) return [];
    return read('engine_automations', `${AUTO_COLS}&team_id=in.${encodeURIComponent(inList(team_ids))}&order=created_at.asc`);
  }
  async function engineInsertAutomation(row) {
    const rows = await engineWrite('POST', `engine_automations?${AUTO_COLS}`, row);
    return (rows && rows[0]) || null;
  }
  async function engineUpdateAutomation(id, team_id, fields) {
    const rows = await engineWrite(fields === null ? 'DELETE' : 'PATCH', `engine_automations?${AUTO_COLS}&id=eq.${Number(id)}&team_id=eq.${encodeURIComponent(team_id)}`, fields || undefined);
    return (rows && rows[0]) || null;
  }
  async function engineInboxAutomationUnchecked({ team_ids, since }) {
    if (!team_ids || !team_ids.length) return [];
    return read('engine_inbox', `${INBOX_COLS}&team_id=in.${encodeURIComponent(inList(team_ids))}&kind=eq.comment&from_us=is.false&automation_checked_at=is.null&created_at=gte.${encodeURIComponent(since)}&deleted_at=is.null&limit=1000`);
  }
  // Auto-hide list, and the new comments it hasn't looked at yet.
  // The desk's Instagram grid [Phase 3]: an account's latest posts, newest
  // first, by Instagram user id or username.
  async function igGridMedia({ ig_user_id, username, limit = 12 } = {}) {
    const who = ig_user_id ? `ig_user_id=eq.${encodeURIComponent(ig_user_id)}` : username ? `ig_username=eq.${encodeURIComponent(String(username).toLowerCase())}` : null;
    if (!who) return [];
    return read('meta_ig_media', `select=media_id,ig_username,media_type,media_product_type,caption,permalink,thumbnail_url,timestamp&${who}&or=(media_product_type.is.null,media_product_type.neq.STORY)&order=timestamp.desc&limit=${Math.min(30, Math.max(1, Number(limit) || 12))}`);
  }
  // Link in bio [Phase 3]: one row per team (engine_bio), clicks per button
  // per day (engine_bio_clicks, bumped by the engine_bio_click function).
  const BIO_COLS = 'select=team_id,slug,title,intro,auto,items,settings,updated_at,updated_by';
  async function engineBio({ team_id, slug } = {}) {
    const q = team_id ? `team_id=eq.${encodeURIComponent(team_id)}` : slug ? `slug=eq.${encodeURIComponent(slug)}` : null;
    if (!q) return null;
    const rows = await read('engine_bio', `${BIO_COLS}&${q}&limit=1`);
    return (rows && rows[0]) || null;
  }
  async function engineSaveBio(row) {
    const rows = await engineWrite('POST', `engine_bio?on_conflict=team_id&${BIO_COLS}`, row, 'resolution=merge-duplicates,return=representation');
    return (rows && rows[0]) || null;
  }
  async function engineBioClick(slug, item_id) {
    const r = await fetch(`${base}/rest/v1/rpc/engine_bio_click`, { method: 'POST', headers: { ...headersFor(), 'Content-Type': 'application/json' }, body: JSON.stringify({ p_slug: slug, p_item: item_id }) });
    if (!r.ok) console.error(`engine_bio_click failed: HTTP ${r.status}`);
    return r.ok;
  }
  async function engineBioClicks({ slug, since }) {
    return read('engine_bio_clicks', `select=item_id,day,clicks&slug=eq.${encodeURIComponent(slug)}&day=gte.${encodeURIComponent(since)}&limit=5000`);
  }
  // Every saved page (the global link's country routing and picker).
  async function engineBios() { return read('engine_bio', 'select=team_id,slug,title&order=team_id.asc'); }
  // Petition totals (Bluebook) and closed hints (Asana), pulled nightly on
  // the Mini (scripts/load-petition-status.js).
  async function petitionStatus({ ids }) {
    const uniq = [...new Set((ids || []).map(String).filter((x) => /^\d+$/.test(x)))];
    const out = [];
    for (let i = 0; i < uniq.length; i += 100) out.push(...await read('petition_status', `select=petition_id,total,last14,bb_pulled_at,asana_project,asana_closed,asana_victory,asana_checked_at&petition_id=in.(${uniq.slice(i, i + 100).join(',')})`));
    return out;
  }
  // 37A (4 Nov): pictures for Listening's wall: allies' and opponents'
  // Instagram posts (peer_ig_media.thumbnail_url) and CitizenGO Facebook posts
  // (meta_posts.picture_url). Both columns come from sql/listen-pictures.sql;
  // before it runs, this answers with no pictures rather than failing.
  async function listenPictures({ ig_ids = [], fb_ids = [] } = {}) {
    const clean = (xs, re) => [...new Set((xs || []).map(String).filter((x) => re.test(x)))].slice(0, 200);
    const ig = clean(ig_ids, /^\d+$/), fb = clean(fb_ids, /^\d+(_\d+)?$/);
    const out = {};
    const get = async (table, sel, key, col, ids) => {
      for (let i = 0; i < ids.length; i += 100) {
        const rows = await read(table, `select=${key},${col}&${key}=in.(${ids.slice(i, i + 100).join(',')})&${col}=not.is.null`).catch(() => []);
        for (const r of rows || []) if (r[col]) out[r[key]] = r[col];
      }
    };
    await Promise.all([get('peer_ig_media', null, 'media_id', 'thumbnail_url', ig), get('meta_posts', null, 'post_id', 'picture_url', fb)]);
    return out;
  }
  async function igMediaByIds({ ids }) {
    const uniq = [...new Set((ids || []).map(String).filter((x) => /^\d+$/.test(x)))];
    if (!uniq.length) return [];
    return read('meta_ig_media', `select=media_id,thumbnail_url,permalink,caption,timestamp&media_id=in.(${uniq.slice(0, 100).join(',')})`);
  }
  // Signatures from Link in bio buttons: Copilot codes marked BIO.
  async function bioSignatures() {
    return read('link_signatures', `select=petition_id,campaign_code,signatures&campaign_code=match.${encodeURIComponent('^[^-]+-[^-]+-bio_')}&limit=5000`);
  }
  async function linkPostsSince({ since }) {
    return read('link_posts', `select=platform,post_id,account_id,account_label,url,full_url,petition_id,posted_at&posted_at=gte.${encodeURIComponent(since)}&petition_id=not.is.null&order=posted_at.desc&limit=2000`);
  }
  async function engineInboxRules({ team_ids }) {
    if (!team_ids || !team_ids.length) return [];
    return read('engine_inbox_rules', `select=id,team_id,kind,value,created_by,created_at&team_id=in.${encodeURIComponent(inList(team_ids))}&order=created_at.asc`);
  }
  async function engineInboxUnchecked({ team_ids, since }) {
    if (!team_ids || !team_ids.length) return [];
    return read('engine_inbox', `${INBOX_COLS}&team_id=in.${encodeURIComponent(inList(team_ids))}&kind=eq.comment&from_us=is.false&auto_checked_at=is.null&created_at=gte.${encodeURIComponent(since)}&deleted_at=is.null&limit=1000`);
  }
  async function engineInsertInboxRule(row) {
    const rows = await engineWrite('POST', 'engine_inbox_rules?select=id,team_id,kind,value,created_by,created_at', row);
    return (rows && rows[0]) || null;
  }
  async function engineDeleteInboxRule(id, team_id) {
    const rows = await engineWrite('DELETE', `engine_inbox_rules?select=id&id=eq.${Number(id)}&team_id=eq.${encodeURIComponent(team_id)}`);
    return (rows && rows[0]) || null;
  }
  // Only moves an action on from the status it had (so a cancel can't race a
  // claim): null when it had already moved.
  // Inbox checks [Priority One, 3 Nov]: whose Meta actions wait for a check.
  async function engineSetNeedsCheck(team_id, who, needs_check) {
    const rows = await engineWrite('PATCH', `engine_members?select=team_id,who,role,needs_check&team_id=eq.${encodeURIComponent(team_id)}&who=eq.${encodeURIComponent(who)}`, { needs_check: !!needs_check });
    return (rows && rows[0]) || null;
  }
  // A person's own desk settings and saved views (one jsonb per person).
  async function enginePrefs(who) {
    const rows = await read('engine_people', `select=who,prefs&who=ilike.${encodeURIComponent(String(who).replace(/[%_*]/g, ''))}`);
    return (rows && rows[0] && rows[0].prefs) || {};
  }
  async function engineSavePrefs(who, prefs, by) {
    await engineWrite('POST', 'engine_people?on_conflict=who', { who, prefs, updated_at: new Date().toISOString(), updated_by: by }, 'resolution=merge-duplicates,return=minimal');
    return prefs;
  }
  async function engineInboxUpdateAction(id, fromStatus, fields) {
    const rows = await engineWrite('PATCH', `engine_inbox_actions?${INBOX_ACT_COLS}&id=eq.${Number(id)}&status=eq.${encodeURIComponent(fromStatus)}`, fields);
    return (rows && rows[0]) || null;
  }
  // Sub-folders directly under a prefix (Storage lists them with no id).
  async function engineMediaFolders(prefix) {
    const r = await fetch(`${base}/storage/v1/object/list/${MEDIA_BUCKET}`, {
      method: 'POST', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, limit: 1000, offset: 0 }),
    });
    if (!r.ok) throw new Error(`Could not list ${prefix} (HTTP ${r.status}).`);
    return (await r.json()).filter((o) => !o.id && !o.metadata).map((o) => o.name);
  }
  async function engineMediaRemove(paths) {
    if (!paths.length) return;
    const r = await fetch(`${base}/storage/v1/object/${MEDIA_BUCKET}`, {
      method: 'DELETE', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: paths }),
    });
    if (!r.ok) throw new Error(`Could not remove the video pieces (HTTP ${r.status}).`);
  }
  async function engineMediaDownload(path) {
    const r = await fetch(`${base}/storage/v1/object/${MEDIA_BUCKET}/${path}`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  }
  async function engineMediaUrl(path, expiresIn = 3600) {
    const r = await fetch(`${base}/storage/v1/object/sign/${MEDIA_BUCKET}/${path}`, {
      method: 'POST', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn }),
    });
    if (!r.ok) return null;
    const body = await r.json();
    const signed = body.signedURL || body.signedUrl;
    return signed ? `${base}/storage/v1${signed.startsWith('/') ? '' : '/'}${signed}` : null;
  }
  async function engineEvergreen({ team_ids } = {}) {
    if (!team_ids || !team_ids.length) return [];
    return read('engine_evergreen', `${ENGINE_EG_COLS}&team_id=in.${encodeURIComponent(inList(team_ids))}&order=last_out.asc&limit=500`);
  }
  async function engineInsertEvergreen(row) {
    const rows = await engineWrite('POST', `engine_evergreen?${ENGINE_EG_COLS}`, row);
    return rows && rows[0];
  }
  async function engineUpdateEvergreen(id, fields) {
    const rows = await engineWrite('PATCH', `engine_evergreen?${ENGINE_EG_COLS}&id=eq.${Number(id)}`, { ...fields, updated_at: new Date().toISOString() });
    return (rows && rows[0]) || null;
  }
  async function engineRequests({ team_ids, from, to, statuses } = {}) {
    if (!team_ids || !team_ids.length) return [];
    const parts = [ENGINE_REQ_COLS, `team_id=in.${encodeURIComponent(inList(team_ids))}`];
    if (statuses && statuses.length) parts.push(`status=in.${encodeURIComponent(inList(statuses))}`);
    if (from) parts.push(`for_date=gte.${encodeURIComponent(from)}`);
    if (to) parts.push(`for_date=lt.${encodeURIComponent(to)}`);
    parts.push('order=for_date.asc', 'limit=500');
    return read('engine_requests', parts.join('&'));
  }
  async function engineInsertRequest(row) {
    const rows = await engineWrite('POST', `engine_requests?${ENGINE_REQ_COLS}`, row);
    return rows && rows[0];
  }
  // Only an open request changes, so a request drafted meanwhile is never reopened.
  async function engineUpdateRequest(id, fields) {
    const rows = await engineWrite('PATCH', `engine_requests?${ENGINE_REQ_COLS}&id=eq.${Number(id)}&status=eq.open`, fields);
    return (rows && rows[0]) || null;
  }
  async function enginePost(id) {
    const rows = await read('engine_posts', `${ENGINE_POST_COLS}&id=eq.${encodeURIComponent(id)}`);
    return rows && rows[0] ? rows[0] : null;
  }
  async function engineInsertPost(row) {
    const rows = await engineWrite('POST', `engine_posts?${ENGINE_POST_COLS}`, row);
    return rows[0];
  }
  // Only updates when the stored version is still `version`: a save from an
  // out-of-date desk gets null back (a conflict), never overwrites.
  async function engineUpdatePost(id, version, fields) {
    const rows = await engineWrite('PATCH',
      `engine_posts?${ENGINE_POST_COLS}&id=eq.${encodeURIComponent(id)}&version=eq.${Number(version)}`,
      { ...fields, version: Number(version) + 1, updated_at: new Date().toISOString() });
    return rows && rows[0] ? rows[0] : null;
  }
  async function engineEvent(row) {
    // The log must never block the change it records.
    try { await engineWrite('POST', 'engine_events', row, 'return=minimal'); } catch (e) { /* logged by engineWrite */ }
  }

  async function inviterUsage({ since }) {
    return readPaged('inviter_usage', `day,user_email,device_id,page_id,page_name,invites,extension_version,updated_at&day=gte.${since}`, 'day');
  }

  // One Page's posts created since `since` and their metric snapshots, for the Page
  // Inviter's per-Page lookups. loadAll reads every Page's history, which made
  // inviter_posts slow enough for the extension to time out (20 s) and then treat
  // a Page that has stopped posting as active.
  async function loadPageFeed(pageId, since) {
    const id = encodeURIComponent(pageId);
    const sinceDay = String(since).slice(0, 10);
    const [pages, posts, metrics] = await Promise.all([
      read('meta_pages', `select=*&page_id=eq.${id}`),
      readPaged('meta_posts', `*&page_id=eq.${id}&created_time=gte.${encodeURIComponent(since)}`, 'post_id'),
      readPaged('meta_post_metrics', `*&page_id=eq.${id}&collected_date=gte.${sinceDay}`, 'id'),
    ]);
    return { pages: Array.isArray(pages) ? pages : [], posts, metrics };
  }

  return {
    name: 'supabase',
    loadPageFeed,
    upsertInviterUsage,
    inviterUsage,
    counts,
    pageCoverage,
    pruneAuthFailures,
    igCoverage,
    adSpendCoverage,
    inviterConfigs,
    inviterConfigById,
    insertInviterConfig,
    engineTeams,
    engineMembers,
    engineRights,
    enginePosts,
    enginePost,
    engineInsertPost,
    engineUpdatePost,
    engineEvent,
    engineKeyDates,
    engineRequests,
    engineEvergreen,
    enginePageToken,
    engineConnectedTokens, engineMyConnections,
    enginePauses,
    engineInsertPause,
    engineResumePause,
    engineMetaRights,
    engineDropRight,
    engineTouchRight,
    engineMediaUpload,
    engineMediaUrl,
    engineMediaList,
    engineMediaDownload,
    engineMediaFolders,
    engineInbox,
    engineInboxItem,
    engineInboxUpsert,
    engineInboxUpdate,
    engineInboxActions,
    engineInboxInsertAction,
    engineInboxRules,
    igGridMedia,
    engineInboxByIds,
    postFigures,
    allyBenchmark,
    engineBio,
    engineSaveBio,
    engineBioClick,
    engineBioClicks,
    engineBios,
    petitionStatus,
    igMediaByIds,
    listenPictures,
    bioSignatures,
    linkPostsSince,
    engineAutomations,
    engineAllRights,
    engineAccessLimits, engineSetAccessLimit, engineAllRightsFor, engineCacheGet, engineCacheSet, engineSignatures, linkSignaturesPulled,
    engineCopilotAuth, engineSaveCopilotAuth, engineTrackedLink, engineSaveTrackedLink, enginePeople, engineSetInitials,
    engineInsertAutomation,
    engineUpdateAutomation,
    engineInboxAutomationUnchecked,
    engineInboxAlerts,
    engineInsertInboxAlert,
    engineUpdateInboxAlert,
    engineInboxUnchecked,
    engineInsertInboxRule,
    engineDeleteInboxRule,
    engineInboxUpdateAction, engineSetNeedsCheck, enginePrefs, engineSavePrefs,
    engineMediaRemove,
    engineInsertEvergreen,
    engineUpdateEvergreen,
    engineInsertRequest,
    engineUpdateRequest,
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
    // Calendar-month account totals (meta_ig_account_months), for the given
    // months (YYYY-MM-01). A handful of rows per account; no paging needed.
    async igAccountMonths({ months, page_id }) {
      const parts = ['select=*', `month=in.(${months.map(encodeURIComponent).join(',')})`];
      if (page_id) parts.push(`page_id=eq.${encodeURIComponent(page_id)}`);
      parts.push('order=ig_username.asc,month.asc&limit=2000');
      return read('meta_ig_account_months', parts.join('&'));
    },
    // Latest audience snapshot per account (meta_ig_audience): the newest
    // collected_date's rows, every kind and breakdown.
    async igAudience({ page_id }) {
      const w = page_id ? `&page_id=eq.${encodeURIComponent(page_id)}` : '';
      const latest = await read('meta_ig_audience', `select=collected_date&order=collected_date.desc&limit=1${w}`);
      if (!Array.isArray(latest) || !latest.length) return [];
      return read('meta_ig_audience', `select=*&collected_date=eq.${latest[0].collected_date}${w}&order=ig_username.asc&limit=2000`);
    },
    // Posts others tagged our accounts in (meta_social_tags), newest first.
    async socialTags({ since, page_id, platform, limit = 50 }) {
      const parts = ['select=*'];
      if (since) parts.push(`created_at=gte.${encodeURIComponent(since)}`);
      if (page_id) parts.push(`page_id=eq.${encodeURIComponent(page_id)}`);
      if (platform) parts.push(`platform=eq.${encodeURIComponent(platform)}`);
      parts.push(`order=created_at.desc.nullslast&limit=${Math.min(Math.max(Number(limit) || 50, 1), 500)}`);
      return read('meta_social_tags', parts.join('&'));
    },
    // Instagram profile actions per day: visits, link clicks, button taps.
    async igProfileActions({ since, until, page_id }) {
      const parts = ['select=ig_username,metric_date,profile_views,website_clicks,profile_links_taps'];
      if (since) parts.push(`metric_date=gte.${encodeURIComponent(since)}`);
      if (until) parts.push(`metric_date=lte.${encodeURIComponent(until)}`);
      if (page_id) parts.push(`page_id=eq.${encodeURIComponent(page_id)}`);
      parts.push('order=metric_date.asc&limit=5000');
      return read('meta_ig_account_metrics', parts.join('&'));
    },
    // Facebook video retention curves: each video post's latest reading.
    async videoRetention({ since, page_id, post_id }) {
      const parts = ['select=post_id,page_id,collected_date,video_retention,video_views,video_avg_seconds_watched', 'video_retention=not.is.null'];
      if (post_id) parts.push(`post_id=eq.${encodeURIComponent(post_id)}`);
      if (page_id) parts.push(`page_id=eq.${encodeURIComponent(page_id)}`);
      if (since) parts.push(`collected_date=gte.${encodeURIComponent(since)}`);
      parts.push('order=collected_date.desc&limit=2000');
      const rows = await read('meta_post_metrics', parts.join('&'));
      const latest = new Map();
      for (const r of rows || []) if (!latest.has(r.post_id)) latest.set(r.post_id, r);
      const ids = [...latest.keys()].slice(0, 200);
      const posts = ids.length ? await read('meta_posts', `select=post_id,message,permalink_url,created_time&post_id=in.(${ids.map(encodeURIComponent).join(',')})`) : [];
      const byId = new Map((posts || []).map((p) => [p.post_id, p]));
      return ids.map((id) => ({ ...latest.get(id), ...(byId.get(id) || {}) }));
    },
    // Views and interactions of the posts PUBLISHED in a window, per account:
    // the fallback for a month whose account totals were never read.
    async igMonthPosts({ since, until, page_id }) {
      const parts = ['select=page_id,ig_username,views,total_interactions',
        `timestamp=gte.${encodeURIComponent(since)}`, `timestamp=lt.${encodeURIComponent(until)}`];
      if (page_id) parts.push(`page_id=eq.${encodeURIComponent(page_id)}`);
      parts.push('order=media_id.asc');
      const out = [];
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const batch = await read('meta_ig_latest', `${parts.join('&')}&limit=${PAGE_SIZE}&offset=${offset}`);
        if (!Array.isArray(batch) || !batch.length) break;
        out.push(...batch);
        if (batch.length < PAGE_SIZE) break;
        if (out.length >= 50000) throw new Error('meta_ig_latest: more than 50000 posts in one month — narrow it');
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
      // Stories are held from 5 Nov 2026; they are read on request, never
      // ranked among posts and Reels (24-hour content, different numbers).
      if (TYPE) parts.push(TYPE);
      // Any filter but "stories" still leaves Stories out: an image Story is
      // media_type IMAGE too.
      if (type !== 'stories') parts.push('or=(media_product_type.is.null,media_product_type.neq.STORY)');
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
    // Link performance (sql/links-schema.sql). Posts carrying our links, from
    // every connected account. `account` matches an id or a label fragment.
    async linkPosts({ account, owner, petition_id, campaign, platform, since, until, max = 20000 } = {}) {
      const parts = ['select=platform,post_id,url,account_id,account_label,account_kind,posted_at,permalink_url,campaign_code,utm_source,petition_id,owner,series'];
      if (account) {
        const a = String(account).replace(/[,()*]/g, ' ').trim();
        parts.push(`or=(account_id.eq.${encodeURIComponent(a)},account_label.ilike.${encodeURIComponent('*' + a.replace(/^@/, '') + '*')})`);
      }
      if (owner) parts.push(`owner=eq.${encodeURIComponent(String(owner).toLowerCase())}`);
      if (petition_id) parts.push(`petition_id=eq.${encodeURIComponent(String(petition_id))}`);
      if (campaign) parts.push(`campaign_code=ilike.${encodeURIComponent('*' + String(campaign).toLowerCase().replace(/[*,()]/g, '') + '*')}`);
      if (platform) parts.push(`platform=eq.${encodeURIComponent(platform)}`);
      if (since) parts.push(`posted_at=gte.${encodeURIComponent(since)}`);
      if (until) parts.push(`posted_at=lt.${encodeURIComponent(until)}`);
      parts.push('order=posted_at.desc');
      const out = [];
      try {
        for (let off = 0; off < max; off += 1000) {
          const rows = await read('link_posts', parts.concat(`limit=1000`, `offset=${off}`).join('&'));
          out.push(...rows);
          if (rows.length < 1000) break;
        }
      } catch (e) { if (e.pgCode === '42P01' || e.status === 404) return []; throw e; }
      return out;
    },
    // Signatures per campaign code and arrival source: either for given codes,
    // or every code by an owner / for a petition (codes never seen in a post).
    async linkSignatures({ codes, owner, petition_id, from, to } = {}) {
      const sel = 'select=campaign_code,source,signatures,new_members,reactivated_members,owner,petition_id,series,code_date';
      const out = [];
      try {
        if (codes) {
          const list = [...new Set(codes.filter(Boolean))];
          for (let i = 0; i < list.length; i += 80) {
            const inList = list.slice(i, i + 80).map((c) => `"${String(c).replace(/"/g, '')}"`).join(',');
            out.push(...await read('link_signatures', `${sel}&campaign_code=in.(${encodeURIComponent(inList)})&limit=10000`));
          }
          return out;
        }
        const parts = [sel];
        if (owner) parts.push(`owner=eq.${encodeURIComponent(String(owner).toLowerCase())}`);
        if (petition_id) parts.push(`petition_id=eq.${encodeURIComponent(String(petition_id))}`);
        if (from) parts.push(`code_date=gte.${String(from).slice(0, 10)}`);
        if (to) parts.push(`code_date=lt.${String(to).slice(0, 10)}`);
        return await read('link_signatures', parts.concat('limit=20000').join('&'));
      } catch (e) { if (e.pgCode === '42P01' || e.status === 404) return []; throw e; }
    },
    // How many people each post behind some links could have sent, so the tool
    // can tell when a link's signatures cannot have come from these posts. One
    // shape for every platform: { post_id, platform, impressions, url_link_clicks }
    // (url_link_clicks null = not known).
    //   X         impressions and URL link clicks (x_post_latest).
    //   Facebook  views, organic + paid (views_total; a boosted post's ad
    //             impressions when the ads API counted more), and ALL clicks:
    //             "link clicks" counts only the link attachment, and a link in
    //             the message text is counted as "other clicks".
    //   Instagram the larger of reach and views (meta_ig_latest for our Pages,
    //             ig_media_latest for accounts connected by their holders).
    //             Caption links cannot be clicked, so clicks stay unknown.
    async linkPostReach({ xPostIds = [], fbPostIds = [], igMediaIds = [] } = {}) {
      const out = [];
      const num = (v) => (v === null || v === undefined ? null : Number(v));
      const chunks = (arr) => {
        const ids = [...new Set(arr.filter(Boolean).map(String))];
        const c = [];
        for (let i = 0; i < ids.length; i += 100) c.push(encodeURIComponent(ids.slice(i, i + 100).map((x) => `"${x.replace(/"/g, '')}"`).join(',')));
        return c;
      };
      const tolerant = async (fn) => { try { return await fn(); } catch (e) { if (e.pgCode === '42P01' || e.status === 404) return []; throw e; } };
      for (const list of chunks(xPostIds)) {
        const rows = await tolerant(() => read('x_post_latest', `select=post_id,impressions,url_link_clicks&post_id=in.(${list})`));
        out.push(...rows.map((r) => ({ post_id: r.post_id, platform: 'x', impressions: num(r.impressions), url_link_clicks: num(r.url_link_clicks) })));
      }
      for (const list of chunks(fbPostIds)) {
        const [rows, ads] = await Promise.all([
          tolerant(() => read('meta_post_latest', `select=post_id,views_total,views_organic,clicks_total&post_id=in.(${list})`)),
          tolerant(() => read('meta_post_ad_spend', `select=post_id,impressions&post_id=in.(${list})`)),
        ]);
        const adImpr = new Map();
        for (const a of ads) adImpr.set(a.post_id, (adImpr.get(a.post_id) || 0) + (Number(a.impressions) || 0));
        out.push(...rows.map((r) => {
          const views = num(r.views_total);
          const withAds = adImpr.has(r.post_id) ? (Number(r.views_organic) || 0) + adImpr.get(r.post_id) : null;
          return { post_id: r.post_id, platform: 'facebook', impressions: views === null && withAds === null ? null : Math.max(views || 0, withAds || 0), url_link_clicks: num(r.clicks_total) };
        }));
      }
      for (const list of chunks(igMediaIds)) {
        const [pageIg, connected] = await Promise.all([
          tolerant(() => read('meta_ig_latest', `select=media_id,reach,views&media_id=in.(${list})`)),
          tolerant(() => read('ig_media_latest', `select=media_id,reach,views&media_id=in.(${list})`)),
        ]);
        for (const r of [...pageIg, ...connected]) {
          if (r.reach === null && r.views === null) continue;
          out.push({ post_id: r.media_id, platform: 'instagram', impressions: Math.max(Number(r.reach) || 0, Number(r.views) || 0), url_link_clicks: null });
        }
      }
      return out;
    },
    async linkFreshness() {
      try {
        const [s] = await read('link_signatures', 'select=pulled_at&order=pulled_at.desc&limit=1');
        const [p] = await read('link_posts', 'select=updated_at&order=updated_at.desc&limit=1');
        return { pulledAt: s ? s.pulled_at : null, registryAt: p ? p.updated_at : null };
      } catch (e) { if (e.pgCode === '42P01' || e.status === 404) return { pulledAt: null, registryAt: null }; throw e; }
    },
    // Instagram accounts connected by their holders (sql/ig-schema.sql).
    async igConnectedAccounts() {
      try {
        const accts = await read('ig_accounts', 'select=ig_user_id,username,label,kind,full_collection,access,account_type,followers_count,media_count,authorized_at,last_seen_at,is_active&order=label.asc');
        const toks = await read('ig_oauth_tokens', 'select=ig_user_id,expires_at,last_error&revoked_at=is.null');
        return accts.map((a) => ({ ...a, token: toks.find((t) => t.ig_user_id === a.ig_user_id) || null }));
      } catch (e) { if (e.pgCode === '42P01' || e.status === 404) return []; throw e; }
    },
    async igConnectedPosts({ account, since, until, order = 'timestamp', limit = 25, offset = 0 } = {}) {
      const parts = ['select=media_id,username,label,kind,caption,media_type,media_product_type,permalink,timestamp,citizengo_urls,collected_date,reach,views,likes,comments,shares,saved,total_interactions'];
      if (account) {
        const a = String(account).replace(/[,()*]/g, ' ').trim().replace(/^@/, '');
        parts.push(`or=(ig_user_id.eq.${encodeURIComponent(a)},username.ilike.${encodeURIComponent('*' + a + '*')},label.ilike.${encodeURIComponent('*' + a + '*')})`);
      }
      if (since) parts.push(`timestamp=gte.${encodeURIComponent(since)}`);
      if (until) parts.push(`timestamp=lt.${encodeURIComponent(until)}`);
      const col = ['timestamp', 'reach', 'views', 'total_interactions', 'shares'].includes(order) ? order : 'timestamp';
      parts.push(`order=${col}.desc.nullslast`, `limit=${Math.min(Number(limit) || 25, 200)}`, `offset=${Math.max(Number(offset) || 0, 0)}`);
      try { return await read('ig_media_latest', parts.join('&')); }
      catch (e) { if (e.pgCode === '42P01' || e.status === 404) return []; throw e; }
    },
    // topic_performance: every post on every platform in a window, with only the
    // columns needed to match a topic and score each post against its own
    // account's median. Paged, because a 90-day window is over 4,000 Facebook
    // posts and PostgREST would silently stop at 1,000. A platform whose view is
    // missing comes back as null (not collected), never as an empty estate.
    async topicCorpus({ since, until } = {}) {
      const SOURCES = {
        facebook: ['meta_post_latest', 'post_id,page_id,page_name,created_time,message,permalink_url,views_total', 'created_time'],
        instagram: ['meta_ig_searchable', 'media_id,page_id,page_name,ig_username,timestamp,caption,transcript,permalink,reach', 'timestamp'],
        x: ['x_post_latest', 'post_id,account_id,username,kind,created_at,text,permalink_url,impressions', 'created_at'],
      };
      const out = {};
      await Promise.all(Object.entries(SOURCES).map(async ([platform, [table, select, col]]) => {
        const where = [];
        if (since) where.push(`${col}=gte.${encodeURIComponent(since)}`);
        if (until) where.push(`${col}=lt.${encodeURIComponent(until)}`);
        const rows = [];
        try {
          for (let offset = 0; ; offset += PAGE_SIZE) {
            const batch = await read(table, [`select=${select}`, ...where, `order=${col}.desc`, `limit=${PAGE_SIZE}`, `offset=${offset}`].join('&'));
            if (!Array.isArray(batch) || !batch.length) break;
            rows.push(...batch);
            if (batch.length < PAGE_SIZE || rows.length >= 50000) break;
          }
          out[platform] = rows;
        } catch (e) {
          if (e.pgCode === '42P01' || e.pgCode === '42703' || e.status === 404) out[platform] = null;
          else throw e;
        }
      }));
      return out;
    },
    // Ally watch: peer organisations' public Instagram posts (sql/peer-schema.sql).
    async peerAccounts() {
      try {
        return await read('peer_ig_accounts', 'select=username,label,country,topic,stance,followers_count,last_status,last_checked_at&order=label.asc&limit=1000');
      } catch (e) { if (e.pgCode === '42P01' || e.status === 404) return []; throw e; }
    },
    async peerPosts({ stance, account, country, topic, q, min, since, until, order = 'vs_median', limit = 25, offset = 0 } = {}) {
      const parts = ['select=media_id,username,label,country,topic,media_type,media_product_type,caption,permalink,timestamp,collected_date,like_count,comments_count,engagement,settled,median_engagement,baseline_posts,vs_median'];
      const clean = (s) => String(s).replace(/[,()*]/g, ' ').trim();
      if (account) {
        const a = clean(account).replace(/^@/, '');
        parts.push(`or=(username.ilike.${encodeURIComponent('*' + a + '*')},label.ilike.${encodeURIComponent('*' + a + '*')})`);
      }
      if (stance) parts.push(`stance=eq.${stance === 'opponent' ? 'opponent' : 'ally'}`);
      if (country) parts.push(`country=eq.${encodeURIComponent(clean(country).toUpperCase())}`);
      if (topic) parts.push(`topic=ilike.${encodeURIComponent('*' + clean(topic) + '*')}`);
      if (q) parts.push(`caption=ilike.${encodeURIComponent('*' + clean(q) + '*')}`);
      if (Number(min) > 0) parts.push(`vs_median=gte.${Number(min)}`);
      if (since) parts.push(`timestamp=gte.${encodeURIComponent(since)}`);
      if (until) parts.push(`timestamp=lt.${encodeURIComponent(until)}`);
      const col = ['vs_median', 'engagement', 'timestamp'].includes(order) ? order : 'vs_median';
      parts.push(`order=${col}.desc.nullslast`, `limit=${Math.min(Number(limit) || 25, 200)}`, `offset=${Math.max(Number(offset) || 0, 0)}`);
      try { return await read('peer_ig_latest', parts.join('&')); }
      catch (e) { if (e.pgCode === '42P01' || e.status === 404) return []; throw e; }
    },
    // Listening › Beyond our list: hashtag posts and topic headlines.
    async listenHashtagMedia({ since } = {}) {
      try { return await read('listen_hashtag_media', `select=hashtag,media_id,caption,permalink,posted_at,media_type,like_count,comments_count,top&posted_at=gte.${encodeURIComponent(since)}&order=posted_at.desc&limit=5000`); }
      catch (e) { if (e.pgCode === '42P01' || e.status === 404) return []; throw e; }
    },
    async listenNews({ since, edition = 'uk' } = {}) {
      // One edition's headlines (sql/mexico-team.sql adds the column; until it
      // runs every row is the UK edition, so the UK still reads them all).
      try { return await read('listen_news', `select=url,topic,title,source,published_at&published_at=gte.${encodeURIComponent(since)}&edition=eq.${encodeURIComponent(edition)}&order=published_at.desc&limit=1000`); }
      catch (e) { if (edition !== 'uk') return []; }
      try { return await read('listen_news', `select=url,topic,title,source,published_at&published_at=gte.${encodeURIComponent(since)}&order=published_at.desc&limit=1000`); }
      catch (e) { if (e.pgCode === '42P01' || e.status === 404) return []; throw e; }
    },
    // Listening "Rising now": each watched post's daily likes and comments, so
    // the desk can show what it gained since the day before.
    async peerDayMetrics(ids = []) {
      const list = [...new Set(ids.map(String).filter((x) => /^[0-9A-Za-z_]+$/.test(x)))].slice(0, 200);
      if (!list.length) return [];
      const since = new Date(Date.now() - 4 * 864e5).toISOString().slice(0, 10);
      try { return await read('peer_ig_media_metrics', `select=media_id,collected_date,like_count,comments_count&media_id=in.(${list.join(',')})&collected_date=gte.${since}&order=collected_date.asc&limit=1000`); }
      catch (e) { if (e.pgCode === '42P01' || e.status === 404) return []; throw e; }
    },
    // uk_digest (mcp/digest-tools.js): every watched post since a date, paged.
    async peerRecent({ since, until } = {}) {
      const base = ['select=username,label,country,stance,caption,permalink,timestamp,like_count,comments_count,vs_median,settled',
        `timestamp=gte.${encodeURIComponent(since)}`, ...(until ? [`timestamp=lte.${encodeURIComponent(until)}`] : []), 'order=timestamp.desc,media_id.asc'];
      const out = [];
      try {
        for (let offset = 0; ; offset += PAGE_SIZE) {
          const batch = await read('peer_ig_latest', [...base, `limit=${PAGE_SIZE}`, `offset=${offset}`].join('&'));
          if (!Array.isArray(batch) || !batch.length) break;
          out.push(...batch);
          if (batch.length < PAGE_SIZE || out.length >= 50000) break;
        }
        return out;
      } catch (e) { if (e.pgCode === '42P01' || e.pgCode === '42703' || e.status === 404) return []; throw e; }
    },
    // uk_digest: opponent ads we first saw in a window (new to us, not just new).
    async opponentAdsSeen({ since, until } = {}) {
      const parts = ['select=ad_id,label,page_name,delivery_start,link_titles,bodies,snapshot_url,spend_lower,spend_upper,currency',
        `first_seen_at=gte.${encodeURIComponent(since)}`];
      if (until) parts.push(`first_seen_at=lt.${encodeURIComponent(until)}`);
      // Paged: a partial day would understate spend and miss a burst.
      parts.push('order=first_seen_at.desc,ad_id.asc');
      const out = [];
      try {
        for (let offset = 0; ; offset += PAGE_SIZE) {
          const batch = await read('opponent_ads', [...parts, `limit=${PAGE_SIZE}`, `offset=${offset}`].join('&'));
          if (!Array.isArray(batch) || !batch.length) break;
          out.push(...batch);
          if (batch.length < PAGE_SIZE || out.length >= 50000) break;
        }
        return out;
      } catch (e) { if (e.pgCode === '42P01' || e.status === 404) return []; throw e; }
    },
    // Opponents' UK issue ads (sql/opponent-schema.sql), started in the window.
    async opponentAds({ account, topic, q, since, until } = {}) {
      const clean = (s) => String(s).replace(/[,()*]/g, ' ').trim();
      const parts = ['select=ad_id,page_id,page_name,label,topic,delivery_start,delivery_stop,bodies,link_titles,snapshot_url,spend_lower,spend_upper,impressions_lower,impressions_upper,currency'];
      // Two either-or filters cannot both be or= parameters, so they are ANDed explicitly.
      const ors = [];
      if (account) { const a = encodeURIComponent('*' + clean(account).replace(/^@/, '') + '*'); ors.push(`or(label.ilike.${a},page_name.ilike.${a})`); }
      if (q) { const t = encodeURIComponent('*' + clean(q) + '*'); ors.push(`or(bodies.ilike.${t},link_titles.ilike.${t})`); }
      if (ors.length) parts.push(`and=(${ors.join(',')})`);
      if (topic) parts.push(`topic=ilike.${encodeURIComponent('*' + clean(topic) + '*')}`);
      if (since) parts.push(`delivery_start=gte.${encodeURIComponent(since)}`);
      if (until) parts.push(`delivery_start=lt.${encodeURIComponent(until)}`);
      // Paged: the answer sums spend and counts ads, so a page cut off at
      // PostgREST's 1,000 rows would be a wrong total presented as a whole one.
      parts.push('order=delivery_start.desc,ad_id.asc');
      const out = [];
      try {
        for (let offset = 0; ; offset += PAGE_SIZE) {
          const batch = await read('opponent_ads', [...parts, `limit=${PAGE_SIZE}`, `offset=${offset}`].join('&'));
          if (!Array.isArray(batch) || !batch.length) break;
          out.push(...batch);
          if (batch.length < PAGE_SIZE || out.length >= 50000) break;
        }
        return out;
      } catch (e) { if (e.pgCode === '42P01' || e.status === 404) return []; throw e; }
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
