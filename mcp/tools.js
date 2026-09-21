'use strict';
// Tool implementations. Every one of these goes through lib/shape.js, which is
// the whole point of exposing tools instead of a SQL connection:
//
//   * meta_post_metrics is APPEND-ONLY — one row per post per collection day.
//     A raw `SUM(views_total)` multiplies every post by the number of days it
//     has been collected. shapeFeed() reduces to the latest snapshot per post
//     before anything is added up.
//   * NULL means "Meta refused this metric", not zero. Averaging over it, or
//     coalescing it to 0, silently understates performance.
//   * Page cards use medians, because one 2M-view post otherwise defines the
//     average for a whole page.
//
// An LLM given raw tables gets all three wrong, confidently. These tools cannot.

const { shapeFeed, shapePages, pageBaseline, withBenchmark , median } = require('../lib/shape');

const METRIC_LABELS = {
  views: 'Views', reach: 'Unique reach', beyond: 'Reach beyond followers',
  engagement: 'Engagement', rate: 'Engagement rate', shares: 'Shares', recent: 'Most recent',
};

function sinceFor(days) {
  if (!days || days <= 0) return undefined;
  return new Date(Date.now() - days * 86400000).toISOString();
}

// meta_page_metrics.metric_date names the day the value DESCRIBES, as of the
// re-date on 9 Sept 2026, so a calendar window is read literally. It used to be
// Meta's end_time date - a day later - and this reader compensated by asking
// one day out; both the stored rows and the collector were fixed instead, so
// that compensation is gone. Verified after the migration: a literal July
// filter returns 1,700,950 and August 787,058, matching page_media_view.
const shiftDay = (iso, days) =>
  new Date(Date.parse(String(iso).slice(0, 10)) + days * 86400000).toISOString().slice(0, 10);

// A calendar window from explicit dates, else the trailing `days`.
function windowFor({ since, until, days }) {
  if (since) {
    const from = String(since).slice(0, 10);
    const to = until ? String(until).slice(0, 10) : new Date().toISOString().slice(0, 10);
    return { from, to, label: `${prettyDay(from)} – ${prettyDay(to)}`, explicit: true };
  }
  const to = new Date().toISOString().slice(0, 10);
  const from = shiftDay(to, -(days || 30));
  return { from, to, label: `last ${days || 30} days`, explicit: false };
}

const PRETTY_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function prettyDay(iso) {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${PRETTY_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const n = (v) => (v === null || v === undefined ? '—' : v.toLocaleString('en-GB'));
const p = (v) => (v === null || v === undefined ? '—' : v.toFixed(1) + '%');

function table(headers, rows) {
  if (!rows.length) return '_No rows._';
  const head = `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |`;
  return head + '\n' + rows.map((r) => `| ${r.join(' | ')} |`).join('\n');
}

// Markdown link when we have a permalink, plain text otherwise. Keeps the table
// readable while making every row clickable.
function postLink(r, label) {
  const safe = String(label).replace(/\|/g, '\\|').replace(/\]/g, ')');
  return r.permalink_url ? `[${safe}](${r.permalink_url})` : safe;
}

// Slicing a JS string cuts UTF-16 CODE UNITS, so a cut can land in the middle
// of an emoji's surrogate pair and leave half of one behind. That is not merely
// ugly - a lone surrogate is not valid JSON, and it broke an MCP client outright
// with "lone leading surrogate in hex escape" on a caption containing 🇨🇴.
// Every slice in this file goes through here.
const stripLoneSurrogates = (s) => String(s)
  .replace(/^[\uDC00-\uDFFF]+/, '')      // low surrogate orphaned at the start
  .replace(/[\uD800-\uDBFF]+$/, '');     // high surrogate orphaned at the end

function truncate(s, len) {
  const one = (s || '(no text)').replace(/\s+/g, ' ');
  return one.length > len ? stripLoneSurrogates(one.slice(0, len - 1)) + '…' : one;
}

// A pipe closes a table cell, so any text going into one has to be escaped.
const mdCell = (s) => String(s).replace(/\|/g, '\\|');

// Search results showed the FIRST n characters of the post, which for a
// 500-character Instagram caption usually does not contain the word that was
// searched for - the reader gets a list of openings and no evidence of why any
// of them matched. Show a window around the match instead, and fall back to the
// opening only when there is no match to centre on (a Facebook row can match on
// a field this snippet never sees).
function snippet(text, query, width = 150) {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  if (!one) return '(no text)';
  const q = String(query || '');
  const at = q ? one.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at < 0 || one.length <= width) return truncate(one, width);
  const pad = Math.max(0, Math.floor((width - q.length) / 2));
  const start = Math.max(0, at - pad);
  const end = Math.min(one.length, start + width);
  return (start > 0 ? '…' : '') + stripLoneSurrogates(one.slice(start, end)) + (end < one.length ? '…' : '');
}

// This tool is a LEAGUE TABLE, and a league table cannot reach a post that does
// not place. On a page posting several a day, a mid-table post sits beyond the
// hundred-row ceiling on every sort there is - the HazteOir Colombia earthquake
// post ranked 420th by views, 428th by reach, 410th by reactions and 480th by
// shares out of 681, so no combination of sort and limit would surface it and
// its reactions were simply unobtainable by this route.
//
// Saying which posts are missing is not possible; saying HOW MANY, and naming
// the tool that does not rank, is. search_posts filters by text, so a post's
// position on its own page is irrelevant there.
function rankNote(feed, limit, sort) {
  const shown = feed.rows.length;
  const total = feed.total ?? null;   // post-filter, pre-limit count from shapeFeed
  if (!total || total <= shown) return '';
  return `\n\n_Showing ${shown} of ${n(total)} posts in this window, ranked by ${METRIC_LABELS[sort] || sort}. `
    + `**The other ${n(total - shown)} cannot be reached by changing the sort** — a mid-table post places nowhere on any of them. `
    + `To get engagement for a specific post regardless of where it ranks, use search_posts with a word from the post._`;
}

// Appended wherever numbers are shown, so the model reports gaps rather than
// quietly presenting partial data as complete.
function gapNote(rows) {
  const missing = rows.filter((r) => !r.has_metrics).length;
  if (!missing) return '';
  return `\n\n_${missing} of ${rows.length} posts have no metrics: Meta returned a permissions error for them. `
    + `They are shown as "—" and excluded from totals. This is a data gap, not zero performance._`;
}

