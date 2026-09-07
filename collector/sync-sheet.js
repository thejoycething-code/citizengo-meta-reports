#!/usr/bin/env node
'use strict';
// Google Sheet mirror. The Sheet is a MIRROR generated from the store, never a
// second source of truth — it is built from lib/shape.js, the same module the
// dashboard API uses, so the two surfaces cannot disagree.
//
// Three tabs: "Posts" (one row per Facebook post, latest snapshot), "Pages"
// (rollup) and "Instagram" (one row per Instagram post, latest snapshot).
//
// Instagram was collected from the start - caption and permalink included, 723
// of 723 media rows carry a link - but never mirrored here, so the Sheet showed
// Facebook only. Added 3 Sep 2026.
//
// Modes:
//   --out <file>     write the values matrix as JSON (no network, for inspection)
//   --tsv <file>     write a TSV (paste-able, diffable)
//   --csv <file>     write RFC 4180 CSV (Posts tab only; Drive converts it to a Sheet)
//   --push           write to Google Sheets; needs SHEET_ID plus
//                    GOOGLE_SERVICE_ACCOUNT_JSON (preferred, mints its own token)
//                    or GOOGLE_ACCESS_TOKEN (local one-offs only, expires hourly)
//
// Source: Supabase when SUPABASE_URL/SUPABASE_SERVICE_KEY are set, else the
// local NDJSON from the collector.

const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../lib/graph');
const { fileStore, supabaseStore } = require('../lib/store');
const { resolveGoogleToken } = require('../lib/google-auth');
const { shapeFeed, shapePages } = require('../lib/shape');

loadEnv();

const args = process.argv.slice(2);
function opt(name) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true);
}

const POST_HEADERS = [
  'Date', 'Page', 'Post', 'Permalink', 'Type',
  'Views', 'Unique reach', 'Organic views', 'Paid views',
  'From followers', 'Beyond followers', 'Beyond followers %',
  'Reactions', 'Shares', 'Clicks', 'Comments',
  'Engagement', 'Engagement rate %',
  // Video posts only; blank on a photo means "not a video", not "no paid views".
  'Video views organic', 'Video views paid', 'Video watched via',
  'Collected', 'Data status',
];

// Sheets rejects null; empty string is how a genuine gap is represented. It must
// never become 0 — a missing metric would then read as a performance collapse.
const cell = (v) => (v === null || v === undefined ? '' : v);

// Meta returns several of the newer metrics as an object keyed by type. A cell
// holding raw JSON is unreadable and unsortable, so flatten to "key: n" pairs
// ordered by size - biggest contributor first, which is what anyone scanning
// the column is looking for.
function breakdownCell(v) {
  if (!v || typeof v !== 'object') return '';
  const parts = Object.entries(v)
    .filter(([, n2]) => typeof n2 === 'number' && n2 !== 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n2]) => `${k}: ${n2}`);
  return parts.length ? parts.join(', ') : '';
}

function postRow(r) {
  return [
    r.created_time ? r.created_time.slice(0, 10) : '',
    cell(r.page_name),
    // Flattened: newlines inside a cell break TSV and make the Sheet unreadable.
    (r.message || '').replace(/\s+/g, ' ').slice(0, 300),
    cell(r.permalink_url),
    cell(r.media_type || r.status_type),
    cell(r.views_total), cell(r.views_unique), cell(r.views_organic), cell(r.views_paid),
    cell(r.views_from_followers), cell(r.views_from_nonfollowers), cell(r.beyond_followers_pct),
    cell(r.reactions_total), cell(r.shares_total), cell(r.clicks_total), cell(r.comments_total),
    cell(r.engagement_total), cell(r.engagement_rate),
    cell(r.video_views_organic), cell(r.video_views_paid), breakdownCell(r.video_views_by_distribution),
    cell(r.collected_date),
    r.has_metrics ? (r.partial ? 'partial' : 'ok') : 'no metrics',
  ];
}

