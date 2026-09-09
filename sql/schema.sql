-- Run once in Supabase: left menu > SQL Editor > New query > paste > Run.
--
-- Column set is derived from the Phase 0 probe (fixtures/), not from Meta's
-- documentation. Notably: reach and the organic/paid split DO still exist, via
-- post_media_view breakdowns, even though every post_impressions* metric is
-- retired. See README.md.

-- ---------------------------------------------------------------------------
-- Pages we collect from.
-- ---------------------------------------------------------------------------
create table if not exists public.meta_pages (
  page_id          text primary key,
  name             text not null,
  platform         text not null default 'facebook',   -- 'facebook' | 'instagram'
  business_id      text,
  business_name    text,
  country          text,
  ig_user_id       text,
  followers_count  bigint,
  is_active        boolean not null default true,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Per-page tokens. One row per page rather than one global token, because the
-- Pages sit across 12+ Business Managers with no common owner — a dead token
-- must stale one page, not break the whole run.
--
-- The collector currently derives page tokens at runtime from
-- /me/accounts?fields=access_token, so this table is optional until Phase 3
-- brings in System Users that the operator's own token cannot reach.
-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- Posts. Metadata only — every number lives in meta_post_metrics.
-- These fields are all readable with pages_read_engagement alone; the post
-- object's reactions/comments connections are NOT (they need
-- pages_read_user_content) and deliberately do not appear here.
-- ---------------------------------------------------------------------------
create table if not exists public.meta_posts (
  post_id        text primary key,
  page_id        text not null references public.meta_pages(page_id),
  created_time   timestamptz not null,
  message        text,
  permalink_url  text,
  status_type    text,
  media_type     text,
  -- Stable path only, query string stripped. Meta's signed CDN URLs rotate
  -- every request and expire, so this is a media identity key for dedup, NOT a
  -- URL you can load. Thumbnails must be fetched fresh at render time.
  full_picture   text,
  is_published   boolean,
  -- Destination of a link post, from attachments.unshimmed_url. Null for
  -- photos, videos and text posts. Facebook-internal URLs are deliberately
  -- discarded: a photo attachment points back at the post itself, and recording
  -- that as an outbound link would corrupt any analysis of what we link to.
  link_url       text,
  first_seen_at  timestamptz not null default now()
);

create index if not exists meta_posts_page_created_idx
  on public.meta_posts (page_id, created_time desc);

-- ---------------------------------------------------------------------------
-- Metrics, append-only: one row per post per collection date. Engagement keeps
-- accruing for days after publish, so a time series is what makes "which posts
-- have legs" answerable — a single snapshot cannot.
-- ---------------------------------------------------------------------------
create table if not exists public.meta_post_metrics (
  id                        bigint generated always as identity primary key,
  post_id                   text not null references public.meta_posts(post_id),
  page_id                   text not null references public.meta_pages(page_id),
  collected_date            date not null,
  collected_at              timestamptz not null default now(),

  -- Reach and views. post_impressions* are all retired; these are the survivors.
  views_total               bigint,   -- post_media_view
  views_unique              bigint,   -- post_total_media_view_unique; NULL is normal,
                                      -- Meta returns #200 on low-follower pages
  views_organic             bigint,   -- post_media_view breakdown is_from_ads = "0"
  views_paid                bigint,   -- post_media_view breakdown is_from_ads = "1"
  views_from_followers      bigint,   -- breakdown is_from_followers = "1"
  views_from_nonfollowers   bigint,   -- breakdown is_from_followers = "0"

  -- Engagement, from post_reactions_by_type_total (NOT the gated post fields).
  reactions_total           bigint,
  reactions_like            bigint,
  reactions_love            bigint,
  reactions_wow             bigint,
  reactions_haha            bigint,
  reactions_sorry           bigint,
  reactions_anger           bigint,

  shares_total              bigint,   -- from the post object's `shares` field
  clicks_total              bigint,   -- post_clicks
  clicks_by_type            jsonb,    -- post_clicks_by_type
  activity_by_type          jsonb,    -- post_activity_by_action_type
  video_views               bigint,   -- post_video_views
  -- Several pages are majority reels, and a view count alone says nothing about
  -- whether anyone actually watched.
  video_view_time_ms        bigint,   -- post_video_view_time
  video_avg_seconds_watched numeric,  -- post_video_avg_time_watched, ms converted to seconds
  video_complete_views_30s  bigint,   -- post_video_complete_views_30s
  -- NOTE: post_video_retention_graph is retired. Confirmed 26 Aug 2026 - it
  -- returned nothing on any video post across 36 pages. Not collected.

  -- Requires pages_read_user_content, which the pilot token lacked. Stays NULL
  -- until that scope is granted.
  comments_total            bigint,

  -- Which metrics failed for this row, so a partial collection is visible as
  -- partial rather than silently reading as zero.
  errors                    jsonb,
  -- Video posts only (media_type = 'video'), added 7 Sept 2026 after
  -- scripts/probe-coverage.js found them available. Null on a photo means
  -- "not a video", never "no paid views".
  video_views_organic         bigint,
  video_views_paid            bigint,
  video_views_by_distribution jsonb
);

