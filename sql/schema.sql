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
  errors                    jsonb
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
  errors             jsonb
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
  m.daily_follows
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
  errors             jsonb
);

create unique index if not exists meta_ig_media_metrics_day_key
  on public.meta_ig_media_metrics (media_id, collected_date);

-- ---------------------------------------------------------------------------
-- AUDIENCE DEMOGRAPHICS: NOT COLLECTED. Confirmed retired by Meta, 26 Aug 2026,
-- tested live across 36 pages. Seven metrics attempted per page -
-- page_fans_country, page_fans_city, page_fans_locale, page_fans_gender_age,
-- page_follows_by_country, page_follows_by_city, page_audience_country - and
-- every one returned an error or an empty object. Do not re-add without
-- re-probing first; the table shape is in git history at 72a5656.
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
-- Convenience view for the dashboard and the Sheet mirror: latest snapshot per
-- post, with engagement rate against the reach figure that still exists.
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
  end as engagement_rate_pct
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

create or replace function public.prune_meta_auth_failures()
returns void language sql as $$
  delete from public.meta_auth_failures where at < now() - interval '1 day';
$$;