async function listPages(store) {
  const data = await store.loadAll();
  const pages = shapePages(data);
  const rows = pages.map((g) => [
    g.name, g.page_id, n(g.followers_count), n(g.posts),
    g.posts_missing_metrics ? `${g.posts_missing_metrics} missing` : 'complete',
    n(g.views_total), p(g.median_engagement_rate), p(g.median_beyond_followers_pct),
  ]);
  return {
    text: `**Pages currently collected** (${pages.length})\n\n`
      + table(['Page', 'ID', 'Followers', 'Posts', 'Data', 'Total views', 'Median eng. rate', 'Median beyond followers'], rows)
      + `\n\n_Coverage note: only pages whose Business Portfolio has granted read access appear here. `
      + `Pages missing from this list are an access gap, not inactive pages._`,
    data: pages,
  };
}

async function topPosts(store, { page_id, days: d = 30, sort = 'views', limit: l = 10 }) {
  const days = clampDays(d, 30); const limit = clampRows(l, 10, 100);
  const data = await store.loadAll();
  if (page_id && !data.pages.some((g) => g.page_id === page_id)) {
    return {
      text: `Page ${page_id} is not being collected, so there is no data for it — this is not the same as the page having no posts. Call list_pages to see which pages are available.`,
      data: null,
    };
  }
  // Shaped WITHOUT limit, then sliced, because the baseline has to come from
  // the whole window rather than from the rows on screen. Passing `limit` here
  // made pageBaseline() take the median of the posts being displayed - the
  // biggest ones - so HazteOir's 90-day median read 1,090,875 views at
  // limit=5 when the real figure is 25,757. Every "vs median" multiple on the
  // page was measured against a bar roughly forty times too high, which is
  // the opposite of what this column exists to do.
  const windowFeed = shapeFeed(data, {
    page_id, since: sinceFor(days), sort, with_metrics_only: false,
  });
  const feed = { total: windowFeed.total, rows: windowFeed.rows.slice(0, limit) };
  // Baseline from the whole window, so "vs median" compares like with like.
  const base = pageBaseline(windowFeed.rows);
  // Shown only when the result actually contains a video with the data. Most
  // pages post mainly photos and links, and a column of dashes across ten rows
  // is worse than no column.
  const anyVideo = feed.rows.some((r) =>
    r.video_views_organic !== null || r.video_views_paid !== null);
  const rows = feed.rows.map((r) => withBenchmark(r, base)).map((r) => {
    const row = [
      r.created_time.slice(0, 10), r.page_name, postLink(r, truncate(r.message, 62)),
      n(r.views_total), n(r.views_unique), p(r.beyond_followers_pct),
      n(r.reactions_total), n(r.shares_total), p(r.engagement_rate),
      r.benchmark && r.benchmark.views_x_median !== null ? r.benchmark.views_x_median + '×' : '—',
    ];
    if (anyVideo) {
      row.push(r.video_views_organic === null && r.video_views_paid === null
        ? '—' : `${n(r.video_views_organic)}/${n(r.video_views_paid)}`);
    }
    return row;
  });
  const label = METRIC_LABELS[sort] || sort;
  return {
    text: `**Top ${feed.rows.length} posts by ${label}**`
      + `${page_id ? '' : ' (all pages)'}${days ? ` · last ${days} days` : ' · all time'}\n\n`
      + table(['Date', 'Page', 'Post', 'Views', 'Unique', 'Beyond followers', 'Reactions', 'Shares', 'Eng. rate', 'vs median',
        ...(anyVideo ? ['Video org/paid'] : []), 'Post ID'],
        rows.map((row, i) => row.concat([feed.rows[i].post_id])))
      + (base.reliable
        ? `\n\n_"vs median" compares each post to this page's own median of ${n(base.median_views)} views over the same window. A raw view count says nothing on its own._`
        : `\n\n_Too few posts with metrics (${base.n}) to establish a baseline, so no comparison is shown._`)
      + rankNote(feed, limit, sort)
      + gapNote(feed.rows),
    data: { ...feed, baseline: base },
  };
}

async function pageSummary(store, { page_id, days: d = 30, since, until }) {
  const days = clampDays(d, 30);
  const win = windowFor({ since, until, days });
  const data = await store.loadAll();
  const all = shapePages(data);
  const page = all.find((g) => g.page_id === page_id);
  if (!page) {
    return { text: `No page with id ${page_id} is being collected. Use list_pages to see what is available.`, data: null };
  }

  // PAGE level first, deliberately. "How did the page do in July" means the
  // number Business Suite shows, and that is this one - page_media_view. The
  // post-level sum below is a different quantity and answering with it alone
  // reads as though the pipeline disagrees with Meta.
  let pageRows = [];
  if (typeof store.pageGrowth === 'function') {
    try {
      pageRows = (await store.pageGrowth({
        page_id, since: win.from, until: win.to, limit: 400,
      })) || [];
    } catch (e) { pageRows = []; }
  }
  const pageSum = (k) => (pageRows.length
    ? pageRows.reduce((a, r) => a + (Number(r[k]) || 0), 0) : null);
  const pageViews = pageSum('media_view');
  const pageEng = pageSum('post_engagements');

  // POST level, for posts PUBLISHED in the window.
  const feed = shapeFeed(data, { page_id, since: `${win.from}T00:00:00.000Z`, sort: 'views' });
  const inWindow = feed.rows.filter((r) => String(r.created_time).slice(0, 10) <= win.to);
  const scored = inWindow.filter((r) => r.has_metrics);
  const best = scored[0];
  const widest = [...scored].sort((a, b) => (b.beyond_followers_pct ?? -1) - (a.beyond_followers_pct ?? -1))[0];
  const postViews = scored.reduce((a, r) => a + (r.views_total || 0), 0);
  const postInteractions = scored.reduce((a, r) => a
    + (r.reactions_total || 0) + (r.shares_total || 0) + (r.comments_total || 0), 0);

  const lines = [`**${page.name}** · ${n(page.followers_count)} followers · ${win.label}`, ''];

  if (pageViews !== null) {
    lines.push(`- **Views: ${n(pageViews)}** — the Business Suite figure. Page level: every surface, ads included, counted when the view happened.`);
    if (pageEng !== null) {
      lines.push(`- Post engagements: ${n(pageEng)} — Meta's page metric, which counts clicks too, so it runs higher than Business Suite's "Interactions".`);
    }
  } else {
    lines.push('- Page-level views: not held for this window, so the Business Suite figure cannot be shown here.');
  }

  lines.push('');
  lines.push(`**${inWindow.length} post${inWindow.length === 1 ? '' : 's'} published in this window**${scored.length !== inWindow.length ? ` (${scored.length} with metrics)` : ''}`);
  // Median over THIS window's posts, not the page's all-time median. Using the
  // rollup put a real-looking rate next to a window containing no posts at all.
  const medRate = scored.length
    ? median(scored.map((r) => r.engagement_rate).filter((v) => v !== null && v !== undefined))
    : null;
  if (scored.length) {
    lines.push(`- Post views: ${n(postViews)} · reactions + shares + comments: ${n(postInteractions)}`
      + `${medRate === null ? '' : ` · median engagement rate ${p(medRate)}`}`);
  } else {
    lines.push('- No posts with metrics in this window, so there are no post-level figures.');
  }
  if (best) lines.push(`- Best by views: ${postLink(best, '"' + truncate(best.message, 70) + '"')} — ${n(best.views_total)} views. \`${best.post_id}\``);
  if (widest) lines.push(`- Furthest beyond followers: ${postLink(widest, '"' + truncate(widest.message, 70) + '"')} — ${p(widest.beyond_followers_pct)} from non-followers.`);

  if (pageViews !== null) {
    lines.push('');
    lines.push('_The two view figures are different quantities and will not tie: post views are lifetime totals for posts published in the window, so a July post keeps adding views in August._');
  }

  return {
    text: lines.join('\n') + gapNote(inWindow),
    data: {
      page,
      window: { from: win.from, to: win.to },
      page_level: { views: pageViews, post_engagements: pageEng, days: pageRows.length },
      post_level: { posts: inWindow.length, with_metrics: scored.length, views: postViews, interactions: postInteractions },
    },
  };
}

