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
create table if not exists public.meta_page_tokens (
  page_id           text primary key references public.meta_pages(page_id),
  token             text not null,
  token_source      text not null default 'system_user',  -- 'system_user' | 'page_admin' | 'runtime'
  system_user_id    text,
  last_verified_at  timestamptz,
  last_error        text
);

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
alter table public.meta_page_tokens      enable row level security;
alter table public.meta_posts            enable row level security;
alter table public.meta_post_metrics     enable row level security;
alter table public.meta_collection_runs  enable row level security;

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
