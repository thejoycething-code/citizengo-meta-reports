'use strict';
// The rules that decide WHAT the X collector reads and what it costs. Pure
// functions, no I/O, so scripts/test-x.js can pin every one of them.
//
// X bills per resource RETURNED, not per request ($0.001 per own post,
// $0.010 per user lookup - docs.x.com/x-api/getting-started/pricing, 8 Sep
// 2026). So the cost of a collection is exactly the number of posts we ask it
// to hand back, and the schedule below is a cost decision as much as a data one.
//
// The schedule agreed in the scoping brief:
//   * every post is re-read DAILY for its first 7 days, which is where nearly
//     all growth happens;
//   * then ONCE more at about day 28, for the final value before X's 30-day
//     window on the private metric groups closes for good.
// At 30 accounts posting 3-8 times a day that is $22-58 a month. Re-reading the
// whole 30-day window daily would be $81-216 for the same final numbers.

const DAY_MS = 86_400_000;

// Prices, per resource, in USD. Overridable so the ledger can be re-priced if
// X changes the rate card without a code change.
const PRICES = {
  ownedPostRead: Number(process.env.X_PRICE_OWNED_POST_READ || 0.001),
  postRead: Number(process.env.X_PRICE_POST_READ || 0.005),
  userRead: Number(process.env.X_PRICE_USER_READ || 0.010),
};

// The window inside which X serves non_public/organic/promoted metrics. Stated
// as "the last 30 days" in X's docs; 29 leaves a day of slack for clock
// differences and a job that runs late, so we never ask for a private group on a
// post X will refuse.
const PRIVATE_WINDOW_DAYS = 29;

// Daily-read window and the final-read band, in days of post age.
const DAILY_DAYS = 7;
const FINAL_READ_FROM = 26;   // eligible for the final read from this age...
const FINAL_READ_TO = PRIVATE_WINDOW_DAYS;  // ...until the private window closes

function ageDays(createdAt, now = new Date()) {
  const t = createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt);
  return Math.floor((now.getTime() - t) / DAY_MS);
}

// The time window for the DAILY pass: everything created in the last N days.
// One timeline request (paginated) covers it; every post returned is one
// billable read, which is the intended spend.
function dailyWindow(now = new Date(), days = DAILY_DAYS) {
  return {
    start_time: new Date(now.getTime() - days * DAY_MS).toISOString(),
    end_time: null,
    label: `daily (last ${days} days)`,
  };
}

// Which already-known posts are due their FINAL read. DB-driven rather than a
// time-window slice, so a missed day does not lose a post's final value: a post
// is due when it has entered the band and its latest snapshot was taken before
// it did. Fetched by id (/2/tweets?ids=), 100 per call.
//
// rows: [{ post_id, created_at, last_collected_at }] where last_collected_at is
// the newest x_post_metrics.collected_at for the post, or null.
function dueForFinalRead(rows, now = new Date()) {
  const due = [];
  for (const r of rows) {
    const age = ageDays(r.created_at, now);
    if (age < FINAL_READ_FROM || age > FINAL_READ_TO) continue;
    if (!r.last_collected_at) { due.push(r.post_id); continue; }
    const ageAtLast = ageDays(r.created_at, new Date(r.last_collected_at));
    if (ageAtLast < FINAL_READ_FROM) due.push(r.post_id);
  }
  return due;
}

// Whether the private metric groups may be requested for posts of this age.
function privateWindowOpen(createdAt, now = new Date()) {
  return ageDays(createdAt, now) <= PRIVATE_WINDOW_DAYS;
}

// Batches of ids for /2/tweets?ids= (max 100 per request).
function chunk(ids, size = 100) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

// What a run should have cost, from what it counted. `owned` is true for the
// user-context reads of an account's own posts, which is everything the
// collector does; the higher rate exists only so the ledger can price a probe
// that read someone else's account.
function estimateCost({ postReads = 0, userReads = 0, owned = true }) {
  const post = (owned ? PRICES.ownedPostRead : PRICES.postRead) * postReads;
  return Math.round((post + PRICES.userRead * userReads) * 10000) / 10000;
}

// Projected monthly cost for the scheduled pattern, used by the health check
// to say "on this posting rate expect about $X" next to the actual spend.
function projectMonthly({ accounts, postsPerDay, dailyDays = DAILY_DAYS, finalReads = 1 }) {
  const readsPerPost = dailyDays + finalReads;
  const postReads = accounts * postsPerDay * readsPerPost * 30;
  const userReads = accounts * 30;
  return estimateCost({ postReads, userReads, owned: true });
}

// ---------------------------------------------------------------------------
// Link attribution. Which of a post's URLs are ours. Host-based, on the
// EXPANDED url X gives us (t.co is always the wrapper), so a cgo.ac short link
// is caught by its own host and a full petition URL by its domain.
// ---------------------------------------------------------------------------
const OUR_HOSTS = ['citizengo.org', 'hazteoir.org', 'cgo.ac', 'derechoavivir.org'];

function isOurHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return OUR_HOSTS.some((d) => h === d || h.endsWith('.' + d));
}

// entities.urls as X returns it: [{url, expanded_url, display_url, unwound_url?}]
function extractUrls(entities) {
  const list = (entities && Array.isArray(entities.urls)) ? entities.urls : [];
  const urls = [];
  const ours = [];
  for (const u of list) {
    if (!u) continue;
    const expanded = u.unwound_url || u.expanded_url || u.url || null;
    if (!expanded) continue;
    urls.push({ url: u.url || null, expanded_url: expanded, display_url: u.display_url || null });
    try {
      if (isOurHost(new URL(expanded).hostname)) ours.push(expanded);
    } catch (e) { /* not a URL we can parse; keep it in urls, not in ours */ }
  }
  return { urls, citizengo_urls: [...new Set(ours)] };
}

// UTM parameters from one of our links, for the attribution tools. Returns
// null when there are none; never throws on a malformed URL.
function utmOf(url) {
  try {
    const u = new URL(url);
    const out = {};
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'campaign']) {
      const v = u.searchParams.get(k);
      if (v) out[k] = v;
    }
    return Object.keys(out).length ? out : null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  PRICES, PRIVATE_WINDOW_DAYS, DAILY_DAYS, FINAL_READ_FROM, FINAL_READ_TO, OUR_HOSTS,
  ageDays, dailyWindow, dueForFinalRead, privateWindowOpen, chunk,
  estimateCost, projectMonthly, extractUrls, isOurHost, utmOf,
};