async function comparePages(store, { days: d = 30 }) {
  const days = clampDays(d, 30);
  const data = await store.loadAll();
  const pages = shapePages(data);
  let anyIncomplete = false;
  // Ordered by views. The rows arrived in whatever order the store returned them,
  // which for a COMPARISON table is a trap: the first row reads as the best one,
  // and it was arbitrary — 20.5m views sat above 4.8m sat above 3.0m.
  const rows = pages.map((g) => {
    const feed = shapeFeed(data, { page_id: g.page_id, since: sinceFor(days) });
    const scored = feed.rows.filter((r) => r.has_metrics);
    const missing = feed.rows.length - scored.length;
    if (missing) anyIncomplete = true;
    // null, not 0, when nothing is measurable — a page with no usable posts has
    // NO figure, and printing 0 would rank it as the worst performer.
    const views = scored.length ? scored.reduce((a, r) => a + (r.views_total || 0), 0) : null;
    const eng = scored.length ? scored.reduce((a, r) => a + (r.engagement_total || 0), 0) : null;
    return [
      g.name, n(g.followers_count),
      missing ? `${feed.rows.length} (${missing} no data)` : n(feed.rows.length),
      n(views), n(eng),
      views ? p((eng / views) * 100) : '—',
      // Views per follower: the fair cross-page comparison, since a 28-follower
      // page and a 117k-follower page are not comparable on raw totals.
      (views && g.followers_count) ? (views / g.followers_count).toFixed(1) + '×' : '—',

      // Index 7: the unformatted figure the sort uses. Trimmed off before display.

      views,
    ];
  });
  // Sort on the raw number, not the formatted string — "9,157" sorts above

  // "20,501,220" lexically. Pages with nothing measurable go last rather than

  // being ranked as the worst.

  const sortedRows = [...rows].sort((x, y) => (y[7] || -1) - (x[7] || -1))

    .map((r) => r.slice(0, 7));


  return {
    text: `**Page comparison · last ${days} days**\n\n`
      + table(['Page', 'Followers', 'Posts', 'Views', 'Engagement', 'Eng. rate', 'Views per follower'], sortedRows)
      + `\n\n_"Views per follower" is the fairer cross-page comparison — raw totals just rank pages by audience size._`
      + (anyIncomplete
        ? `\n\n_**Compare with care:** pages marked "no data" have posts Meta refused to report on, so their totals are understated by an unknown amount. Do not rank pages against each other without saying so._`
        : ''),
    data: pages,
  };
}

// Instagram was invisible in data_health, so the only way to know whether it had
// metrics was to query the database by hand - and doing that against the latest
// collected_date, which may be a small targeted run rather than the last full
// one, reports zero coverage for accounts that are fully collected.
async function igLine(store) {
  if (typeof store.igCoverage !== 'function') return null;
  let c;
  try { c = await store.igCoverage(); } catch (e) { return null; }
  if (!c || !c.hasMedia) return '- Instagram: **not collected**';
  if (!c.total) return '- Instagram: posts collected, **no metrics yet** (needs instagram_manage_insights)';
  return `- Instagram: **${c.withReach} of ${c.total}** posts have reach, as of ${c.latest}`;
}