-- Makes reruns idempotent: a second run on the same day updates in place.
-- Named columns (not an expression) so PostgREST's on_conflict can target it.
create unique index if not exists meta_post_metrics_post_day_key
  on public.meta_post_metrics (post_id, collected_date);

create index if not exists meta_post_metrics_page_date_idx
  on public.meta_post_metrics (page_id, collected_date desc);

-- ---------------------------------------------------------------------------
-- Page-level daily insights: how the PAGE is doing, rather than how individual
-- posts did. Answers "are we growing".
--
-- Unlike post insights, one call returns a value PER DAY, so six calls fill the
-- whole window for a page - far cheaper than nine calls per post.
--
-- Columns are named after the Meta metric that fills them rather than an
-- interpretation: the exact difference between page_follows and
-- page_daily_follows is not clearly documented, and a wrong label would be
-- worse than a literal one.
-- ---------------------------------------------------------------------------
create table if not exists public.meta_page_metrics (
  id                 bigint generated always as identity primary key,
  page_id            text not null references public.meta_pages(page_id),
  -- The day the value DESCRIBES. Meta returns end_time - the instant the day
  -- closed, always 07:00:00+0000, midnight Pacific and its own account-day
  -- boundary, not the page's. The collector subtracts a day before storing, so
  -- a calendar filter here is read literally. Re-dated on 9 Sept 2026: rows
  -- previously carried the end_time date, which made every month total wrong at
  -- both ends (the UK page's July read 1,693,933 against the API's 1,700,950).
  metric_date        date not null,

  views_total        bigint,   -- page_views_total
  media_view         bigint,   -- page_media_view
  media_view_unique  bigint,   -- page_total_media_view_unique
  post_engagements   bigint,   -- page_post_engagements
  follows            bigint,   -- page_follows
  daily_follows      bigint,   -- page_daily_follows

  -- Off the page object, not an insights metric: page_fans was retired, so this
  -- is the only reliable follower figure available.
  followers_snapshot bigint,

  collected_at       timestamptz not null default now(),
  errors             jsonb,
  -- Added 7 Sept 2026. daily_unfollows is the one that changes an answer
  -- rather than adding a column: follows were counted from the start and
  -- unfollows never were, so net growth was unknowable, not merely uncertain.
  -- meta_page_growth derives net_follows from the pair.
  daily_unfollows        bigint,
  daily_follows_unique   bigint,
  video_views            bigint,
  video_view_time_ms     bigint,
  -- Object per day, not a number - see PAGE_OBJECT_METRICS in collect.js.
  post_reactions_by_type jsonb
);

create unique index if not exists meta_page_metrics_page_day_key
  on public.meta_page_metrics (page_id, metric_date);

create index if not exists meta_page_metrics_date_idx
  on public.meta_page_metrics (metric_date desc);

alter table public.meta_page_metrics enable row level security;

