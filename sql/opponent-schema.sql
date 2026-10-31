-- Opponent watch (31 Oct 2026). Collection authorised by Christopher Joyce on
-- 31 Oct 2026 (Asana 1220076872722026): free sources only, organisations acting
-- in a public role only, never private individuals, 120-day retention.
-- APPLIED to production on 31 Oct 2026 as migration opponent_watch. Re-running
-- this file is safe: every statement is idempotent.
--
-- Two sources, both free and both Meta's own public routes:
--   * Instagram: the same business_discovery read as the ally watch
--     (sql/peer-schema.sql), into the same tables, told apart by stance.
--   * Meta Ad Library: the opponents' issue ads in the UK (ads_archive), into
--     opponent_ads. Spend and impressions are the ranges Meta publishes.

-- ---------------------------------------------------------------------------
-- Ally or opponent. Every existing row is an ally.
-- ---------------------------------------------------------------------------
alter table public.peer_ig_accounts add column if not exists stance text not null default 'ally';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'peer_ig_accounts_stance') then
    alter table public.peer_ig_accounts add constraint peer_ig_accounts_stance check (stance in ('ally', 'opponent'));
  end if;
end
$$;

-- peer_ig_latest gains stance. A column cannot be inserted mid-list by create
-- or replace, so the view is dropped and rebuilt with its options and grant.
drop view if exists public.peer_ig_latest;
create view public.peer_ig_latest as
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
         (l.collected_date - m.timestamp::date) >= 3 as settled,
         a.stance
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
revoke all on public.peer_ig_latest from anon, authenticated;
grant select on public.peer_ig_latest to meta_readonly;

-- ---------------------------------------------------------------------------
-- Opponents' ads from the Meta Ad Library. One row per ad, refreshed each run.
-- ---------------------------------------------------------------------------
create table if not exists public.opponent_ads (
  ad_id               text primary key,
  page_id             text not null,
  page_name           text,
  label               text,          -- organisation name from config/opponents-ig.json
  topic               text,          -- abortion | assisted-dying | gender | ...
  created_time        timestamptz,
  delivery_start      timestamptz,
  delivery_stop       timestamptz,   -- null while still running
  bodies              text,          -- ad text, variants joined
  link_titles         text,
  snapshot_url        text,
  spend_lower         bigint,        -- Meta publishes ranges, never exact figures
  spend_upper         bigint,
  impressions_lower   bigint,
  impressions_upper   bigint,
  currency            text,
  platforms           jsonb,
  first_seen_at       timestamptz not null default now(),
  last_seen_at        timestamptz not null default now()
);
create index if not exists opponent_ads_page_start_idx on public.opponent_ads (page_id, delivery_start desc);

alter table public.opponent_ads enable row level security;
revoke all on public.opponent_ads from anon, authenticated;
grant select on public.opponent_ads to meta_readonly;
drop policy if exists meta_readonly_select_opponent_ads on public.opponent_ads;
create policy meta_readonly_select_opponent_ads on public.opponent_ads for select to meta_readonly using (true);

-- ---------------------------------------------------------------------------
-- Retention: opponent data older than 120 days is deleted on every run. Ally
-- data is not touched. Called by collector/peers-ig.js and collector/ad-library.js.
-- ---------------------------------------------------------------------------
create or replace function public.purge_opponent_data(p_days integer default 120)
returns table (posts_deleted bigint, ads_deleted bigint)
language plpgsql
set search_path = public
as $$
declare
  cutoff timestamptz := now() - make_interval(days => p_days);
  old_media text[];
  n_posts bigint;
  n_ads bigint;
begin
  select coalesce(array_agg(m.media_id), '{}') into old_media
    from peer_ig_media m join peer_ig_accounts a using (username)
   where a.stance = 'opponent' and m.timestamp < cutoff;
  delete from peer_ig_media_metrics where media_id = any(old_media);
  delete from peer_ig_media where media_id = any(old_media);
  n_posts := coalesce(array_length(old_media, 1), 0);
  delete from opponent_ads where coalesce(delivery_stop, delivery_start, created_time) < cutoff;
  get diagnostics n_ads = row_count;
  return query select n_posts, n_ads;
end
$$;

revoke all on function public.purge_opponent_data(integer) from public, anon, authenticated;
grant execute on function public.purge_opponent_data(integer) to service_role;