// How much engagement a post earned AFTER it left the page.
//
// Meta publishes two reaction counts: one for the post, one that also counts
// reactions on reshares of it. The gap is engagement on somebody else's copy -
// which is a different question from "beyond followers". Reach can travel
// because Meta distributed the post widely with nobody sharing it; this only
// moves when people actually pass it on and others engage with the copy.
async function shareAmplification(store, { page_id, days: d = 90, limit: l = 15 }) {
  const days = clampDays(d, 90);
  const limit = clampRows(l, 15, 50);

  if (typeof store.amplification !== 'function') {
    return { text: 'Share amplification is not available on this data source.', data: null };
  }
  const rows = await store.amplification({ page_id, since: sinceFor(days), limit });

  if (!rows || !rows.length) {
    return {
      text: 'No posts can be scored for amplification yet.\n\n'
        + '_This needs both of Meta\'s reaction counts on the same post, and only collections '
        + 'from 30 August 2026 carry both. It also skips posts under 25 reactions, where the '
        + 'ratio would be noise rather than a signal._',
      data: null,
    };
  }

  const onReshares = rows.reduce((a2, r) => a2 + (Number(r.reactions_on_reshares) || 0), 0);
  const med = median(rows.map((r) => Number(r.amplification)).filter((v) => Number.isFinite(v)));

  return {
    text: `**Which posts kept working after they were shared** · last ${days} days\n\n`
      + `Across these ${rows.length} posts, **${n(onReshares)} reactions** happened on somebody `
      + `else's copy rather than on the original. Typical post: **${med}×**.\n\n`
      + table(
        ['Date', 'Page', 'Post', 'On the post', 'On reshares', 'Total', 'Shares', 'Amplification'],
        rows.map((r) => [
          (r.created_time || '').slice(0, 10),
          r.page_name || '—',
          r.permalink_url
            ? `[${truncate(r.message, 40).replace(/\|/g, '\\|')}](${r.permalink_url})`
            : truncate(r.message, 40),
          n(r.reactions_on_post),
          n(r.reactions_on_reshares),
          n(r.reactions_incl_reshares),
          n(r.shares_total),
          `${Number(r.amplification).toFixed(2)}×`,
        ]),
      )
      + '\n\n_**1.00× means nobody engaged with a reshare** — the post may still have reached '
      + 'a lot of people, but it did so because Meta distributed it, not because supporters '
      + 'carried it. Above 1.30× the post earned a meaningful second life on other people\'s '
      + 'timelines, which is the clearest sign it was worth sharing rather than merely worth seeing._'
      + '\n\n_Different from "beyond followers", which measures where the reach landed. This '
      + 'measures whether the post kept working once it got there._'
      + '\n\n_Posts under 25 reactions are excluded: ten becoming twelve is not amplification._',
    data: rows,
  };
}

// Ad spend rides on ads_read, a permission nothing else here needs, so it can
// go silent while collection stays green. Report its age rather than its
// presence: a stale table that still answers queries is the failure mode.
async function adSpendLine(store) {
  if (typeof store.adSpendCoverage !== 'function') return null;
  let c;
  try { c = await store.adSpendCoverage(); } catch (e) { return null; }
  if (!c || !c.latest) return '- Ad spend: **none collected** (needs `ads_read` on the token)';
  const days = Math.floor((Date.now() - Date.parse(c.latest)) / 86400000);
  if (days <= 3) return `- Ad spend: current to ${c.latest}`;
  return `- Ad spend: **stale — newest row is ${c.latest}, ${days} days old**. `
    + 'Collection is still running and still green; ad spend alone is failing, which happens when the token loses `ads_read`. Treat any paid figure older than this date as incomplete.';
}

async function dataHealth(store) {
  const igStatus = (await igLine(store)) || '- Instagram: status unavailable';
  const adStatus = await adSpendLine(store);
  const data = await store.loadAll();
  const feed = shapeFeed(data, {});
  const pages = shapePages(data);
  const missing = feed.rows.filter((r) => !r.has_metrics);
  const partial = feed.rows.filter((r) => r.has_metrics && r.partial);
  const noComments = feed.rows.filter((r) => r.comments_total === null).length;
  const dates = feed.rows.map((r) => r.created_time.slice(0, 10)).sort();

  return {
    text: [
      '**Data health**',
      '',
      `- Pages collected: **${pages.length}**`,
      `- Posts: **${feed.total}**, covering ${dates[0] || '—'} to ${dates[dates.length - 1] || '—'}`,
      `- Posts with no metrics at all: **${missing.length}** (Meta permissions error)`,
      `- Posts missing only unique reach: **${partial.length}** (Meta suppresses it on low-follower pages)`,
      adStatus,
      noComments
        ? `- Posts with no comment count: **${noComments}** (needs the pages_read_user_content scope)`
        : '- Comment counts: **complete** on every post',
      igStatus,
      '',
      'Known limitations to state when reporting:',
      '- **Reactions** are Meta\'s `reactions` count on the post itself — the number Facebook shows you on the post. Meta also publishes `post_reactions_by_type_total`, a lifetime insights figure that additionally counts reactions on reshares; measured across 406 posts it runs about 22% higher on posts that were shared and matches exactly on posts that were not. This tool reports the first, so figures line up with what you see. A small difference is timing — these are a nightly snapshot and people keep reacting.',
      '- Paid vs organic split comes from a breakdown, not a dedicated metric; all `post_impressions*` metrics were retired by Meta in 2026.',
      '- Only pages whose Business Portfolio granted read access are present. Absent pages are an access gap.',
      '- Metrics are a daily snapshot; engagement on recent posts is still accruing and will rise.',
    ].join('\n'),
    data: { pages: pages.length, posts: feed.total, missing: missing.length, partial: partial.length },
  };
}

// Enough to see the pattern, few enough to read. Before this cap the tool
// returned every post more than 1.5x or under 0.5x the median - which on a
// 90-day window across 36 pages was 2,225 lines and 439,000 characters, most of
// it posts that were unremarkable in the ordinary way.
// Caller-supplied bounds, clamped rather than trusted.
//
// These were defaults, not maximums. The 25-row cap on outliers existed because
// that tool once returned 439,241 characters, but {"limit": 100000} restored the
// original behaviour, and every tool advertises both parameters in its input
// schema - so a client did not even have to guess.
const clampRows = (v, dflt, max = 200) =>
  Math.min(Math.max(Math.floor(Number(v)) || dflt, 1), max);
const clampDays = (v, dflt) =>
  Math.min(Math.max(Math.floor(Number(v)) || dflt, 1), 400);

const OUTLIER_ROWS = 25;