-- Daily follower change is computed, not stored, so it cannot drift out of step
-- with the snapshots it derives from.
create or replace view public.meta_page_growth as
select
  m.page_id,
  g.name as page_name,
  m.metric_date,
  m.followers_snapshot,
  m.followers_snapshot - lag(m.followers_snapshot)
    over (partition by m.page_id order by m.metric_date) as followers_change,
  m.views_total,
  m.media_view,
  m.media_view_unique,
  m.post_engagements,
  m.daily_follows,
  m.daily_unfollows,
  -- The number daily_follows could never give on its own.
  case when m.daily_follows is null and m.daily_unfollows is null then null
       else coalesce(m.daily_follows, 0) - coalesce(m.daily_unfollows, 0)
  end as net_follows,
  m.daily_follows_unique,
  m.video_views,
  m.video_view_time_ms,
  m.post_reactions_by_type
from public.meta_page_metrics m
join public.meta_pages g on g.page_id = m.page_id;

-- ---------------------------------------------------------------------------
-- INSTAGRAM. Separate tables rather than forced into meta_posts: IG media has
-- no share count on the object, has `saved` (no Facebook equivalent, and the
-- strongest intent signal on the platform), and uses different metric names.
-- IG insights survived Meta's 2025-2026 deprecations far better than Facebook's.
-- ---------------------------------------------------------------------------
create table if not exists public.meta_ig_media (
  media_id           text primary key,
  page_id            text not null references public.meta_pages(page_id),
  ig_user_id         text not null,
  ig_username        text,
  media_type         text,   -- IMAGE | VIDEO | CAROUSEL_ALBUM
  media_product_type text,   -- FEED | REELS | STORY
  caption            text,
  permalink          text,
  thumbnail_url      text,
  timestamp          timestamptz not null,
  first_seen_at      timestamptz not null default now()
);

create index if not exists meta_ig_media_page_time_idx
  on public.meta_ig_media (page_id, timestamp desc);

create table if not exists public.meta_ig_media_metrics (
  id                 bigint generated always as identity primary key,
  media_id           text not null references public.meta_ig_media(media_id),
  page_id            text not null references public.meta_pages(page_id),
  collected_date     date not null,
  collected_at       timestamptz not null default now(),
  reach              bigint,
  views              bigint,
  saved              bigint,
  total_interactions bigint,
  likes              bigint,
  comments           bigint,
  shares             bigint,
  errors             jsonb,
  -- FEED posts only, and null everywhere else - see the FOLLOWERS GAINED PER
  -- POST note below. Null means "not offered for this media product type",
  -- never zero, so filter to media_product_type = 'FEED' before aggregating.
  --
  -- Listed after errors because that is where production has them: they were
  -- added by migration on 7 Sept 2026, and a rebuild from this file should
  -- reproduce the real column order rather than a tidier one.
  follows            bigint,
  profile_visits     bigint,
  profile_activity   bigint,
  -- REELS only, and the mirror of the three FEED-only columns above: Meta
  -- refuses these on a FEED post. The only watch-through signal Reels have -
  -- clips_replays_count, ig_reels_aggregated_all_plays_count and thruplays are
  -- all rejected. Milliseconds as reported; meta_ig_latest derives seconds.
  reels_avg_watch_time_ms   bigint,
  reels_total_watch_time_ms bigint
);

create unique index if not exists meta_ig_media_metrics_day_key
  on public.meta_ig_media_metrics (media_id, collected_date);