// Instagram. Deliberately NOT the same columns as Posts: there is no paid
// split, no follower breakdown and no shares-to-reach story on Instagram, but
// there is "saved", which Facebook has no equivalent for and which signals far
// more intent than a like.
const IG_HEADERS = [
  'Date', 'Account', 'Page', 'Caption', 'Permalink', 'Type',
  'Reach', 'Views', 'Saves', 'Saves per 1k reached',
  'Likes', 'Comments', 'Shares', 'Interactions', 'Interaction rate %',
  // FEED posts only. Blank on Reels and Stories because Meta does not offer
  // these there - blank is "not measurable", not zero.
  'Follows', 'Profile visits', 'Profile actions',
  // Reels only, and mutually exclusive with the three above: Meta serves
  // follows for FEED and watch time for REELS, never both for one post.
  'Avg watch (s)', 'Total watch (s)',
  'Collected',
];

function igRow(r) {
  return [
    r.timestamp ? String(r.timestamp).slice(0, 10) : '',
    r.ig_username ? '@' + r.ig_username : '',
    cell(r.page_name),
    // Flattened and capped exactly as the Posts tab treats message: newlines
    // inside a cell break TSV and make the Sheet unreadable.
    (r.caption || '').replace(/\s+/g, ' ').slice(0, 300),
    cell(r.permalink),
    cell(r.media_product_type || r.media_type),
    cell(r.reach), cell(r.views), cell(r.saved), cell(r.saves_per_1k_reached),
    cell(r.likes), cell(r.comments), cell(r.shares),
    cell(r.total_interactions), cell(r.interaction_rate_pct),
    cell(r.follows), cell(r.profile_visits), cell(r.profile_activity),
    cell(r.reels_avg_watch_seconds),
    // Milliseconds in the database; seconds is the only unit anyone quotes.
    r.reels_total_watch_time_ms === null || r.reels_total_watch_time_ms === undefined
      ? '' : Math.round(r.reels_total_watch_time_ms / 1000),
    cell(r.collected_date),
  ];
}

const PAGE_HEADERS = [
  'Page', 'Followers', 'Posts', 'With metrics', 'Missing metrics',
  'Total views', 'Unique reach', 'Paid views', 'Engagement',
  'Median engagement rate %', 'Median beyond followers %',
];

function pageRow(p) {
  return [
    p.name, cell(p.followers_count), p.posts, p.posts_with_metrics, p.posts_missing_metrics,
    cell(p.views_total), cell(p.views_unique), cell(p.views_paid), cell(p.engagement_total),
    cell(p.median_engagement_rate), cell(p.median_beyond_followers_pct),
  ];
}

// Per page PER DAY. The Pages tab is one aggregated row per page, so the daily
// series - and with it follows against unfollows - had nowhere to land. Kept as
// its own tab rather than widening Pages, because the two answer different
// questions and have different row counts.
const GROWTH_HEADERS = [
  'Date', 'Page', 'Followers', 'Follows', 'Unfollows', 'Net follows',
  'Page views', 'Reach', 'Engagements', 'Video views', 'Video watch (s)',
  'Reactions by type',
];

function growthRow(r) {
  return [
    r.metric_date ? String(r.metric_date).slice(0, 10) : '',
    cell(r.page_name),
    cell(r.followers_snapshot),
    cell(r.daily_follows), cell(r.daily_unfollows), cell(r.net_follows),
    cell(r.views_total), cell(r.media_view_unique), cell(r.post_engagements),
    cell(r.video_views),
    r.video_view_time_ms === null || r.video_view_time_ms === undefined
      ? '' : Math.round(r.video_view_time_ms / 1000),
    breakdownCell(r.post_reactions_by_type),
  ];
}