async function outliers(store, { page_id, days: d = 90, limit: l = OUTLIER_ROWS }) {
  const days = clampDays(d, 90); const limit = clampRows(l, OUTLIER_ROWS, 100);
  const data = await store.loadAll();
  const feed = shapeFeed(data, { page_id, since: sinceFor(days), sort: 'views' });
  const base = pageBaseline(feed.rows);
  if (!base.reliable) {
    return {
      text: `Only ${base.n} post(s) with metrics in the last ${days} days — not enough to say what "normal" looks like for this page, so nothing can be called an outlier yet. Collect more history first.`,
      data: null,
    };
  }
  const scored = feed.rows.filter((r) => r.has_metrics).map((r) => withBenchmark(r, base));
  // Most extreme first, so a cap keeps the interesting end rather than whichever
  // posts happened to sort first.
  const over = scored.filter((r) => r.benchmark.views_x_median >= 1.5)
    .sort((a, b) => b.benchmark.views_x_median - a.benchmark.views_x_median);
  const under = scored.filter((r) => r.benchmark.views_x_median < 0.5)
    .sort((a, b) => a.benchmark.views_x_median - b.benchmark.views_x_median);

  // Say what was left out. A silent cap reads as "this is all of them", which is
  // how a partial answer gets quoted as a complete one.
  const shown = (rows) => rows.slice(0, limit);
  const omitted = (rows) => (rows.length > limit
    ? `\n\n_Showing the ${limit} most extreme of ${n(rows.length)}. Ask for a single page, a shorter window, or a higher limit to see more._`
    : '');

  const fmt = (r) => [
    r.created_time.slice(0, 10),
    r.benchmark.views_x_median + '×',
    n(r.views_total),
    n(r.shares_total),
    r.benchmark.shares_x_median !== null ? r.benchmark.shares_x_median + '×' : '—',
    p(r.engagement_rate),
    postLink(r, truncate(r.message, 52)),
    r.post_id,
  ];
  const head = ['Date', 'vs median', 'Views', 'Shares', 'Shares vs med', 'Eng. rate', 'Post', 'Post ID'];

  return {
    text: [
      `**What normal looks like** · last ${days} days · ${base.n} posts with metrics`,
      '',
      `- Median views: **${n(base.median_views)}** · 90th percentile: **${n(base.p90_views)}**`,
      `- Median engagement rate: **${p(base.median_eng_rate)}**`,
      `- Median reach beyond followers: **${p(base.median_beyond_pct)}**`,
      `- Median shares: **${n(base.median_shares)}**`,
      '',
      `**Broke away from normal** (${over.length})`,
      '',
      over.length ? table(head, shown(over).map(fmt)) + omitted(over) : '_None._',
      '',
      `**Well below normal** (${under.length})`,
      '',
      under.length ? table(head, shown(under).map(fmt)) + omitted(under) : '_None._',
      '',
      '_Shares are usually what separates the two: a post reaches beyond its followers when supporters carry it, not when the page posts it._',
    ].join('\n') + gapNote(feed.rows),
    data: { baseline: base, over: over.length, under: under.length },
  };
}

// Text search across post copy. Uses the store's server-side filter rather than
// loading every post, because at 36 pages over 90 days that is thousands of rows
// per call.
//
// Results are ranked by REACH, not relevance. A campaigner asking "how did our
// marriage posts do" wants the ones that travelled, not the ones that mention the
// word most often — and Meta gives us no relevance signal anyway.
async function searchPosts(store, { query, page_id, days: d = 0, limit: l = 15 }) {
  const days = Math.min(Math.max(Math.floor(Number(d)) || 0, 0), 400); const limit = clampRows(l, 15, 100);
  if (!query || !String(query).trim()) {
    return { text: 'Give a search term — a word or phrase that appears in the post text.', data: null };
  }
  const since = sinceFor(days);
  // Both platforms, always. Searching only Facebook and captioning the result
  // "posts matching x" reported half the library as the whole of it.
  const [rows, igRows] = await Promise.all([
    store.searchPosts({ q: query, page_id, since, limit }),
    store.searchIgMedia({ q: query, page_id, since, limit }),
  ]);

  if (!rows.length && !igRows.length) {
    return {
      text: `No posts matching "${query}"${page_id ? ' on that page' : ''}${days ? ` in the last ${days} days` : ''}.\n\n`
        + '_Searched Facebook post copy and Instagram captions. Only collected pages are searchable, and only the period that has been collected. '
        + 'A blank result may mean the post exists but has not been collected, rather than that it was never written._',
      data: null,
    };
  }

  // Reactions and a total were missing, so a general question came back with
  // reach and no engagement, and reactions had to be chased page by page
  // through top_posts - which cannot reach a post ranked below its page's
  // first hundred at all.
  const fbTable = table(
    ['Date', 'Page', 'Post', 'Reach', 'Views', 'Beyond followers',
      'Reactions', 'Comments', 'Shares', 'Clicks', 'Engagement', 'Eng. rate', 'Post ID'],
    rows.map((r) => [
      (r.created_time || '').slice(0, 10),
      r.page_name || '—',
      postLink(r, snippet(r.message, query, 90)),
      n(r.views_unique),
      n(r.views_total),
      r.views_total > 0 ? p((r.views_from_nonfollowers / r.views_total) * 100) : '—',
      n(r.reactions_total), n(r.comments_total), n(r.shares_total), n(r.clicks_total),
      n(r.engagement_total),
      r.engagement_rate_pct !== null && r.engagement_rate_pct !== undefined
        ? p(Number(r.engagement_rate_pct)) : '—',
      r.post_id,
    ])
  );

  // Which field matched matters: "we said it in the video" and "we wrote it in
  // the caption" are different editorial facts, and a row that does not say
  // which invites the reader to assume the caption.
  const hits = (hay, q) => String(hay || '').toLowerCase().includes(String(q).toLowerCase());
  const igTable = table(
    ['Date', 'Account', 'Matched', 'Text', 'Type', 'Reach', 'Views', 'Saves', 'Interactions', 'Rate'],
    igRows.map((r) => {
      const inCaption = hits(r.caption, query);
      const inSpoken = hits(r.transcript, query);
      const where = inCaption && inSpoken ? 'both' : inSpoken ? 'spoken' : 'caption';
      // Show the field that actually matched, so the snippet is evidence.
      const source = inCaption ? r.caption : (inSpoken ? r.transcript : r.caption);
      const text_ = mdCell(snippet(source, query, 100)).replace(/\]/g, ')');
      return [
        (r.timestamp || '').slice(0, 10),
        r.ig_username ? '@' + r.ig_username : (r.page_name || '—'),
        where,
        r.permalink ? `[${text_}](${r.permalink})` : text_,
        r.media_product_type || r.media_type || '—',
        n(r.reach), n(r.views), n(r.saved), n(r.total_interactions),
        r.interaction_rate_pct !== null && r.interaction_rate_pct !== undefined
          ? p(Number(r.interaction_rate_pct)) : '—',
      ];
    })
  );

  // Reels with no transcript were searched on their caption alone. Saying so
  // is the difference between "not said in any video" and "most videos have
  // not been listened to yet".
  const videoRows = igRows.filter((r) => (r.media_type || '') === 'VIDEO');
  const untranscribed = videoRows.filter((r) => !r.transcript && !r.transcript_error).length;

  const total = rows.length + igRows.length;
  // A capped result that does not say so reads as the complete answer.
  const moreFb = rows.matchedTotal && rows.matchedTotal > rows.length
    ? `\n\n_Showing the top ${rows.length} of **${rows.matchedTotal}** matching Facebook posts, ranked by reach. `
      + `Raise \`limit\` (max 100) or narrow the query to see the rest._`
    : '';
  // Both counts are stated even when one is zero. A silently absent section
  // reads as "there were none of those", which is the same sentence as "that
  // half was never searched" - and until now it was the second one.
  return {
    text: `**${total} post${total === 1 ? '' : 's'} matching "${query}"**`
      + ` · ${rows.length} on Facebook, ${igRows.length} on Instagram`
      + `${page_id ? ' · one page' : ' · all collected pages'}`
      + `${days ? ` · last ${days} days` : ''} · ranked by reach\n\n`
      + `**Facebook**\n\n${rows.length ? fbTable + moreFb : '_No Facebook post copy matched._'}\n\n`
      + `**Instagram**\n\n${igRows.length ? igTable : '_No Instagram captions matched._'}`
      + '\n\n_Matches Facebook post copy, Instagram captions and the spoken words in transcribed Reels — not comments. '
      + '"Matched" says which of those the hit came from. The text shown is a window around the match, not the opening of the post. '
      + (untranscribed
        ? `**${untranscribed} of the ${videoRows.length} Reels shown have not been transcribed yet, so they were searched on their caption alone** — a Reel can say the word out loud and not appear here. `
        : '')
      + 'Engagement is reactions + comments + shares + clicks, the same definition top_posts uses, over total views. '
      + 'Each platform is ranked by its own reach and the two are not directly comparable — Facebook reach and Instagram reach are differently defined by Meta._',
    data: { facebook: rows, instagram: igRows },
  };
}

