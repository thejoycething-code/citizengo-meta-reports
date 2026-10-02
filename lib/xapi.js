'use strict';
// Minimal X API v2 client. No dependencies. Modelled on lib/graph.js: the token
// travels in a header, never a URL; a non-2xx answer is a RESULT, not an
// exception, because "X refused this field" is a finding the collector records.
//
// Two things Meta's client never needed:
//
//   * Resource counting. X bills per Post and per User RETURNED, so every
//     response is tallied here (data + includes) and surfaced to the caller,
//     which writes the count and the estimated cost to x_collection_runs.
//     The figure is ours, not X's; reconcile it against the developer console.
//
//   * Rate-limit headers. X returns x-rate-limit-remaining / -reset per
//     endpoint per 15 minutes. At our volume they should never bind, but a
//     collector that ignores them is the kind that one day loops on 429s and
//     runs up a bill, so they are read and a 429 waits for the reset.

const REDACTIONS = [
  [/Bearer [A-Za-z0-9._~+/=-]+/g, 'Bearer <redacted>'],
  [/"(access_token|refresh_token)"\s*:\s*"[^"]*"/g, '"$1":"<redacted>"'],
];

function redact(value) {
  let out = typeof value === 'string' ? value : JSON.stringify(value);
  for (const [re, sub] of REDACTIONS) out = out.replace(re, sub);
  return typeof value === 'string' ? out : JSON.parse(out);
}

// Field groups, exactly as X names them. The private three are requested only
// when the caller says the post window is open - see lib/xschedule.js.
//
// X bills per post or user RETURNED, not per field, so every field below costs
// nothing extra. Added 2 Oct 2026 after a live probe (fixtures/x-2026-10-02-
// fields-probe.json): note_tweet carries the FULL text of long posts - 6 of
// @CitizenGO's last 17 were long, and `text` alone stops at 280 characters -
// plus X's own topic labels, edit history, reply settings, video length and
// alt text, and profile fields. Expansions are a different matter: expanding
// referenced_tweets or mentions returns extra posts and users, which ARE
// billed, so none are requested beyond media.
const PUBLIC_TWEET_FIELDS = [
  'id', 'text', 'created_at', 'lang', 'conversation_id', 'in_reply_to_user_id',
  'referenced_tweets', 'entities', 'attachments', 'source', 'public_metrics',
  'note_tweet', 'context_annotations', 'edit_history_tweet_ids', 'possibly_sensitive', 'reply_settings',
];
const PRIVATE_TWEET_FIELDS = ['non_public_metrics', 'organic_metrics', 'promoted_metrics'];
const MEDIA_FIELDS_PUBLIC = ['media_key', 'type', 'public_metrics', 'duration_ms', 'alt_text',
  'preview_image_url', 'url', 'width', 'height'];
const MEDIA_FIELDS_PRIVATE = ['non_public_metrics', 'organic_metrics'];
const USER_FIELDS = ['id', 'username', 'name', 'public_metrics', 'created_at', 'verified_type',
  'description', 'location', 'url', 'pinned_tweet_id', 'profile_image_url', 'subscription_type'];

// The expansion is attachments.media_KEYS. The groundwork asked for
// attachments.media_ids, which X accepts without complaint and answers with no
// includes.media at all - so every video_views was null. Found by the first
// live probe, 30 Sep 2026.
const MEDIA_EXPANSION = 'attachments.media_keys';

function countResources(body) {
  const posts = (Array.isArray(body && body.data) ? body.data.length : (body && body.data ? 1 : 0))
    + (body && body.includes && Array.isArray(body.includes.tweets) ? body.includes.tweets.length : 0);
  const users = body && body.includes && Array.isArray(body.includes.users) ? body.includes.users.length : 0;
  return { posts, users };
}

