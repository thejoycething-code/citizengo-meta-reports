'use strict';
// The rules that decide WHAT the X collector reads and what it costs. Pure
// functions, no I/O, so scripts/test-x.js can pin every one of them.
//
// X bills per resource RETURNED, not per request ($0.001 per own post,
// $0.010 per user lookup - docs.x.com/x-api/getting-started/pricing, 8 Sep
// 2026). So the cost of a collection is exactly the number of posts we ask it
// to hand back, and the schedule below is a cost decision as much as a data one.
//
// The schedule, agreed 30 Sep 2026 after the live probe:
//   * every post is read DAILY for days 0-7, where nearly all growth happens;
//   * then once at each CHECKPOINT: day 14, 28, 60 and 85.
// Day 28 is the insurance read: it sits inside X's DOCUMENTED 30-day window for
// private metrics, so if X ever enforces what it documents, link clicks are
// still captured. Days 60 and 85 rely on what X actually does today - private
// metrics served to ~89 days - and 85 leaves four days' slack before that.
// 12 reads per post: 18 accounts at 5 posts a day is $37.80 a month at the
// owned-read rate ($167.40 if X bills the ordinary rate).

const DAY_MS = 86_400_000;

// Prices, per resource, in USD. Overridable so the ledger can be re-priced if
// X changes the rate card without a code change.
const PRICES = {
  ownedPostRead: Number(process.env.X_PRICE_OWNED_POST_READ || 0.001),
  postRead: Number(process.env.X_PRICE_POST_READ || 0.005),
  userRead: Number(process.env.X_PRICE_USER_READ || 0.010),
};

// X's DOCUMENTED window for non_public/organic/promoted metrics is 30 days;
// 29 leaves a day of slack. What X actually served on 30 Sep 2026 was to ~89
// days (fixtures/x-2026-09-30-05/06-*). Both are kept: the documented one for
// the insurance read and the health check's "has X tightened?" alarm, the
// observed one as the ceiling for checkpoints.
const PRIVATE_WINDOW_DAYS = 29;
const OBSERVED_PRIVATE_DAYS = 89;

// Days 0-7 inclusive: an 8-day window, so a post is read on eight nights.
const DAILY_DAYS = 8;
// Checkpoint reads, in days of post age. See dueForCheckpoint.
const CHECKPOINTS = [14, 28, 60, 85];
const READS_PER_POST = DAILY_DAYS + CHECKPOINTS.length;   // 12

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

// The backfill window, CONTIGUOUS with the daily one. The groundwork ended the
// backfill at the private-metric cut-off (30 days), so a first run with a 7-day
// daily window and a backfill left posts aged 8-29 days in neither - and the
// final pass cannot rescue them, because it only revisits posts already held.
// Found on the first live dry run, 30 Sep 2026.
function backfillWindow(now = new Date(), backfillDays, dailyDays = DAILY_DAYS) {
  if (!(backfillDays > dailyDays)) return null;
  return {
    start_time: new Date(now.getTime() - backfillDays * DAY_MS).toISOString(),
    end_time: new Date(now.getTime() - dailyDays * DAY_MS).toISOString(),
  };
}

// How far back the daily pass reaches for an account we hold no posts for.
// Checkpoints only revisit posts already held, so a new account's first run
// must reach every post a checkpoint could still want - up to the observed
// private-metric ceiling - or its day-14/28/60/85 reads never happen.
function firstRunDays(heldPosts) {
  return heldPosts > 0 ? DAILY_DAYS : OBSERVED_PRIVATE_DAYS;
}

// Which held posts are due a checkpoint read. A post is due at checkpoint C
// when it has reached C, has not yet reached the next checkpoint, and its
// latest snapshot was taken before it reached C.
//
// That makes a missed night self-healing: a post whose day-14 read was missed
// is read at day 15, 16 or whenever the next run happens, up to day 27. The
// last checkpoint (85) is due until the observed ceiling (89); past that X
// serves only public metrics and the read is not worth the money.
//
// rows: [{ post_id, created_at, last_collected_at }] - last_collected_at is the
// newest x_post_metrics.collected_at for the post, or null if never read.
function checkpointFor(age) {
  let c = null;
  for (const cp of CHECKPOINTS) if (age >= cp) c = cp;
  return c;
}

function dueForCheckpoint(rows, now = new Date()) {
  const due = [];
  for (const r of rows) {
    const age = ageDays(r.created_at, now);
    if (age > OBSERVED_PRIVATE_DAYS) continue;
    const cp = checkpointFor(age);
    if (cp === null) continue;
    if (!r.last_collected_at) { due.push({ post_id: r.post_id, checkpoint: cp }); continue; }
    const ageAtLast = ageDays(r.created_at, new Date(r.last_collected_at));
    if (ageAtLast < cp) due.push({ post_id: r.post_id, checkpoint: cp });
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

// Projected steady-state monthly cost of the schedule, used by the health check
// to say "on this posting rate expect about $X" beside the actual spend.
// Steady state is reached from the third month, once posts reach day 60 and 85.
function projectMonthly({ accounts, postsPerDay, readsPerPost = READS_PER_POST, owned = true }) {
  const postReads = accounts * postsPerDay * readsPerPost * 30;
  const userReads = accounts * 30;
  return estimateCost({ postReads, userReads, owned });
}

// The realistic projection: one app-owner account at the owned rate, every
// other account at the ordinary rate. perAccount: [{ owned, postsPerDay }].
function projectMonthlyMixed(perAccount, readsPerPost = READS_PER_POST) {
  let total = 0;
  for (const a of perAccount) {
    total += estimateCost({ postReads: a.postsPerDay * readsPerPost * 30, userReads: 30, owned: Boolean(a.owned) });
  }
  return Math.round(total * 100) / 100;
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
    // status is the HTTP status X got when it last fetched the link: a 404 on
    // one of our petition links is a broken link in a live post.
    urls.push({ url: u.url || null, expanded_url: expanded, display_url: u.display_url || null,
      status: typeof u.status === 'number' ? u.status : null });
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
  PRICES, PRIVATE_WINDOW_DAYS, OBSERVED_PRIVATE_DAYS, DAILY_DAYS, CHECKPOINTS, READS_PER_POST, OUR_HOSTS,
  ageDays, dailyWindow, backfillWindow, firstRunDays, checkpointFor, dueForCheckpoint, privateWindowOpen, chunk,
  estimateCost, projectMonthly, projectMonthlyMixed, extractUrls, isOurHost, utmOf,
};