// Page-level trend, as opposed to individual post performance. Answers "are we
// growing" rather than "did this post work".
async function pageGrowth(store, { page_id, days: d = 30 }) {
  const days = clampDays(d, 30);
  const rows = await store.pageGrowth({ page_id, since: sinceFor(days) });
  if (!rows || !rows.length) {
    return {
      text: 'No page-level data yet. It is collected alongside posts, so it appears after the next collection run.',
      data: null,
    };
  }

  // Group by page and report the window's movement rather than every day —
  // 30 rows per page across 36 pages would be unreadable.
  const byPage = new Map();
  for (const r of rows) {
    if (!byPage.has(r.page_id)) byPage.set(r.page_id, []);
    byPage.get(r.page_id).push(r);
  }

  const summary = [...byPage.values()].map((series) => {
    series.sort((a, b) => (a.metric_date < b.metric_date ? -1 : 1));
    const first = series[0];
    const last = series[series.length - 1];
    const sum = (k) => {
      const vals = series.map((x) => x[k]).filter((v) => typeof v === 'number');
      return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
    };
    const startF = first.followers_snapshot;
    const endF = last.followers_snapshot;
    return {
      name: last.page_name,
      days: series.length,
      followers: endF,
      // Only meaningful once there are snapshots from different days; on a
      // single collection every snapshot is identical, so this reads 0 rather
      // than pretending to be a trend.
      followerChange: (typeof startF === 'number' && typeof endF === 'number') ? endF - startF : null,
      views: sum('views_total'),
      reach: sum('media_view_unique'),
      engagements: sum('post_engagements'),
      newFollows: sum('daily_follows'),
      unfollows: sum('daily_unfollows'),
      // Genuinely net, from Meta's own two daily metrics. Null rather than 0
      // when neither has data, so a page with no coverage does not read as a
      // page that neither gained nor lost anyone.
      netFollows: (() => {
        const f = sum('daily_follows'); const u = sum('daily_unfollows');
        return f === null && u === null ? null : (f || 0) - (u || 0);
      })(),
    };
  }).sort((a, b) => (b.views || 0) - (a.views || 0));

  return {
    text: `**Page-level trend · last ${days} days**\n\n`
      + table(
        ['Page', 'Days', 'Followers', 'Page views', 'Reach', 'Engagements', 'Follows', 'Unfollows', 'Net'],
        summary.map((s) => [
          s.name, s.days, n(s.followers),
          n(s.views), n(s.reach), n(s.engagements),
          n(s.newFollows), n(s.unfollows), n(s.netFollows),
        ])
      )
      + '\n\n_Page-level figures, not post totals: page views include profile visits, and reach counts people who saw anything from the page. '
      + '"Net" is follows minus unfollows, both from Meta\'s own daily metrics — a negative number means the page shed followers over the window even if it was reaching people. '
      + 'Unfollows have only been collected since 7 September 2026, so "—" on an earlier window means not measured, not zero. '
      + 'The follower count is as at the last collection, not as at each date: a backfill stamps every row with one day\'s number, which is why the snapshot is not used to derive the trend._',
    data: summary,
  };
}


