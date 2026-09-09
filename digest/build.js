#!/usr/bin/env node
'use strict';
// Weekly organic performance digest, written for the social media team rather
// than for an analyst: plain language, every number framed against the page's own
// baseline, and honest about what the data cannot say.
//
// Covers Facebook and, since 3 Sep 2026, Instagram. Instagram is reported in its
// own section rather than folded in: the metrics are not the same shape - there
// is no paid split, but there IS "saved", which Facebook has no equivalent for
// and which signals more intent than a like.
//
// Since 8 Sept 2026 it also carries follower growth. Facebook reports follows
// and unfollows per page per DAY, so net growth gets its own section rather
// than being attached to posts - the daily change cannot be attributed to a
// post, and trying would be invention. Instagram reports follows per FEED post
// and watch time per REEL, each refused on the other type, so both are
// reported against the posts that can carry them.
//
// Deliberately NOT here: the organic/paid split on video views. This digest is
// organic-only by design, and mixing a paid figure into it would undercut that
// framing for a number nobody asked the digest for.
//
// One statistical rule enforced here, because it is easy to get wrong and
// impossible to spot afterwards: per-post UNIQUE reach is never summed. Two posts
// reaching 1,000 people each have not reached 2,000 people — the same followers
// see both. Views are additive; people are not. So this reports total views, and
// reports unique reach only per-post.
//
// Usage:
//   node digest/build.js [--page-id ID] [--weeks 2] [--out FILE]

const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../lib/graph');
const { fileStore, supabaseStore } = require('../lib/store');
const { shapeFeed, shapePages, pageBaseline, withBenchmark, median } = require('../lib/shape');

loadEnv();

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 || !args[i + 1] || args[i + 1].startsWith('--') ? fallback : args[i + 1];
};

const WEEKS = Number(opt('weeks', 2));
const PAGE_ID = opt('page-id', null);
const OUT = opt('out', null);

const DAY = 86400000;
const n = (v) => (v === null || v === undefined ? '—' : Math.round(v).toLocaleString('en-GB'));
const pc = (v) => (v === null || v === undefined ? '—' : v.toFixed(1) + '%');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (iso) => {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};
const clean = (s, len) => {
  const one = (s || '(no text)').replace(/\s+/g, ' ').trim();
  return one.length > len ? one.slice(0, len - 1) + '…' : one;
};

function signed(v, suffix = '%') {
  if (v === null || v === undefined) return '—';
  const r = Math.round(v);
  return (r > 0 ? '+' : '') + r + suffix;
}

// Signed AND thousands-separated. signed() is for percentages, where the number
// is small; follower counts run to four figures and "+4355" beside "5,111
// follows" reads as a different kind of number.
function signedCount(v) {
  if (v === null || v === undefined) return '—';
  const r = Math.round(v);
  return (r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r).toLocaleString('en-GB');
}

// Week-over-week on a handful of posts is noisy, and organic reach is so skewed
// that one shared post can swing a weekly total by an order of magnitude. Both
// failure modes are called out rather than presenting a percentage as a trend.
//
// This exists because the first live run reported "views -86%" with no caveat,
// when the whole difference was a single viral post in the earlier week. Read
// cold, that says "we collapsed". It did not.
function shareOfWeek(w) {
  return w.views > 0 ? w.top_views / w.views : 0;
}

function changeNote(thisWeek, lastWeek, medDelta) {
  if (!lastWeek.posts) return 'No posts the week before, so there is nothing to compare against.';

  const notes = [];
  if (thisWeek.posts < 4 || lastWeek.posts < 4) {
    notes.push(`based on ${thisWeek.posts} posts against ${lastWeek.posts} the week before, which is too few for the change to mean much`);
  }
  const domNow = shareOfWeek(thisWeek);
  const domPrev = shareOfWeek(lastWeek);
  if (domPrev >= 0.5) {
    notes.push(`${Math.round(domPrev * 100)}% of last week's views came from one post, so the drop is that single post ending rather than a fall in normal performance`);
  } else if (domNow >= 0.5) {
    // Say what actually happened. This branch fires on CONCENTRATION, which says

    // nothing about direction — it printed "the rise" directly beneath a 24% fall.

    const fell = typeof medDelta === 'number' && medDelta < 0;

    notes.push(`${Math.round(domNow * 100)}% of this week's views came from one post, so `

      + (fell

        ? 'the headline is that single post, not a recovery — the typical post still fell'

        : 'the rise is that single post rather than a broad improvement'));
  }
  if (!notes.length) return null;
  return notes.join('; and ').replace(/^./, (c) => c.toUpperCase()) + '.';
}