// X answers a request for a metric group it will not serve on a given post with
// a partial error per FIELD, not per group. Two kinds are expected on every run
// and say nothing about the collection's health:
//   * promoted_metrics on a post that was never boosted (5 per post);
//   * any private group on a retweet (X serves none for retweets).
// On the first live probe these were 251 notices for 37 posts. They are
// dropped before anything is stored; everything else is kept.
function expectedRefusal(e) {
  if (!e) return false;
  const d = String(e.detail || '');
  // Not a refusal but equally harmless: X could not look up a field on the
  // OTHER side of a post - on the full-history backfill of 30 Sep 2026, the
  // in_reply_to_user_id of old replies to since-deleted accounts, dozens per
  // account. It names that user, not our post, so it never attached to a
  // stored row; it only filled the log. The title varies, so match the wording.
  if (/could not be fully resolved for this request/.test(d)) return true;
  if (e.title !== 'Disallowed Resource') return false;
  if (/^The 'promoted_metrics\./.test(d)) return true;
  if (/cannot be queried for Retweets\.?$/.test(d)) return true;
  // Private groups on an old post. The wording says 30 days; the live cutoff on
  // 30 Sep 2026 was between 76 and 90 days (fixtures/x-2026-09-30-06-*). Either
  // way it is X declining, not us failing, and public metrics still arrive.
  if (/cannot be queried for Tweets older than \d+ days\.?$/.test(d)) return true;
  return false;
}

function makeClient({ token, host } = {}) {
  require('./env-guard').assertXHostSafe();
  const base = (host || process.env.X_API_HOST || 'https://api.x.com').replace(/\/+$/, '');
  const tally = { calls: 0, postReads: 0, userReads: 0, waits: 0 };

  async function get(pathname, params = {}, opts = {}) {
    const url = new URL(base + pathname);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const started = Date.now();
    let res;
    let body;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${opts.token || token}` } });
      const text = await res.text();
      body = text ? JSON.parse(text) : null;
    } catch (err) {
      tally.calls += 1;
      return { ok: false, status: 0, request: redact(url.toString()), transport_error: String(err),
        elapsed_ms: Date.now() - started, body: null, errors: null, rate: null };
    }
    tally.calls += 1;
    const rate = {
      limit: Number(res.headers.get('x-rate-limit-limit')) || null,
      remaining: res.headers.get('x-rate-limit-remaining') === null ? null : Number(res.headers.get('x-rate-limit-remaining')),
      reset: Number(res.headers.get('x-rate-limit-reset')) || null,   // epoch seconds
    };
    // 5xx is X's side and usually brief (a 503 hit the first live probe on
    // 30 Sep 2026). Two retries, 2s then 6s. A 4xx is never retried: it means
    // the request or the credential is wrong and must fail visibly.
    if (res.status >= 500 && (opts._tries || 0) < 2) {
      const n = (opts._tries || 0) + 1;
      tally.retries = (tally.retries || 0) + 1;
      await new Promise((r) => setTimeout(r, n === 1 ? (opts._backoffMs ?? 2000) : (opts._backoffMs ?? 6000)));
      return get(pathname, params, { ...opts, _tries: n });
    }
    // A 429 is not a finding to record - it is a wait. Once, for the stated
    // reset (capped at 15 minutes), then the same request again; a second 429
    // is returned to the caller so nothing loops.
    if (res.status === 429 && !opts._retried) {
      const waitMs = Math.min(Math.max((rate.reset || 0) * 1000 - Date.now(), 1000), 15 * 60_000);
      tally.waits += 1;
      await new Promise((r) => setTimeout(r, waitMs));
      return get(pathname, params, { ...opts, _retried: true });
    }
    const counted = countResources(body);
    // Only successful responses are billable resources.
    if (res.ok) { tally.postReads += opts.countAs === 'user' ? 0 : counted.posts; tally.userReads += opts.countAs === 'user' ? (Array.isArray(body && body.data) ? body.data.length : 1) : counted.users; }
    return {
      ok: res.ok,
      status: res.status,
      request: redact(url.toString()),
      elapsed_ms: Date.now() - started,
      rate,
      // X returns partial errors alongside data (e.g. a field refused on one
      // post); on a failed request the same array carries the reason.
      errors: body && Array.isArray(body.errors) ? body.errors : null,
      title: body && body.title ? String(body.title) : null,
      detail: body && body.detail ? String(body.detail) : null,
      body: res.ok ? body : null,
      resources: counted,
    };
  }

  // The authenticated user - the one lookup that tells us which account a
  // token belongs to. One billable User read.
  async function me(opts = {}) {
    return get('/2/users/me', { 'user.fields': USER_FIELDS.join(',') }, { ...opts, countAs: 'user' });
  }

  // One page of an account's own posts. Pass privateWindow=true only when
  // every post that can come back is inside the 30-day window - X refuses the
  // private groups on older posts and the refusal can take the request with it.
  async function userPosts(userId, { start_time, end_time, pagination_token, max_results = 100, privateWindow = false, excludeRetweets = false } = {}, opts = {}) {
    const tweetFields = privateWindow ? [...PUBLIC_TWEET_FIELDS, ...PRIVATE_TWEET_FIELDS] : PUBLIC_TWEET_FIELDS;
    const mediaFields = privateWindow ? [...MEDIA_FIELDS_PUBLIC, ...MEDIA_FIELDS_PRIVATE] : MEDIA_FIELDS_PUBLIC;
    return get(`/2/users/${userId}/tweets`, {
      max_results: Math.min(Math.max(Number(max_results) || 100, 5), 100),
      start_time, end_time, pagination_token,
      exclude: excludeRetweets ? 'retweets' : undefined,
      'tweet.fields': tweetFields.join(','),
      expansions: MEDIA_EXPANSION,
      'media.fields': mediaFields.join(','),
    }, opts);
  }

  // Specific posts by id, up to 100 - the final-read path.
  async function postsByIds(ids, { privateWindow = false } = {}, opts = {}) {
    const tweetFields = privateWindow ? [...PUBLIC_TWEET_FIELDS, ...PRIVATE_TWEET_FIELDS] : PUBLIC_TWEET_FIELDS;
    const mediaFields = privateWindow ? [...MEDIA_FIELDS_PUBLIC, ...MEDIA_FIELDS_PRIVATE] : MEDIA_FIELDS_PUBLIC;
    return get('/2/tweets', {
      ids: ids.slice(0, 100).join(','),
      'tweet.fields': tweetFields.join(','),
      expansions: MEDIA_EXPANSION,
      'media.fields': mediaFields.join(','),
    }, opts);
  }

  return { get, me, userPosts, postsByIds, tally, base };
}

module.exports = {
  makeClient, redact, countResources, expectedRefusal,
  PUBLIC_TWEET_FIELDS, PRIVATE_TWEET_FIELDS, USER_FIELDS, MEDIA_EXPANSION,
};
