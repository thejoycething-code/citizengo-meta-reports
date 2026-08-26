'use strict';
// Metric and field sets, corrected by the Phase 0 probe on 2026-08-20 against
// the CitizenGO main page (434058216680321). Every verdict below is observed,
// not documented — see fixtures/.
//
// THE HEADLINE FINDING: reach is not dead. The Jun 2026 deprecation retired the
// old metric NAMES but the breakdown mechanism survived, so organic-vs-paid is
// still obtainable via post_media_view + breakdown=is_from_ads. The plan was
// written on the assumption this was gone. It is not.
//
// Metrics are probed ONE AT A TIME on purpose: the Graph API fails an entire
// /insights call if any single metric in the list is invalid, so a batched
// request would only tell you "something in here is dead".

// CONFIRMED RETIRED — all return "The value must be a valid insights metric".
// Kept in the probe so fixtures record the real error envelope.
const POST_METRICS_EXPECTED_DEAD = [
  'post_impressions',
  'post_impressions_unique',
  'post_impressions_organic',
  'post_impressions_organic_unique',
  'post_impressions_paid',
  'post_impressions_viral',
  'post_impressions_fan',
];

// CONFIRMED LIVE. Sample values from post 434058216680321_1517220967114396.
const POST_METRICS_CANDIDATE = [
  'post_total_media_view_unique',   // 569 — unique reach
  'post_media_view',               // 789 — total views
  'post_clicks',                   // 16
  'post_clicks_by_type',           // {other clicks:13, photo view:2, link clicks:1}
  'post_activity_by_action_type',  // {share:8, like:17}
  'post_reactions_by_type_total',  // {like:15, love:1, haha:1}
  'post_video_views',              // 0
  'post_video_views_organic',      // 0
];

// CONFIRMED LIVE — this is how paid/organic and follower/non-follower splits are
// recovered now that the dedicated metric names are gone.
//   is_from_ads:       [{789, "0"}, {0, "1"}]      -> organic vs paid
//   is_from_followers: [{683, "1"}, {106, "0"}]    -> followers vs reached beyond
const POST_BREAKDOWNS = ['is_from_ads', 'is_from_followers'];

// CONFIRMED RETIRED, 26 Aug 2026, tested live across 36 pages. All returned an
// error or an empty result. Listed so nobody spends another afternoon on them.
const CONFIRMED_RETIRED = [
  'post_video_retention_graph',
  'page_fans_country',
  'page_fans_city',
  'page_fans_locale',
  'page_fans_gender_age',
  'page_follows_by_country',
  'page_follows_by_city',
  'page_audience_country',
];

// Page level: 6 live, 2 retired. Consistent across all three probed pages.
const PAGE_METRICS_CANDIDATE = [
  'page_views_total',              // LIVE
  'page_total_media_view_unique',  // LIVE
  'page_media_view',               // LIVE
  'page_post_engagements',         // LIVE
  'page_follows',                  // LIVE
  'page_daily_follows',            // LIVE
  'page_impressions',              // RETIRED
  'page_fans',                     // RETIRED
];

const IG_MEDIA_METRICS_CANDIDATE = [
  'reach', 'views', 'saved', 'total_interactions', 'likes', 'comments', 'shares', 'impressions',
];

// Post-object fields readable with pages_read_engagement alone. Note `shares`
// IS here — share count comes free without the content permission.
const POST_FIELDS_SAFE = [
  'id',
  'created_time',
  'message',
  'permalink_url',
  'status_type',
  'is_published',
  'full_picture',
  'attachments{media_type,type}',
  'shares',
].join(',');

// These connection fields require pages_read_user_content — a non-review
// permission, but one the plan wrongly assumed we could avoid. Reactions are
// obtainable from post_reactions_by_type_total instead; COMMENT COUNTS ARE NOT,
// so this scope is required if comment counts are wanted.
const POST_FIELDS_GATED = [
  'comments.summary(true).limit(0)',
  'reactions.limit(0).summary(true).as(reactions_all)',
  'reactions.type(LOVE).limit(0).summary(true).as(reactions_love)',
].join(',');

const IG_MEDIA_FIELDS = [
  'id', 'caption', 'media_type', 'media_product_type', 'permalink',
  'timestamp', 'like_count', 'comments_count',
].join(',');

module.exports = {
  CONFIRMED_RETIRED,
  POST_METRICS_EXPECTED_DEAD,
  POST_METRICS_CANDIDATE,
  POST_BREAKDOWNS,
  PAGE_METRICS_CANDIDATE,
  IG_MEDIA_METRICS_CANDIDATE,
  POST_FIELDS_SAFE,
  POST_FIELDS_GATED,
  IG_MEDIA_FIELDS,
};