async function pushToSheets({ sheetId, token, tabs }) {
  for (const [tab, values] of Object.entries(tabs)) {
    // Clear first: a shrinking dataset would otherwise leave stale rows behind
    // the new ones, which is how a mirror silently starts lying.
    const clear = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tab)}:clear`,
      { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
    if (!clear.ok) throw new Error(`clear ${tab} failed: HTTP ${clear.status} ${await clear.text()}`);

    const range = `${tab}!A1`;
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values }),
      });
    if (!res.ok) throw new Error(`write ${tab} failed: HTTP ${res.status} ${await res.text()}`);
    console.log(`  pushed ${values.length - 1} rows to "${tab}"`);
  }
}

async function main() {
  const useSupabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY;
  const store = useSupabase
    ? supabaseStore({ url: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_KEY })
    : fileStore({ dir: path.join(__dirname, '..', 'data') });

  const data = await store.loadAll();
  const feed = shapeFeed(data, { sort: 'recent' });
  const pages = shapePages(data);
  // Never let Instagram break the Facebook mirror it rides along with - the
  // same rule the collector applies. A missing tab is better than no Sheet.
  let ig = [];
  try {
    ig = typeof store.igFeed === 'function' ? await store.igFeed() : [];
  } catch (e) {
    console.log(`  instagram skipped — ${e.message.slice(0, 80)}`);
  }
  let growth = [];
  try {
    // 2000 is the reader's own ceiling: 36 pages x 90 days is 3,240 rows, so ask
    // per page rather than letting one capped read silently drop the tail.
    for (const pg of pages) {
      const rows = typeof store.pageGrowth === 'function'
        ? await store.pageGrowth({ page_id: pg.page_id, limit: 2000 }) : [];
      growth.push(...(rows || []));
    }
  } catch (e) {
    console.log(`  page growth skipped — ${e.message.slice(0, 120)}`);
    growth = [];
  }
  growth.sort((a, b) => (a.metric_date < b.metric_date ? 1 : a.metric_date > b.metric_date ? -1 : 0));

  console.log(`source=${store.name} · ${feed.total} posts · ${pages.length} pages · ${ig.length} instagram posts · ${growth.length} page-days`);

  const tabs = {
    Posts: [POST_HEADERS, ...feed.rows.map(postRow)],
    Pages: [PAGE_HEADERS, ...pages.map(pageRow)],
  };
  // Omitted entirely when there is nothing, rather than pushing a header-only
  // tab that reads as "Instagram collection is broken".
  if (ig.length) tabs.Instagram = [IG_HEADERS, ...ig.map(igRow)];
  if (growth.length) tabs.Growth = [GROWTH_HEADERS, ...growth.map(growthRow)];

  const outFile = opt('out');
  if (outFile && outFile !== true) {
    fs.writeFileSync(outFile, JSON.stringify(tabs, null, 2) + '\n');
    console.log(`wrote matrix to ${outFile}`);
  }
  const tsvFile = opt('tsv');
  if (tsvFile && tsvFile !== true) {
    const tsv = Object.entries(tabs)
      .map(([t, v]) => `# ${t}\n` + v.map((r) => r.join('\t')).join('\n')).join('\n\n');
    fs.writeFileSync(tsvFile, tsv + '\n');
    console.log(`wrote TSV to ${tsvFile}`);
  }

  // RFC 4180 quoting. Post text contains commas, quotes and emoji, so naive
  // joining corrupts the file silently — the worst kind of corruption, because
  // it still opens.
  const csvFile = opt('csv');
  if (csvFile && csvFile !== true) {
    const q = (v) => {
      const str = String(v === null || v === undefined ? '' : v);
      return /[",\n\r]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
    };
    // One tab only — CSV cannot express multiple sheets. Use --push for both.
    const csv = tabs.Posts.map((row) => row.map(q).join(',')).join('\r\n');
    fs.writeFileSync(csvFile, csv + '\r\n');
    console.log(`wrote CSV to ${csvFile} (${tabs.Posts.length - 1} rows, Posts tab only)`);
  }

  if (args.includes('--push')) {
    const sheetId = process.env.SHEET_ID;
    // Google access tokens expire in ~1h, so a nightly job cannot hold one as a
    // secret — it mints a fresh one from the service account key each run.
    const token = await resolveGoogleToken();
    if (!sheetId || !token) {
      console.error('--push needs SHEET_ID plus either GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_ACCESS_TOKEN');
      console.error('The service account must be shared on the target Sheet as an Editor.');
      process.exit(2);
    }
    console.log(`pushing to sheet ${sheetId} ...`);
    await pushToSheets({ sheetId, token, tabs });
  }

  if (!outFile && !tsvFile && !csvFile && !args.includes('--push')) {
    console.log('\nNothing written. Pass --out <file>, --tsv <file>, or --push.');
    console.log(`Posts tab: ${tabs.Posts.length - 1} rows x ${POST_HEADERS.length} cols`);
    console.log(`Pages tab: ${tabs.Pages.length - 1} rows x ${PAGE_HEADERS.length} cols`);
    if (tabs.Instagram) console.log(`Instagram tab: ${tabs.Instagram.length - 1} rows x ${IG_HEADERS.length} cols`);
  }
}

main().catch((e) => { console.error('sync-sheet failed:', e.message); process.exit(1); });