async function instagramPosts(store, { page_id, days: d = 30, sort = 'reach', limit: l = 15 }) {
  const days = clampDays(d, 30); const limit = clampRows(l, 15, 100);
  const rows = await store.igMedia({ page_id, since: sinceFor(days), sort, limit });
  if (!rows || !rows.length) {
    return {
      text: 'No Instagram data yet.\n\n_Instagram needs `instagram_basic` and `instagram_manage_insights` on the token, and the account must be a Business or Creator account linked to the Facebook Page. A personal Instagram account exposes no insights at all, whatever the token allows._',
      data: null,
    };
  }
  const label = { reach: 'reach', saved: 'saves', views: 'views', interactions: 'interactions', recent: 'most recent' }[sort] || sort;
  return {
    text: `**Top ${rows.length} Instagram posts by ${label}**${days ? ` · last ${days} days` : ''}\n\n`
      + table(
        ['Date', 'Account', 'Post', 'Type', 'Reach', 'Views', 'Saves', 'Saves/1k', 'Interactions', 'Rate', 'Follows', 'Avg watch'],
        rows.map((r) => [
          (r.timestamp || '').slice(0, 10),
          r.ig_username ? '@' + r.ig_username : (r.page_name || '—'),
          r.permalink ? `[${truncate(r.caption, 52).replace(/\|/g, '\\|')}](${r.permalink})` : truncate(r.caption, 52),
          r.media_product_type || r.media_type || '—',
          n(r.reach), n(r.views), n(r.saved),
          r.saves_per_1k_reached !== null && r.saves_per_1k_reached !== undefined ? Number(r.saves_per_1k_reached).toFixed(1) : '—',
          n(r.total_interactions),
          r.interaction_rate_pct !== null && r.interaction_rate_pct !== undefined ? p(Number(r.interaction_rate_pct)) : '—',
          // The two columns are mutually exclusive by product type, not
          // patchily populated: Meta serves follows only for FEED and watch
          // time only for REELS.
          n(r.follows),
          r.reels_avg_watch_seconds !== null && r.reels_avg_watch_seconds !== undefined
            ? Number(r.reels_avg_watch_seconds).toFixed(1) + 's' : '—',
        ])
      )
      + '\n\n_Saves per 1,000 reached is the intent signal worth watching: saving a post is a deliberate act in a way a like is not, and Facebook has no equivalent metric. '
      + '"Follows" is followers gained from that post and exists for FEED posts only; "Avg watch" exists for Reels only — Meta refuses each metric on the other type, so "—" means not offered rather than zero. '
      + 'Both have only been collected since 7 September 2026._',
    data: rows,
  };
}

async function adSpend(store, { page_id, days: d = 90, limit: l = 20 }) {
  const days = clampDays(d, 90); const limit = clampRows(l, 20, 100);
  const rows = await store.adSpend({ page_id, since: sinceFor(days), limit });
  if (!rows || !rows.length) {
    return {
      text: 'No boosted posts found.\n\n_Ad spend needs `ads_read` on the token, and only posts that were actually promoted appear here. An organic-only page will always be empty._',
      data: null,
    };
  }
  // Spend is in whatever currency each ad account bills in — this estate uses
    // seven. Summing them gives a number that means nothing, and labelling that
    // sum with the first row's currency makes it look like it does: this reported
    // "ARS 141431.18 total" for a mix of ARS, GBP, CAD and AUD.
    //
    // Ranking had the same flaw and it mattered more. Sorted by raw spend, a
    // 139,207 ARS boost (about GBP 100) outranked a genuine GBP 658 one purely
    // because the number is larger. Ordered by paid reach instead: currency
    // neutral, and closer to the question being asked.
    const byCurrency = new Map();
    for (const r of rows) {
      const c = r.currency || '?';
      byCurrency.set(c, (byCurrency.get(c) || 0) + (Number(r.total_spend) || 0));
    }
    const multi = byCurrency.size > 1;
    const totals = [...byCurrency.entries()].sort((a, b) => b[1] - a[1])
      .map(([c, v]) => `${c} ${v.toLocaleString('en-GB', { maximumFractionDigits: 0 })}`)
      .join(' · ');
    const sorted = [...rows].sort((a, b) => (b.ad_reach || 0) - (a.ad_reach || 0));
  return {
    text: `**Boosted posts · last ${days} days** · ${rows.length} post${rows.length === 1 ? '' : 's'}\n\nSpend by currency: ${totals}${multi ? '. These are **not** added together — different ad accounts bill in different currencies, so one total would be meaningless.' : '.'}\n\n`
      + table(
        ['Date', 'Page', 'Post', 'Spend', 'Paid reach', 'Cost/1k', 'Organic views', 'Paid views', 'Organic:paid'],
        sorted.map((r) => [
          (r.created_time || '').slice(0, 10),
          r.page_name || '—',
          r.permalink_url ? `[${truncate(r.message, 44).replace(/\|/g, '\\|')}](${r.permalink_url})` : truncate(r.message, 44),
          r.total_spend !== null ? `${r.currency || ''} ${Number(r.total_spend).toFixed(2)}` : '—',
          n(r.ad_reach), 
          r.cost_per_1k_reached !== null && r.cost_per_1k_reached !== undefined ? Number(r.cost_per_1k_reached).toFixed(2) : '—',
          n(r.views_organic), n(r.views_paid),
          r.organic_to_paid_ratio !== null && r.organic_to_paid_ratio !== undefined ? Number(r.organic_to_paid_ratio).toFixed(2) + '×' : '—',
        ])
      )
      + (multi ? '\n\n_Ordered by paid reach, not spend: amounts in different currencies cannot be ranked against each other._' : '')
        + '\n\n_"Organic:paid" is how much reach the post earned for free against what was paid for. Above 1 means the free half did more work than the money did — those are the posts worth studying, and arguably the ones worth boosting harder._',
    data: rows,
  };
}

