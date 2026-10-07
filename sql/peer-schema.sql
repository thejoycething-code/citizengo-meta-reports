-- Peer watch: public Instagram posts from peer organisations (SPUC,
-- Right To Life UK and others), read through the Instagram Graph API's
-- business_discovery field. APPLIED to production on 7 Oct 2026 as migrations
-- peer_ig_tables and peer_ig_revoke_sequence. Re-running this file is safe:
-- every statement is idempotent.
--
-- Why this route: business_discovery is Meta's official, free way to read another
-- Business or Creator account's public profile and posts using our own linked
-- Instagram account. No scraping, no logins, nothing paid. It returns likes and
-- comments only (no reach, no shares, no saves), so peer posts are compared
-- against their OWN account's median, never against our posts' insights.
--
-- Kept in its own file, like sql/x-schema.sql, so scripts/check-supabase.js keeps
-- passing against production until these tables exist.
--
-- Naming: peer_ig_* rather than meta_ig_*. These are other organisations'
-- accounts, not CitizenGO's, and should be visibly separate.

-- ---------------------------------------------------------------------------
-- Accounts we watch. Rows are written by collector/peers-ig.js from
-- config/peers-ig.json (the reviewed list) on every run.
-- ---------------------------------------------------------------------------
create table if not exists public.peer_ig_accounts (
  username          text primary key,          -- Instagram handle, lower case, no @
  label             text,                      -- organisation name from the list
  country           text,                      -- UK | IE | US | ... from the list
  topic             text,                      -- pro-life | family | free-speech | ...
  ig_id             text,                      -- business_discovery id, once found
  name              text,                      -- display name Instagram returns
  followers_count   bigint,
  media_count       bigint,
  last_status       text,                      -- ok | not_business | not_found | error
  last_error        text,
  last_checked_at   timestamptz,
  first_seen_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Posts. One row per post, first seen on any run.
-- ---------------------------------------------------------------------------
create table if not exists public.peer_ig_media (
  media_id           text primary key,
  username           text not null references public.peer_ig_accounts(username),
  media_type         text,   -- IMAGE | VIDEO | CAROUSEL_ALBUM
  media_product_type text,   -- FEED | REELS
  caption            text,
  permalink          text,
  timestamp          timestamptz not null,
  first_seen_at      timestamptz not null default now()
);

create index if not exists peer_ig_media_user_time_idx
  on public.peer_ig_media (username, timestamp desc);

-- ---------------------------------------------------------------------------
-- Counts, one row per post per collection day. like_count is null when the
-- account has hidden like counts.
-- ---------------------------------------------------------------------------
create table if not exists public.peer_ig_media_metrics (
  id                 bigint generated always as identity primary key,
  media_id           text not null references public.peer_ig_media(media_id),
  collected_date     date not null,
  like_count         bigint,
  comments_count     bigint,
  followers_count    bigint,
  collected_at       timestamptz not null default now()
);

create unique index if not exists peer_ig_media_metrics_day_key
  on public.peer_ig_media_metrics (media_id, collected_date);

-- ---------------------------------------------------------------------------
-- Latest counts per post, scored against the account's own median over its
-- posts from the last 120 days that were at least 3 days old when counted (so
-- a post still gathering likes does not drag the baseline down).
-- vs_median = 5 means five times that account's normal post.
-- ---------------------------------------------------------------------------
create or replace view public.peer_ig_latest as
with latest as (
  select distinct on (x.media_id)
         x.media_id, x.collected_date, x.like_count, x.comments_count, x.followers_count
    from public.peer_ig_media_metrics x
   order by x.media_id, x.collected_date desc
),
scored as (
  select m.media_id, m.username, a.label, a.country, a.topic,
         m.media_type, m.media_product_type, m.caption, m.permalink, m.timestamp,
         l.collected_date, l.like_count, l.comments_count, l.followers_count,
         coalesce(l.like_count, 0) + coalesce(l.comments_count, 0) as engagement,
         (l.collected_date - m.timestamp::date) >= 3 as settled
    from public.peer_ig_media m
    join latest l using (media_id)
    join public.peer_ig_accounts a using (username)
),
baseline as (
  select username,
         percentile_cont(0.5) within group (order by engagement) as median_engagement,
         count(*) as baseline_posts
    from scored
   where settled and timestamp > now() - interval '120 days'
   group by username
)
select s.*, b.median_engagement, b.baseline_posts,
       case when b.median_engagement > 0
            then round((s.engagement / b.median_engagement)::numeric, 2) end as vs_median
  from scored s
  left join baseline b using (username);

alter view public.peer_ig_latest set (security_invoker = true);

alter table public.peer_ig_accounts      enable row level security;
alter table public.peer_ig_media         enable row level security;
alter table public.peer_ig_media_metrics enable row level security;

revoke all on public.peer_ig_accounts, public.peer_ig_media, public.peer_ig_media_metrics,
  public.peer_ig_latest from anon, authenticated;
revoke all on sequence public.peer_ig_media_metrics_id_seq from anon, authenticated;

-- The read-only reporting role (sql/readonly-role.sql) may read peer data.
grant select on public.peer_ig_accounts, public.peer_ig_media, public.peer_ig_media_metrics,
  public.peer_ig_latest to meta_readonly;

do $$
declare t text;
begin
  foreach t in array array['peer_ig_accounts','peer_ig_media','peer_ig_media_metrics']
  loop
    execute format('drop policy if exists %I on public.%I', 'meta_readonly_select_' || t, t);
    execute format('create policy %I on public.%I for select to meta_readonly using (true)',
      'meta_readonly_select_' || t, t);
  end loop;
end
$$;