-- One row per Instagram post at its LATEST collection, with the two derived
-- rates the tools quote. Recorded here 3 Sep 2026: the view existed in the
-- database and was granted to meta_readonly, but had never been written down,
-- so a rebuild from this file would have produced a database the MCP tools and
-- the Sheet mirror could not read.
--
-- INNER JOIN on metrics, deliberately: a media row with no metrics yet has
-- nothing to report, and showing it with every figure blank invites reading a
-- collection gap as zero performance.
create or replace view public.meta_ig_latest as
  select m.media_id, m.page_id, g.name as page_name, m.ig_username,
         m.media_type, m.media_product_type, m.caption, m.permalink, m."timestamp",
         x.collected_date, x.reach, x.views, x.saved, x.total_interactions,
         x.likes, x.comments, x.shares,
         case when coalesce(x.reach, 0) > 0
              then round(coalesce(x.total_interactions, 0)::numeric / x.reach::numeric * 100, 2)
         end as interaction_rate_pct,
         case when coalesce(x.reach, 0) > 0
              then round(coalesce(x.saved, 0)::numeric / x.reach::numeric * 1000, 2)
         end as saves_per_1k_reached,
         -- Appended after the derived rates, not beside the other raw metrics:
         -- create or replace view cannot insert a column mid-list, and dropping
         -- the view would take its grant to meta_readonly with it. Every
         -- consumer reads select=*, so position carries no meaning.
         x.follows, x.profile_visits, x.profile_activity,
         x.reels_avg_watch_time_ms,
         x.reels_total_watch_time_ms,
         -- Seconds, because nobody reasons about watch time in milliseconds.
         round(x.reels_avg_watch_time_ms::numeric / 1000, 1) as reels_avg_watch_seconds
    from public.meta_ig_media m
    join public.meta_pages g on g.page_id = m.page_id
    join public.meta_ig_media_metrics x on x.media_id = m.media_id
   where x.collected_date = (select max(y.collected_date)
                               from public.meta_ig_media_metrics y
                              where y.media_id = m.media_id);