const TOOLS = [
  {
    name: 'list_pages',
    description: 'List every Facebook page currently being collected, with follower counts, post counts, data completeness and headline medians. Call this first if you do not know which pages exist or need a page_id.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (store) => listPages(store),
  },
  {
    name: 'top_posts',
    description: 'Rank organic posts by a chosen metric. Use this to answer "which of our posts performed best". Sort by "beyond" to find posts that spread furthest past existing followers — usually the most useful measure of whether content travelled, as opposed to merely reaching people who already follow the page.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'Restrict to one page. Omit for all pages. Get ids from list_pages.' },
        days: { type: 'number', description: 'Look back this many days (default 30). Use 0 for all collected data.' },
        sort: { type: 'string', enum: ['views', 'reach', 'beyond', 'engagement', 'rate', 'shares', 'recent'], description: 'Ranking metric (default views).' },
        limit: { type: 'number', description: 'How many posts to return (default 10).' },
      },
      additionalProperties: false,
    },
    handler: (store, args) => topPosts(store, args),
  },
  {
    name: 'page_summary',
    description: 'Headline performance for a single page over a period. Leads with the PAGE-level view count — the same figure Business Suite shows — then the post-level numbers for posts published in the window, its best post and the one that travelled furthest beyond its followers. Use for "how did <page> do in July" or "last month". Pass since/until for a calendar month; the two view figures are different quantities and are explained in the answer.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'The page to summarise. Get ids from list_pages.' },
        days: { type: 'number', description: 'Look back this many days (default 30). Ignored when since is given.' },
        since: { type: 'string', description: 'Window start, YYYY-MM-DD. Use for a calendar month, e.g. 2026-07-01.' },
        until: { type: 'string', description: 'Window end INCLUSIVE, YYYY-MM-DD, e.g. 2026-07-31. Defaults to today.' },
      },
      required: ['page_id'],
      additionalProperties: false,
    },
    handler: (store, args) => pageSummary(store, args),
  },
  {
    name: 'compare_pages',
    description: 'Compare every collected page over the same period, including views per follower — the fair comparison across pages of very different audience sizes. Use for "which country page is doing best".',
    inputSchema: {
      type: 'object',
      properties: { days: { type: 'number', description: 'Look back this many days (default 30).' } },
      additionalProperties: false,
    },
    handler: (store, args) => comparePages(store, args),
  },
  {
    name: 'search_posts',
    description: 'Search the text of collected posts across every page — Facebook post copy AND Instagram captions — and return them ranked by reach, in separate sections per platform. Use this whenever someone asks about a topic, campaign or specific post rather than about a page overall — "how did our marriage posts do", "what did we publish about assisted dying", "find the Sarah Morse posts". Searches the text the page wrote, not comments, and not anything spoken or shown inside a video.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Word or phrase appearing in the post text. Case-insensitive.' },
        page_id: { type: 'string', description: 'Restrict to one page. Omit to search every collected page.' },
        days: { type: 'number', description: 'Only posts from the last N days. Omit or 0 for all collected history.' },
        limit: { type: 'number', description: 'Maximum posts to return (default 15, max 200).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: (store, args) => searchPosts(store, args),
  },
  {
    name: 'outliers',
    description: 'Establish what "normal" looks like for a page (median views, engagement rate, shares) and list the posts that broke away from it or fell well below. Use this to answer "was this post actually good", "what worked", or "why did this one do so well" — a raw view count is meaningless without the page baseline to compare it against.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'Restrict to one page. Omit for all pages.' },
        days: { type: 'number', description: 'Window to compute the baseline over (default 90). A longer window gives a steadier baseline.' },
        limit: { type: 'number', description: 'How many posts to list at each end (default 25). The count of any left out is always stated.' },
      },
      additionalProperties: false,
    },
    handler: (store, args) => outliers(store, args),
  },
  {
    name: 'page_growth',
    description: 'Page-level trend over time: followers and how they changed, page views, total page reach, engagements and new follows. Use this for "are we growing", "how is this page trending" or "which pages are gaining followers" — as opposed to how any individual post did.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'Restrict to one page. Omit for every collected page.' },
        days: { type: 'number', description: 'Window in days (default 30).' },
      },
      additionalProperties: false,
    },
    handler: (store, args) => pageGrowth(store, args),
  },
  {
    name: 'instagram_posts',
    description: 'Top Instagram posts by reach, saves, views or interactions. Use for any question about Instagram rather than Facebook. Saves are the notable metric here — Facebook has no equivalent, and saving a post signals far more intent than a like.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'Restrict to the Instagram account linked to this Facebook page id.' },
        days: { type: 'number', description: 'Look back this many days (default 30, 0 for all).' },
        sort: { type: 'string', enum: ['reach', 'saved', 'views', 'interactions', 'recent'], description: 'Ranking metric (default reach).' },
        limit: { type: 'number', description: 'How many posts (default 15).' },
      },
      additionalProperties: false,
    },
    handler: (store, args) => instagramPosts(store, args),
  },
  {
    name: 'ad_spend',
    description: 'Posts that were boosted, with what they cost and how paid reach compares to what the post earned organically. Use for "what did we spend on this", "which boosts were worth it", "cost per person reached". Only promoted posts appear.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'Restrict to one page.' },
        days: { type: 'number', description: 'Look back this many days (default 90).' },
        limit: { type: 'number', description: 'How many posts (default 20).' },
      },
      additionalProperties: false,
    },
    handler: (store, args) => adSpend(store, args),
  },
  {
    name: 'share_amplification',
    description: 'Show which posts kept earning engagement AFTER being shared — reactions people left on reshares rather than on the original. Use this to answer "which posts did supporters actually carry", "what was worth sharing", or "did this post have a second life". Different from reach beyond followers: that says where a post landed, this says whether it kept working once it got there.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'Restrict to one page. Omit for all pages.' },
        days: { type: 'number', description: 'How far back to look (default 90).' },
        limit: { type: 'number', description: 'How many posts to list (default 15).' },
      },
      additionalProperties: false,
    },
    handler: (store, args) => shareAmplification(store, args),
  },
  {
    name: 'data_health',
    description: 'Report coverage and known gaps: how many posts lack metrics and why, which scopes are missing, and what caveats to state when reporting. Call this before presenting numbers as complete, and whenever a total looks surprisingly low.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (store) => dataHealth(store),
  },
];

// How old the data may be before a caller is warned. Collection runs nightly,
// so two days means one missed run passes quietly and two does not.
const STALE_AFTER_DAYS = 2;

async function freshnessBanner(store) {
  if (typeof store.freshness !== 'function') return '';
  let f;
  try {
    f = await store.freshness();
  } catch (e) {
    // Never let the freshness check break the answer it is annotating.
    return '';
  }
  if (!f || !f.latest) {
    return '**No data has been collected yet.** Everything below will be empty.\n\n';
  }
  const days = Math.floor((Date.now() - new Date(f.latest + 'T00:00:00Z').getTime()) / 86400000);
  if (days < STALE_AFTER_DAYS) return '';
  return `**These figures are ${days} days old.** The most recent collection ran on ${f.latest}. `
    + 'Nightly collection has probably stopped — most often an expired Facebook token. '
    + 'Treat the numbers below as historic, not current.\n\n';
}

// Single dispatch path for BOTH transports. Previously each server looked the
// tool up itself, which is how a check added in one place would silently miss
// the other.
async function callTool(store, name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    const e = new Error(`Unknown tool: ${name}`);
    e.code = 'UNKNOWN_TOOL';
    throw e;
  }
  const out = await tool.handler(store, args || {});
  const banner = await freshnessBanner(store);
  // Prepended, not appended: a warning below the numbers is a warning nobody
  // reads until after they have quoted them.
  return { ...out, text: banner + out.text };
}

module.exports = { TOOLS, callTool, freshnessBanner, STALE_AFTER_DAYS };