function windowStats(rows, from, to) {
  const inWindow = rows.filter((r) => {
    const t = new Date(r.created_time).getTime();
    return t >= from && t < to;
  });
  const scored = inWindow.filter((r) => r.has_metrics);
  return {
    posts: inWindow.length,
    scored: scored.length,
    no_metrics: inWindow.length - scored.length,
    views: scored.reduce((a, r) => a + (r.views_total || 0), 0),
    // NOT summed across posts — see the note at the top of this file.
    best_unique: scored.length ? Math.max(...scored.map((r) => r.views_unique || 0)) : null,
    shares: scored.reduce((a, r) => a + (r.shares_total || 0), 0),
    reactions: scored.reduce((a, r) => a + (r.reactions_total || 0), 0),
    med_eng: median(scored.map((r) => r.engagement_rate).filter((v) => v !== null)),
    med_beyond: median(scored.map((r) => r.beyond_followers_pct).filter((v) => v !== null)),
    // The median is what survives an outlier; the total does not.
    med_views: median(scored.map((r) => r.views_total).filter((v) => v !== null)),
    top_views: scored.length ? Math.max(...scored.map((r) => r.views_total || 0)) : 0,
    rows: inWindow,
  };
}

async function main() {
  const store = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
    ? supabaseStore({ url: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_KEY })
    : fileStore({ dir: path.join(__dirname, '..', 'data') });

  const data = await store.loadAll();
  const pages = shapePages(data);
  if (!pages.length) {
    console.error('No pages found. Has the collector run?');
    process.exit(1);
  }

  // --page-id narrows to one page; the default is the whole estate. Reporting on
  // one page by default was the old behaviour and it quietly hid 35 others.
  const page = PAGE_ID ? pages.find((p) => p.page_id === PAGE_ID) : null;
  if (PAGE_ID && !page) {
    console.error(`No page with id ${PAGE_ID}.`);
    process.exit(1);
  }
  const scopeName = page ? page.name : 'All pages';

  const feed = shapeFeed(data, page ? { page_id: page.page_id, sort: 'recent' } : { sort: 'recent' });

  // Instagram, read separately: loadAll covers Facebook only. Wrapped so a
  // failure here cannot take the whole digest down - the same rule the
  // collector applies.
  let igAll = [];
  if (typeof store.igFeed === 'function') {
    try { igAll = (await store.igFeed()) || []; } catch (e) {
      console.error(`instagram skipped — ${e.message.slice(0, 80)}`);
    }
  }
  if (page) igAll = igAll.filter((r) => r.page_id === page.page_id);

  // The page-day series, for follower growth. Separate read again: loadAll
  // covers posts, and follows happen on days rather than on posts.
  let growthAll = [];
  if (typeof store.pageGrowth === 'function') {
    try {
      growthAll = (await store.pageGrowth({
        page_id: page ? page.page_id : undefined,
        since: new Date(Date.now() - 21 * DAY).toISOString(),
        limit: 2000,
      })) || [];
    } catch (e) {
      console.error(`page growth skipped — ${e.message.slice(0, 80)}`);
    }
  }

  const now = Date.now();
  const thisWeek = windowStats(feed.rows, now - 7 * DAY, now + DAY);
  const lastWeek = windowStats(feed.rows, now - 14 * DAY, now - 7 * DAY);

  // Baselines over the whole collected history, not just this week — a one-week
  // baseline would move with the thing it is meant to measure.
  //
  // CRUCIALLY, one baseline PER PAGE. A single estate-wide median is meaningless
  // when pages range from 7 followers to 292,876: it rates every post on a large
  // page as extraordinary and every post on a small one as a failure, when the
  // interesting question is whether a post beat what its OWN page normally does.
  const baselineByPage = new Map();
  for (const p of pages) {
    baselineByPage.set(p.page_id, pageBaseline(feed.rows.filter((r) => r.page_id === p.page_id)));
  }
  // Used only for the headline context line when scoped to a single page.
  const base = page ? baselineByPage.get(page.page_id) : pageBaseline(feed.rows);

  const scored = thisWeek.rows.filter((r) => r.has_metrics)
    .map((r) => withBenchmark(r, baselineByPage.get(r.page_id)))
    .filter((r) => r.benchmark)   // no baseline yet for that page: too few posts
    .sort((a, b) => (b.views_total || 0) - (a.views_total || 0));

  const over = scored.filter((r) => r.benchmark && r.benchmark.views_x_median >= 1.5);
  // Ranked by how far below ITS OWN page's normal each post fell, not by raw
  // views. Sorted by views, HazteOir filled all five slots every week simply
  // because its posts are larger in absolute terms - a 12,000-view post there is
  // a miss, while the same number would be a record on most other pages. The
  // underperformers on smaller pages were never visible at all.
  const under = scored
    .filter((r) => r.benchmark && r.benchmark.views_x_median < 0.5)
    .sort((x, y) => x.benchmark.views_x_median - y.benchmark.views_x_median);
  const carried = scored.filter((r) => r.benchmark && r.benchmark.shares_x_median >= 2);

  const viewsDelta = lastWeek.views > 0 ? ((thisWeek.views - lastWeek.views) / lastWeek.views) * 100 : null;
  const medDelta = (lastWeek.med_views > 0 && thisWeek.med_views !== null)
    ? ((thisWeek.med_views - lastWeek.med_views) / lastWeek.med_views) * 100 : null;
  const weekEnding = new Date(now).toISOString().slice(0, 10);
  const L = [];

  L.push(`# ${scopeName} — organic performance`);
  L.push(`Week ending ${weekEnding}`);
  L.push('');

  L.push('## The week in short');
  L.push('');
  L.push(`- **${thisWeek.posts} posts** published, ${n(thisWeek.views)} views in total`);
  L.push(`- Best single post reached **${n(thisWeek.best_unique)} people**`);
  L.push(`- **${n(thisWeek.shares)} shares** and ${n(thisWeek.reactions)} reactions`);
  L.push(`- Typical post: ${pc(thisWeek.med_eng)} engagement rate, ${pc(thisWeek.med_beyond)} of its reach beyond your followers`);
  if (viewsDelta !== null) {
    // The median comparison is the one to trust; the total is shown for
    // completeness because people will add the numbers up themselves otherwise.
    L.push(`- Typical post **${signed(medDelta)}** against the week before (total views ${signed(viewsDelta)})`);
  }
  const caveat = changeNote(thisWeek, lastWeek, medDelta);
  if (caveat) L.push(`- _${caveat}_`);
  L.push('');

  if (base.reliable) {
    L.push(page
      ? `For context, a normal post on this page gets **${n(base.median_views)} views** and ${pc(base.median_eng_rate)} engagement. Everything below is measured against that.`
      : 'Each post below is measured against what its **own page** normally does, not against the other pages. '
        + 'A page with 200 followers and one with 200,000 are not comparable on raw numbers, so comparing each to itself is the only fair reading.');
    L.push('');
  }

  if (!page) {
    // Per-page movement over the same window. Median, not total: a page that
    // posts twice as often would otherwise always look twice as good.
    const perPage = pages.map((p) => {
      const rows = thisWeek.rows.filter((r) => r.page_id === p.page_id && r.has_metrics);
      if (!rows.length) return null;
      return {
        name: p.name,
        posts: rows.length,
        views: rows.reduce((a, r) => a + (r.views_total || 0), 0),
        medianReach: median(rows.map((r) => r.views_unique).filter((v) => v !== null)),
        medianBeyond: median(rows.map((r) => r.beyond_followers_pct).filter((v) => v !== null)),
      };
    }).filter(Boolean).sort((a, b) => b.views - a.views);

    if (perPage.length) {
      L.push('## How each page did');
      L.push('');
      L.push('| Page | Posts | Views | Typical reach | Beyond followers |');
      L.push('| --- | --- | --- | --- | --- |');
      for (const p of perPage.slice(0, 15)) {
        L.push(`| ${p.name} | ${p.posts} | ${n(p.views)} | ${n(p.medianReach)} | ${pc(p.medianBeyond)} |`);
      }
      if (perPage.length > 15) {
        L.push('');
        L.push(`_${perPage.length - 15} more pages posted this week and are not shown._`);
      }
      L.push('');
      const quiet = pages.length - perPage.length;
      if (quiet > 0) {
        L.push(`**${quiet} of ${pages.length} pages published nothing** with measurable reach this week.`);
        L.push('');
      }
    }
  }

  L.push('## What worked');
  L.push('');
  if (!over.length) {
    L.push('Nothing beat the page\'s usual performance by a clear margin this week.');
  } else {
    for (const r of over.slice(0, 5)) {
      L.push(`**"${clean(r.message, 150)}"**`);
      L.push('');
      L.push(`${r.benchmark.views_x_median}× a normal post · ${shortDate(r.created_time)}${page ? '' : ' · ' + r.page_name} · ${r.media_type || 'post'}${r.permalink_url ? ` · [see the post](${r.permalink_url})` : ''}`);
      L.push('');
      L.push(`${n(r.views_total)} views · ${n(r.views_unique)} people reached · ${pc(r.beyond_followers_pct)} beyond your followers · ${n(r.shares_total)} shares · ${pc(r.engagement_rate)} engagement`);
      L.push('');
    }
  }

  L.push('## What did not land');
  L.push('');
  if (!under.length) {
    L.push('No post fell well below the usual level this week.');
  } else {
    L.push('These fell furthest below what their **own** page normally does — so a small page having a bad week appears here beside a large one. Worth a look at format and timing rather than subject; several are on themes that have worked before.');
    L.push('');
    // At most two per page, so one prolific page cannot crowd out the rest even
    // when it genuinely holds the five worst multiples.
    const spread = [];
    const perPage = new Map();
    for (const r of under) {
      const seen = perPage.get(r.page_id) || 0;
      if (!page && seen >= 2) continue;
      perPage.set(r.page_id, seen + 1);
      spread.push(r);
      if (spread.length === 5) break;
    }
    for (const r of spread) {
      L.push(`- **"${clean(r.message, 110)}"**`);
      L.push(`  ${r.benchmark.views_x_median}× a normal post · ${shortDate(r.created_time)}${page ? '' : ' · ' + r.page_name} · ${n(r.views_total)} views${r.permalink_url ? ` · [see the post](${r.permalink_url})` : ''}`);
    }
    L.push('');
  }

  const weekStart = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

  // Reactions on reshares, for the same week. Skipped silently when the data
  // source cannot answer - the file backend has no such view, and a digest that
  // failed because an extra section was unavailable would be worse than one
  // without it.
  let amp = [];
  if (typeof store.amplification === 'function') {
    try {
      amp = (await store.amplification({ page_id: page ? page.page_id : undefined, since: weekStart, limit: 200 })) || [];
    } catch (e) { amp = []; }
  }

  L.push('## The pattern to notice');
  L.push('');
  if (carried.length) {
    const best = carried[0];
    L.push(`${carried.length} post${carried.length > 1 ? 's' : ''} got shared far more than usual, and that is what carried ${carried.length > 1 ? 'them' : 'it'} beyond your existing followers. The clearest case did **${best.benchmark.shares_x_median}× the normal number of shares** and ${pc(best.beyond_followers_pct)} of its reach came from people who do not follow the page.`);
    L.push('');
    L.push('That is the difference between a post being *carried* by supporters and merely being *seen*. Reach beyond followers comes from shares, not from posting more.');
  } else {
    L.push('Nothing was shared unusually heavily this week, so most reach came from people who already follow the page. Posts that travel further tend to be the ones supporters pass on.');
  }
  L.push('');

  // Amplification: engagement the post earned AFTER it left the page. Distinct
  // from everything above, which measures what happened on the post itself.
  if (amp.length) {
    const onReshares = amp.reduce((a2, r) => a2 + (Number(r.reactions_on_reshares) || 0), 0);
    const ranked = [...amp].sort((x, y) => Number(y.amplification) - Number(x.amplification));
    const best = ranked[0];

    // Gated on there being something to report, NOT on the best post clearing a
    // line. The first version required 1.30x and the week's best was 1.29 - so
    // 14,114 reactions on reshares went unmentioned because one post missed an
    // arbitrary threshold by a hundredth. The 1.30 mark belongs in the
    // interpretation below, where a reader can apply it, not in a gate that
    // silently removes the section.
    if (onReshares > 0 && amp.length >= 5 && best) {
      L.push('### And what kept working after it was shared');
      L.push('');
      L.push(`**${n(onReshares)} reactions** this week happened on somebody else's copy of a post rather than on the original — engagement earned after it left the page.`);
      L.push('');
      L.push(`The clearest was ${page ? '' : `**${best.page_name}**'s `}"${clean(best.message, 80)}" — **${Number(best.amplification).toFixed(2)}×**: ${n(best.reactions_on_post)} reactions on the post and ${n(best.reactions_on_reshares)} more on reshares.${best.permalink_url ? ` [See the post](${best.permalink_url}).` : ''}`);
      L.push('');

      // The counterpoint is the point. A post can reach enormous numbers because
      // Meta distributed it while nobody passed it on, and the two look identical
      // in every other view here.
      const wide = [...amp]
        .filter((r) => Number(r.views_unique) > 0 && Number(r.amplification) <= 1.05)
        .sort((x, y) => Number(y.views_unique) - Number(x.views_unique))[0];
      if (wide) {
        L.push(`For contrast, ${page ? '' : `${wide.page_name}'s `}"${clean(wide.message, 60)}" reached ${n(wide.views_unique)} people at only **${Number(wide.amplification).toFixed(2)}×** — Meta distributed it widely, but almost nobody carried it. Both look like successes on reach alone; only one was passed on.`);
        L.push('');
      }
      L.push('_Above 1.30× a post earned a real second life on other people\'s timelines. 1.00× means it was seen, not shared on._');
      L.push('');
    }
  }

  // ---- Follower growth -----------------------------------------------------
  //
  // Note the exception to this file's central rule: follows and unfollows ARE
  // additive. They are counts of events, not of unique people, so a week's
  // total and an estate total both mean something - unlike reach, which is a
  // count of people and must never be summed.
  //
  // Both halves only exist from 7 Sept 2026. Before that the collector asked
  // for page_daily_follows and never for unfollows, so net growth was not
  // uncertain, it was unmeasurable. Any window reaching back further is partial
  // and says so rather than quietly treating a null as a zero.
  const gWindow = (from, to) => growthAll.filter((r) => {
    const t = Date.parse(r.metric_date);
    return !Number.isNaN(t) && t >= from && t < to;
  });
  const gThis = gWindow(now - 7 * DAY, now + DAY);

  if (gThis.length) {
    const gnum = (v) => (v === null || v === undefined ? null : Number(v));
    const total = (rows, k) => rows.reduce((a, r) => a + (gnum(r[k]) || 0), 0);
    const measured = gThis.filter((r) => gnum(r.daily_unfollows) !== null);
    const gained = total(gThis, 'daily_follows');
    const lost = total(measured, 'daily_unfollows');

    L.push('## Follower growth');
    L.push('');

    if (!measured.length) {
      L.push(`- **${n(gained)} new follows** across the week. Unfollows were not collected for these dates, so this is gross growth, not net.`);
      L.push('');
    } else {
      const net = gained - lost;
      L.push(`- **${n(gained)} follows** and **${n(lost)} unfollows** — net **${signedCount(net)}**`);

      // Per page, so a healthy estate total cannot hide pages going backwards.
      const byPage = new Map();
      for (const r of measured) {
        const k = r.page_name || r.page_id;
        const cur = byPage.get(k) || { gained: 0, lost: 0 };
        cur.gained += gnum(r.daily_follows) || 0;
        cur.lost += gnum(r.daily_unfollows) || 0;
        byPage.set(k, cur);
      }
      const ranked = [...byPage.entries()]
        .map(([name, v]) => ({ name, net: v.gained - v.lost, ...v }))
        .sort((a, b) => a.net - b.net);
      const shrinking = ranked.filter((x) => x.net < 0);

      if (!page && ranked.length > 1) {
        const best = ranked[ranked.length - 1];
        L.push(`- Strongest: **${best.name}** at ${signedCount(best.net)} (${n(best.gained)} in, ${n(best.lost)} out)`);
        if (shrinking.length) {
          const worst = shrinking[0];
          L.push(`- **${shrinking.length} page${shrinking.length === 1 ? '' : 's'} lost followers on the week**, worst ${worst.name} at ${signedCount(worst.net)}`);
        } else {
          L.push('- No page went backwards on the week');
        }
      }
      if (measured.length < gThis.length) {
        L.push(`- _Unfollows are known for ${measured.length} of ${gThis.length} page-days here; the rest predate collection and are left out of the net rather than counted as zero._`);
      }
      L.push('');
      if (shrinking.length) {
        L.push('_A page can reach more people than ever and still shed followers: the two are measured separately and move independently. Worth reading alongside "What did not land" rather than on its own._');
        L.push('');
      }
    }
  }

  // ---- Instagram -----------------------------------------------------------
  //
  // Same discipline as the Facebook sections above: views are summed, REACH IS
  // NOT. Two posts reaching 1,000 accounts each have not reached 2,000, and the
  // rule does not stop applying because the platform changed.
  const igWindow = (from, to) => igAll.filter((r) => {
    const t = Date.parse(r.timestamp);
    return !Number.isNaN(t) && t >= from && t < to;
  });
  const igThis = igWindow(now - 7 * DAY, now + DAY);
  const igLast = igWindow(now - 14 * DAY, now - 7 * DAY);
  const num = (v) => (v === null || v === undefined ? null : Number(v));
  const sum = (rows, k) => rows.reduce((a, r) => a + (num(r[k]) || 0), 0);
  const medOf = (rows, k) => median(rows.map((r) => num(r[k])).filter((v) => v !== null && !Number.isNaN(v)));

  if (igThis.length) {
    const accounts = new Set(igThis.map((r) => r.ig_username).filter(Boolean));
    const igViews = sum(igThis, 'views');
    const igSaves = sum(igThis, 'saved');
    const bestReach = [...igThis].sort((a, b) => (num(b.reach) || 0) - (num(a.reach) || 0))[0];
    const medViewsNow = medOf(igThis, 'views');
    const medViewsPrev = igLast.length ? medOf(igLast, 'views') : null;
    const igDelta = (medViewsPrev && medViewsNow !== null && medViewsPrev > 0)
      ? ((medViewsNow - medViewsPrev) / medViewsPrev) * 100 : null;

    L.push('## Instagram');
    L.push('');
    L.push(`- **${igThis.length} post${igThis.length > 1 ? 's' : ''}** across ${accounts.size} account${accounts.size === 1 ? '' : 's'}, ${n(igViews)} views in total`);
    if (bestReach && num(bestReach.reach)) {
      L.push(`- Best single post reached **${n(num(bestReach.reach))} accounts**`);
    }
    const igInteractions = sum(igThis, 'total_interactions');
    L.push(`- **${n(igSaves)} save${igSaves === 1 ? '' : 's'}** and ${n(igInteractions)} interaction${igInteractions === 1 ? '' : 's'}`);
    const medRate = medOf(igThis, 'interaction_rate_pct');
    if (medRate !== null) L.push(`- Typical post: ${pc(medRate)} interaction rate`);
    if (igDelta !== null) L.push(`- Typical post **${signed(igDelta)}** on views against the week before`);

    // The two metrics Meta serves for one product type and refuses for the
    // other: follows on FEED posts, watch time on REELS. Reported against the
    // count of posts that could carry them, never against all posts - dividing
    // feed follows by every post would understate it by roughly half.
    const igFeed = igThis.filter((r) => r.media_product_type === 'FEED');
    const igReels = igThis.filter((r) => r.media_product_type === 'REELS');
    const feedFollows = igFeed.filter((r) => num(r.follows) !== null);
    if (feedFollows.length) {
      const gained = feedFollows.reduce((a, r) => a + (num(r.follows) || 0), 0);
      L.push(`- **${n(gained)} new follower${gained === 1 ? '' : 's'}** came from ${feedFollows.length} feed post${feedFollows.length === 1 ? '' : 's'}`
        + `${igReels.length ? ` (Meta does not report this for the ${igReels.length} Reel${igReels.length === 1 ? '' : 's'})` : ''}`);
    }
    const watched = igReels.filter((r) => num(r.reels_avg_watch_seconds) !== null);
    if (watched.length) {
      const medWatch = median(watched.map((r) => num(r.reels_avg_watch_seconds)));
      L.push(`- Typical Reel held attention for **${medWatch.toFixed(1)}s** across ${watched.length} Reel${watched.length === 1 ? '' : 's'}`);
    }

    // Why the comparison may not mean what it looks like. On 3 Sep 2026 the
    // median fell 91% because ONE account published 63 posts the week before and
    // 32 this week, and its posts are an order of magnitude larger than the
    // other accounts'. Reported as a fall in performance that would have been
    // simply wrong. Same reasoning as changeNote() on the Facebook side.
    const igCaveats = [];
    if (igThis.length < 4 || igLast.length < 4) {
      igCaveats.push(`based on ${igThis.length} post${igThis.length === 1 ? '' : 's'} against ${igLast.length} the week before, which is too few for the change to mean much`);
    } else if (igLast.length) {
      const volShift = ((igThis.length - igLast.length) / igLast.length) * 100;
      if (Math.abs(volShift) >= 30) {
        igCaveats.push(`${igThis.length} posts this week against ${igLast.length} the week before, so the move partly reflects how much was published rather than how it performed`);
      }
    }
    // One account dominating the views makes the estate median its median.
    const byAccount = new Map();
    for (const r of igThis) {
      const k = r.ig_username || r.page_name || '—';
      byAccount.set(k, (byAccount.get(k) || 0) + (num(r.views) || 0));
    }
    const igViewsTotal = sum(igThis, 'views');
    const topAccount = [...byAccount.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!page && topAccount && igViewsTotal > 0 && topAccount[1] / igViewsTotal >= 0.6) {
      igCaveats.push(`${Math.round((topAccount[1] / igViewsTotal) * 100)}% of this week's Instagram views came from @${topAccount[0]}, so the estate figures largely describe that one account`);
    }
    if (igCaveats.length) L.push(`- _${igCaveats.join('; ')}._`);
    L.push('');

    if (bestReach) {
      const label = bestReach.ig_username ? `@${bestReach.ig_username}` : (bestReach.page_name || 'Instagram');
      const link = bestReach.permalink ? ` [See the post](${bestReach.permalink}).` : '';
      L.push(`The furthest-reaching was ${page ? '' : `${label}'s `}"${clean(bestReach.caption, 80)}" — ${n(num(bestReach.reach))} accounts reached${num(bestReach.views) ? `, ${n(num(bestReach.views))} views` : ''}.${link}`);
      L.push('');
    }

    // Saves per 1,000 reached, not raw saves. Raw saves just re-ranks by size,
    // and the interesting question is which post made people want to keep it.
    const saved = [...igThis]
      .filter((r) => num(r.saves_per_1k_reached) !== null && (num(r.reach) || 0) >= 500)
      .sort((a, b) => num(b.saves_per_1k_reached) - num(a.saves_per_1k_reached))[0];
    if (saved && bestReach && saved.media_id !== bestReach.media_id) {
      const label = saved.ig_username ? `@${saved.ig_username}` : (saved.page_name || 'Instagram');
      const link = saved.permalink ? ` [See the post](${saved.permalink}).` : '';
      L.push(`Most worth keeping: ${page ? '' : `${label}'s `}"${clean(saved.caption, 70)}" — **${Number(saved.saves_per_1k_reached).toFixed(1)} saves per 1,000 reached**, against ${n(num(saved.reach))} accounts reached.${link}`);
      L.push('');
      L.push('_Saving a post is a deliberate act in a way a like is not, so saves per 1,000 reached says which posts people wanted to come back to — regardless of how big the audience was._');
      L.push('');
    }

    // Held attention longest. Floored at 200 accounts reached, for the same
    // reason the saves callout is floored: on a handful of views an average
    // watch time is one person's behaviour, not a finding.
    // Skips whichever posts the two callouts above already used, so one strong
    // post cannot fill the section three times over.
    const alreadyShown = new Set([bestReach && bestReach.media_id, saved && saved.media_id].filter(Boolean));
    const held = [...igThis]
      .filter((r) => num(r.reels_avg_watch_seconds) !== null && (num(r.reach) || 0) >= 200)
      .filter((r) => !alreadyShown.has(r.media_id))
      .sort((a, b) => num(b.reels_avg_watch_seconds) - num(a.reels_avg_watch_seconds))[0];
    if (held) {
      const label = held.ig_username ? `@${held.ig_username}` : (held.page_name || 'Instagram');
      const link = held.permalink ? ` [See the post](${held.permalink}).` : '';
      L.push(`Held attention longest: ${page ? '' : `${label}'s `}"${clean(held.caption, 70)}" — **${Number(held.reels_avg_watch_seconds).toFixed(1)}s average watch**, ${n(num(held.reach))} accounts reached.${link}`);
      L.push('');
      L.push('_Watch time is the only completion signal Reels give us, and it exists for Reels alone — a feed post shows a dash rather than a zero._');
      L.push('');
    }
  } else if (igAll.length) {
    L.push('## Instagram');
    L.push('');
    L.push(`No Instagram posts published this week${page ? '' : ' on any collecting account'}. ${igAll.length} post${igAll.length > 1 ? 's are' : ' is'} held in total.`);
    L.push('');
  }

  L.push('## About these numbers');
  L.push('');
  L.push('- Organic only. Paid reach is reported separately and is not included here.');
  L.push('- Reactions, comments and shares are counted the same way Facebook counts them on the post itself, so they should match what you see. Any small difference is timing — these are taken once a night and people keep reacting.');
  L.push('- "Beyond your followers" is the share of views from people who do not follow the page — the closest thing to a measure of whether a post travelled.');
  if (igThis.length) {
    // "no follower breakdown" stopped being true on 7 Sept 2026, when follows
  // per FEED post started being collected - and this digest now prints that
  // figure a few lines above, so the caveat was contradicting the report.
  L.push('- Instagram is reported separately because the metrics differ: no paid split, but there are **saves**, which Facebook has no equivalent for, and followers gained per post — which Facebook does not report at all. Instagram reach counts accounts, not people.');
  }
  L.push('- Views can be added together; **people cannot**. Two posts reaching 1,000 people each have not reached 2,000 different people, so this digest never adds up reach across posts.');
  if (thisWeek.no_metrics) {
    L.push(`- ${thisWeek.no_metrics} post${thisWeek.no_metrics > 1 ? 's' : ''} this week returned no figures from Facebook and ${thisWeek.no_metrics > 1 ? 'are' : 'is'} left out entirely. That is a gap in what Facebook reported, not zero performance.`);
  }
  L.push(page
    ? `- Covers **${page.name}** only.`
    : `- Covers all **${pages.length}** pages currently collecting. A page missing from this list has not granted access yet.`);
  L.push('');
  L.push(`_Generated ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC from ${base.n} posts of collected history._`);

  const out = L.join('\n') + '\n';
  if (OUT) {
    fs.writeFileSync(OUT, out);
    console.error(`digest written to ${OUT} (${out.length} bytes)`);
  } else {
    process.stdout.write(out);
  }
}

main().catch((e) => { console.error('digest failed:', e.message); process.exit(1); });