-- ---------------------------------------------------------------------------
-- INSTAGRAM ACCOUNT level, per day. Nothing was collected here before
-- 7 Sept 2026: Facebook follower growth was charted and Instagram had no
-- equivalent, while collector/instagram.js was already fetching the account's
-- followers_count and media_count on every run and discarding both.
--
-- Two kinds of column, and the split is forced by the API rather than chosen.
-- follower_count and reach are served as a daily time series, so one call fills
-- the whole window and old rows have real values. Everything else is served
-- only as a single total_value: passing since/until returns one number for the
-- range, not one per day, so those are collected for the current day only and
-- are null on older rows. That is a genuine gap, not a collection failure.
--
-- Instagram serves account insights for roughly the last 30 days, unlike
-- Facebook page insights which go back years. This table therefore cannot be
-- backfilled the way the post tables can - which is the reason to start
-- filling it now rather than when it is next wanted.
create table if not exists public.meta_ig_account_metrics (
  id                    bigint generated always as identity primary key,
  ig_user_id            text not null,
  page_id               text not null references public.meta_pages(page_id),
  ig_username           text,
  metric_date           date not null,
  collected_at          timestamptz not null default now(),
  -- Point-in-time totals from the account object, not from insights.
  followers_snapshot    bigint,
  media_count           bigint,
  -- Daily series, dated the day the value DESCRIBES (see meta_page_metrics:
  -- Meta's end_time is when the day closed, so the collector subtracts a day).
  -- ONLY these two are dated that way - everything below is keyed to the
  -- collection date, which is why the two groups must never be shifted
  -- together. Re-dated on 9 Sept 2026, series columns only.
  follower_count        bigint,
  reach                 bigint,
  -- total_value only: current day, null on older rows.
  views                 bigint,
  profile_views         bigint,
  website_clicks        bigint,
  accounts_engaged      bigint,
  total_interactions    bigint,
  replies               bigint,
  follows_and_unfollows jsonb,
  errors                jsonb
);

create unique index if not exists meta_ig_account_metrics_day_key
  on public.meta_ig_account_metrics (ig_user_id, metric_date);
create index if not exists meta_ig_account_metrics_page
  on public.meta_ig_account_metrics (page_id, metric_date desc);

alter table public.meta_ig_account_metrics enable row level security;
revoke all on public.meta_ig_account_metrics from anon, authenticated;
grant select on public.meta_ig_account_metrics to meta_readonly;
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- METRICS THAT DO NOT EXIST ON v23.0. Probed live 7 Sept 2026 by
-- scripts/probe-coverage.js, with the metrics we do collect passing alongside
-- as controls. Every one of these returns "must be a valid insights metric" or
-- an equivalent rejection - they are gone, not unpermitted, so re-adding one on
-- the strength of a documentation page or an old tutorial will just fail:
--
--   post_negative_feedback(_unique|_by_type|_by_type_unique), post_engaged_users,
--   post_engaged_fan, post_consumptions(_by_type), post_impressions(_unique),
--   post_video_views_unique, post_video_views_10s, post_video_social_actions,
--   page_fans, page_fan_adds(_unique), page_fan_removes(_unique),
--   page_negative_feedback(_by_type), page_impressions(_unique),
--   clips_replays_count, ig_reels_aggregated_all_plays_count, navigation,
--   thruplays, online_followers
--
-- Worth noting what this costs us: negative feedback is gone at both post and
-- page level, so hides, unfollow-from-post and spam reports are unmeasurable.
-- A post that reaches well and quietly costs followers looks identical to one
-- that does not, and no combination of the surviving metrics recovers it.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- AUDIENCE DEMOGRAPHICS: NOT COLLECTED. Confirmed retired by Meta, 26 Aug 2026,
-- tested live across 36 pages. Seven metrics attempted per page -
-- page_fans_country, page_fans_city, page_fans_locale, page_fans_gender_age,
-- page_follows_by_country, page_follows_by_city, page_audience_country - and
-- every one returned an error or an empty object. Do not re-add without
-- re-probing first; the table shape is in git history at 72a5656.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- FOLLOWERS GAINED PER POST: NOT AVAILABLE. Followers are held per page per day
-- only (follows, daily_follows, followers_snapshot above). Do not try to
-- attribute the daily change to a post: across 3,557 page-days with a non-zero
-- change, only 16% had exactly one post that day and 67% had none at all, and
-- the median absolute daily change is 0 on both single-post and no-post days -
-- the per-post signal is smaller than the noise floor.
--
-- FACEBOOK: settled. Probed live on v23.0, 7 Sept 2026 - post_follows,
-- post_new_followers, post_fan_adds, post_page_follows and
-- post_follows_unique all return "must be a valid insights metric" while the
-- controls pass, so the metric does not exist rather than being unpermitted.
--
-- INSTAGRAM: it DOES exist, on FEED posts only. Same probe, same day: a FEED
-- post returned follows=3, profile_visits=46, profile_activity=39, while a
-- REELS post from the same account rejected all three with "does not support
-- ... for this media product type". So per-post follower attribution is
-- available for a subset of Instagram and nothing else - worth collecting, but
-- any figure built on it covers IG FEED alone and must say so.
--
-- COLLECTED since 7 Sept 2026, for FEED posts only: the three columns on
-- meta_ig_media_metrics above, filled from IG_FEED_METRICS in
-- collector/instagram.js. The request is GATED on media_product_type = 'FEED'
-- rather than attempted and caught, because attempting it would produce three
-- guaranteed failures on every Reel and bury the real errors in noise.
--
-- Reading these: null is "not offered for this product type", never zero. Any
-- followers-per-post figure covers Instagram FEED alone and has to say so - a
-- number blended across Facebook and Reels would be mostly invented.
--
-- Re-run scripts/probe-follower-metrics.js (Actions -> "Probe follower
-- metrics") whenever GRAPH_VERSION moves; Meta adds and retires metrics
-- between versions, and this answer is version-specific.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- AD SPEND against organic posts. Own table because one post can be promoted by
-- several ads. Joined via the ad creative's effective_object_story_id, which IS
-- the page post id - so a boosted post appears in both datasets under one key.
-- ---------------------------------------------------------------------------
create table if not exists public.meta_post_ad_spend (
  id            bigint generated always as identity primary key,
  post_id       text not null,
  page_id       text references public.meta_pages(page_id),
  ad_id         text not null,
  ad_account_id text,
  campaign_name text,
  spend         numeric,
  currency      text,
  impressions   bigint,
  reach         bigint,
  date_start    date,
  date_stop     date,
  collected_at  timestamptz not null default now()
);

create unique index if not exists meta_post_ad_spend_key
  on public.meta_post_ad_spend (ad_id, date_start, date_stop);

create index if not exists meta_post_ad_spend_post_idx
  on public.meta_post_ad_spend (post_id);

alter table public.meta_ig_media          enable row level security;
alter table public.meta_ig_media_metrics  enable row level security;
alter table public.meta_page_demographics enable row level security;
alter table public.meta_post_ad_spend     enable row level security;

-- ---------------------------------------------------------------------------
-- Run log. Non-negotiable: a silent partial failure that looks like
-- "engagement dropped" is worse than having no data at all.
-- ---------------------------------------------------------------------------
create table if not exists public.meta_collection_runs (
  id              bigint generated always as identity primary key,
  run_id          text not null,
  page_id         text,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  status          text not null default 'running',   -- running | ok | partial | failed
  posts_seen      integer default 0,
  metrics_written integer default 0,
  api_calls       integer default 0,
  error_code      integer,
  error_message   text
);

create index if not exists meta_collection_runs_page_idx
  on public.meta_collection_runs (page_id, started_at desc);

-- ---------------------------------------------------------------------------
-- Lock everything. RLS on with NO policies means the public "anon" key can do
-- nothing at all; only the server-side service_role key can read or write.
-- Same approach as clacton_actions. The database is never exposed to the web.
-- ---------------------------------------------------------------------------
alter table public.meta_pages            enable row level security;
alter table public.meta_posts            enable row level security;
alter table public.meta_post_metrics     enable row level security;
alter table public.meta_collection_runs  enable row level security;

-- Defence in depth on top of RLS. RLS alone does block anon (verified with a
-- canary row: 0 rows visible), but the SELECT grant makes these tables part of
-- the public PostgREST surface, so one careless policy added later would expose
-- them. Nothing here is exposed to the web: the collector writes with the
-- tokens. Only the server-side service_role needs any access.
revoke all on public.meta_pages           from anon, authenticated;
revoke all on public.meta_posts           from anon, authenticated;
revoke all on public.meta_post_metrics    from anon, authenticated;
revoke all on public.meta_collection_runs from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Convenience view for the dashboard, the MCP tools and the spreadsheet
-- export: latest snapshot per post, with engagement rate against the reach
-- figure that still exists. (The nightly Sheet mirror was retired 8 Sept 2026;
-- exports are on demand. See collector/sync-sheet.js.)
-- ---------------------------------------------------------------------------
create or replace view public.meta_post_latest as
select
  p.post_id,
  p.page_id,
  g.name as page_name,
  p.created_time,
  p.message,
  p.permalink_url,
  p.status_type,
  p.media_type,
  m.collected_date,
  m.views_total,
  m.views_unique,
  m.views_organic,
  m.views_paid,
  m.views_from_followers,
  m.views_from_nonfollowers,
  m.reactions_total,
  m.shares_total,
  m.clicks_total,
  m.comments_total,
  case when coalesce(m.views_total, 0) > 0
       then round(((coalesce(m.reactions_total,0) + coalesce(m.shares_total,0)
                    + coalesce(m.clicks_total,0))::numeric / m.views_total) * 100, 2)
  end as engagement_rate_pct,
  -- Appended, not slotted in beside the other view columns: create or replace
  -- view cannot insert a column mid-list.
  m.video_views_organic,
  m.video_views_paid,
  m.video_views_by_distribution
from public.meta_posts p
join public.meta_pages g on g.page_id = p.page_id
join public.meta_post_metrics m on m.post_id = p.post_id
where m.collected_date = (
  select max(m2.collected_date) from public.meta_post_metrics m2 where m2.post_id = p.post_id
);

-- CRITICAL, and not the default. A Postgres view executes with its OWNER's
-- privileges unless security_invoker is on, which makes it SECURITY DEFINER and
-- lets it read straight past the base tables' RLS. On a project whose anon key
-- is embedded in a public web page, that turns this view into an
-- internet-readable window onto internal performance data. Supabase's linter
-- reports it as an ERROR-level finding.
alter view public.meta_post_latest set (security_invoker = on);
revoke all on public.meta_post_latest from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 29 Aug 2026. meta_page_tokens was DROPPED. It held 0 rows for its entire life:
-- the collector reads tokens from the META_TOKENS secret, never from a table.
-- An empty table named "tokens" sitting on the public API surface invites
-- exactly the wrong kind of attention for no benefit.
--
-- Also on this date, clacton_actions and clacton_events were moved to the
-- `private` schema. PostgREST only serves schemas it is configured to expose, so
-- they are now unreachable over the API by ANY key, service key included. The
-- rows are intact (2,192 and 154) and the move reverses with
--   alter table private.clacton_actions set schema public;
-- The Clacton campaign closed on 7 August and its app is down.

-- ---------------------------------------------------------------------------
-- Added 30 Aug 2026 after the security review.
--
-- Brute-force protection that survives a cold start. The in-memory limiter in
-- lib/guard.js counts failures per warm serverless instance, and Vercel recycles
-- instances freely, so a patient attacker gets a fresh allowance every time one
-- is replaced.
--
-- Only FAILURES are written, so successful traffic pays no write cost and the
-- table stays small. The source is stored as a SHA-256 prefix rather than an IP:
-- enough to group attempts from one origin, not enough to identify a person.
-- This is not a log of who used the tool.
create table if not exists public.meta_auth_failures (
  id          bigint generated always as identity primary key,
  source_hash text        not null,
  endpoint    text        not null,
  at          timestamptz not null default now()
);

create index if not exists meta_auth_failures_lookup
  on public.meta_auth_failures (source_hash, at desc);

alter table public.meta_auth_failures enable row level security;
revoke all on public.meta_auth_failures from anon, authenticated;

-- Retention is a DELETE issued by the daily watchdog (see lib/store.js,
-- pruneAuthFailures) rather than a function. A function in the public schema is
-- published by PostgREST as an RPC endpoint and is executable by PUBLIC unless
-- revoked, so a row-deleting routine sat on the API surface reachable with the
-- anon key. Dropped 30 Aug 2026 after the second security review.

-- ---------------------------------------------------------------------------
-- Added 30 Aug 2026. How far a post travelled AS A SHARED OBJECT.
--
-- Meta publishes two reaction counts and they differ usefully:
--   reactions (post object)        reactions on the post itself
--   post_reactions_by_type_total   ALSO counts reactions on reshares of it
--
-- Measured across 406 posts: the second is never lower, matches exactly on 93%
-- of posts that were never shared, and runs ~22% higher on posts that were. The
-- difference is engagement the post earned after it left the page.
--
-- ONLY rows from 2026-08-30 qualify. Before that date reactions_total held the
-- INSIGHTS figure, so both columns were the same number and every post would
-- read as exactly 1.00x - indistinguishable from a genuine result, and wrong for
-- every widely-shared post in the archive.
create or replace view public.meta_post_amplification as
with latest as (
  select distinct on (m.post_id)
    m.post_id, m.page_id, m.collected_date,
    m.reactions_total,
    m.shares_total, m.views_total, m.views_unique,
    (coalesce(m.reactions_like,0) + coalesce(m.reactions_love,0)
     + coalesce(m.reactions_wow,0) + coalesce(m.reactions_haha,0)
     + coalesce(m.reactions_sorry,0) + coalesce(m.reactions_anger,0)) as insights_total,
    (m.reactions_like is not null) as has_insights
  from public.meta_post_metrics m
  where m.collected_date >= date '2026-08-30'
  order by m.post_id, m.collected_date desc
)
select
  l.post_id, l.page_id, g.name as page_name,
  p.created_time, p.message, p.permalink_url, p.media_type,
  l.collected_date,
  l.reactions_total as reactions_on_post,
  l.insights_total  as reactions_incl_reshares,
  greatest(l.insights_total - l.reactions_total, 0) as reactions_on_reshares,
  l.shares_total, l.views_total, l.views_unique,
  -- Null rather than a number when the base is too small to mean anything. Ten
  -- reactions becoming twelve is noise, and a ratio printed from single digits
  -- invites exactly the wrong conclusion.
  case
    when not l.has_insights then null
    when l.reactions_total is null or l.reactions_total < 25 then null
    else round(l.insights_total::numeric / l.reactions_total, 2)
  end as amplification
from latest l
join public.meta_posts p on p.post_id = l.post_id
join public.meta_pages g on g.page_id = l.page_id;

grant select on public.meta_post_amplification to meta_readonly;

-- ---------------------------------------------------------------------------
-- Added 3 Sep 2026. Per-person access tokens for the MCP connector, as HASHES.
--
-- MCP_TOKENS in Vercel is write-only, so adding one person meant re-entering
-- everyone's token and redeploying. A token is now a row: lib/tokens.js checks
-- a presented token's SHA-256 against active rows; scripts/tokens.js issues,
-- revokes and lists them. The token itself is never stored - the hash of 24
-- random bytes is neither reversible nor guessable.
--
-- Read by the connector's service key only. No policies: RLS on with none
-- means anon and authenticated see nothing.
create table if not exists public.meta_access_tokens (
  id           bigint generated always as identity primary key,
  name         text        not null,
  token_hash   text        not null,
  note         text,
  created_at   timestamptz not null default now(),
  created_by   text,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  -- 90 days from issue (TOKEN_TTL_DAYS). A credential nobody withdraws and
  -- nobody re-confirms outlives the reason it was issued. Enforced in
  -- lib/tokens.js as well, so the rule does not depend on the query.
  expires_at   timestamptz,
  constraint meta_access_tokens_name_format check (name ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  constraint meta_access_tokens_hash_format check (token_hash ~ '^[0-9a-f]{64}$')
);

-- One ACTIVE token per name; a revoked row keeps the name's history.
create unique index if not exists meta_access_tokens_one_active_per_name
  on public.meta_access_tokens (name) where revoked_at is null;
create unique index if not exists meta_access_tokens_hash
  on public.meta_access_tokens (token_hash);
create index if not exists meta_access_tokens_active
  on public.meta_access_tokens (revoked_at, expires_at);

alter table public.meta_access_tokens enable row level security;
revoke all on public.meta_access_tokens from anon, authenticated;

-- ---------------------------------------------------------------------------
-- BREAKOUT ALERTS: what has already been announced to Slack past 100,000 views.
-- Written by scripts/breakout-alerts.js, and only after Slack accepts the
-- message - recording first would silently swallow an announcement whenever the
-- webhook failed.
--
-- This table IS the deduplication. A post is announced once; a later
-- translation of the same story is not, unless it lands 35+ days after the
-- original (BREAKOUT_REVIVAL_DAYS), which makes it a genuine revival rather
-- than a copy. The (story_key, media_type) pair is what gets compared, so a
-- video and a photo of the same story both surface - deliberately, since they
-- are different assets a country team might rework.
--
-- story_key identifies the story, not the post: it comes from Titlecase proper
-- nouns shared across translations (lib/stories.js), which is the one signal
-- that survives a caption being rewritten in another language.
create table if not exists public.meta_breakout_alerts (
  id             bigint generated always as identity primary key,
  story_key      text        not null,
  post_id        text        not null,
  page_id        text,
  media_type     text,
  views_at_alert bigint,
  -- The story's first post, not this one. Feeds the revival window.
  first_post_at  timestamptz,
  announced_at   timestamptz not null default now()
);

-- One announcement per post, enforced rather than trusted: the alerter is
-- re-run by hand during testing and must not double-post.
create unique index if not exists meta_breakout_alerts_post
  on public.meta_breakout_alerts (post_id);
-- The lookup the dedup actually performs.
create index if not exists meta_breakout_alerts_story
  on public.meta_breakout_alerts (story_key, media_type);

alter table public.meta_breakout_alerts enable row level security;
revoke all on public.meta_breakout_alerts from anon, authenticated;
