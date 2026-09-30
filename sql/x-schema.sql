-- X (Twitter) source. APPLIED to production on 30 Sep 2026 as migration
-- x_source_tables (Asana task 1218268802872745; scoped 8 Sep 2026). Re-running
-- this file is safe: every statement is idempotent.
--
-- Kept in its own file rather than appended to schema.sql so that
-- scripts/check-supabase.js keeps passing against production until these
-- tables exist: the preflight treats everything here as PENDING (checked only
-- when present) rather than REQUIRED. scripts/check-schema-consistency.js reads
-- both files, so drift between this DDL and the preflight is still caught.
--
-- Column set is derived from X's documented v2 field groups (docs.x.com,
-- read 8 Sep 2026). The live probe (scripts/probe-x.js) had not yet run when
-- the tables were created, so reconcile against fixtures/x-*.json after the
-- first run and add columns by migration - the Meta schema was built from
-- fixtures for exactly this reason, and the two Meta columns that were wrong
-- were the two taken from documentation.
--
-- Naming: x_* rather than meta_x_*. The meta_ prefix marks Meta's Graph API
-- estate; these are a different vendor with different rules (30-day metric
-- window, pay-per-resource billing) and should be visibly separate in the
-- PostgREST surface.

-- ---------------------------------------------------------------------------
-- Accounts we collect from. One row per X account, created by the
-- authorisation callback (api/x/callback.js) when the holder clicks Allow.
--
-- kind distinguishes a CitizenGO country account from a spokesperson's personal
-- account, because the two are collected differently: a personal account is
-- read only for posts that carry a CitizenGO link (see x_posts.citizengo_urls)
-- and its holder can revoke at any time. That distinction is a data-protection
-- commitment made in the scoping brief, so it lives in the schema, not a comment.
-- ---------------------------------------------------------------------------
create table if not exists public.x_accounts (
  account_id       text primary key,           -- X numeric user id, as a string
  username         text not null,              -- handle without the @; may change
  name             text,
  kind             text not null default 'organisation',  -- 'organisation' | 'spokesperson'
  country          text,                       -- ISO-3166 alpha-2, or a list code such as ES_LAT
  label            text,                       -- what the invite called it, e.g. "CitizenGO UK"
  is_active        boolean not null default true,
  followers_count  bigint,                     -- last seen; the daily series is x_account_metrics
  authorized_at    timestamptz,
  authorized_by    text,                       -- who minted the invite (operator), never the holder's email
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  constraint x_accounts_kind check (kind in ('organisation', 'spokesperson'))
);

-- ---------------------------------------------------------------------------
-- OAuth 2.0 user-context credentials, SEALED.
--
-- X refresh tokens rotate on every use, so they cannot live in a GitHub secret
-- (nothing in a scheduled run can update one without a PAT). They live here,
-- but never in the clear: the callback seals each token to a public key
-- (X_TOKEN_PUBLIC_KEY) and only the collector holds the private half
-- (X_TOKEN_PRIVATE_KEY, a GitHub Actions secret). A leak of this table, or of
-- the Vercel deployment that writes it, yields nothing usable. See lib/xauth.js.
--
-- The 60-second access token is deliberately NOT stored. It is cheap to mint
-- from the refresh token and not worth a second sealed column.
-- ---------------------------------------------------------------------------
create table if not exists public.x_oauth_tokens (
  id                 bigint generated always as identity primary key,
  account_id         text not null references public.x_accounts(account_id),
  sealed_refresh     text not null,             -- base64: ephemeral-pub | iv | tag | ciphertext
  scopes             text,                      -- space-separated, as granted
  authorized_at      timestamptz not null default now(),
  last_refreshed_at  timestamptz,
  last_error         text,                      -- most recent refresh failure, cleared on success
  revoked_at         timestamptz,               -- set by us (holder asked) or when X refuses the refresh
  constraint x_oauth_tokens_sealed_format check (sealed_refresh ~ '^[A-Za-z0-9+/=]+$')
);
-- One live credential per account. A re-authorisation revokes the old row
-- first, so history is kept and "who authorised when" stays answerable.
create unique index if not exists x_oauth_tokens_one_live_per_account
  on public.x_oauth_tokens (account_id) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- Posts. Metadata only - every number lives in x_post_metrics.
--
-- urls is the expanded_url list from entities.urls, and citizengo_urls the
-- subset that points at citizengo.org, hazteoir.org or the cgo.ac shortener.
-- That subset is the whole answer to the spokesperson-attribution ask: which
-- posts carried which tracking link. It is derived at collection time by
-- lib/xschedule.js so the rule is tested, not re-derived in SQL by each reader.
-- ---------------------------------------------------------------------------
create table if not exists public.x_posts (
  post_id              text primary key,
  account_id           text not null references public.x_accounts(account_id),
  created_at           timestamptz not null,
  text                 text,
  lang                 text,
  conversation_id      text,
  in_reply_to_user_id  text,
  referenced_type      text,          -- retweeted | quoted | replied_to | null (original)
  referenced_post_id   text,
  has_media            boolean not null default false,
  media                jsonb,         -- [{media_key, type, view_count?}], from includes.media
  urls                 jsonb,         -- [{url, expanded_url, display_url}]
  citizengo_urls       jsonb,         -- subset of urls.expanded_url that is ours; [] when none
  source               text,
  permalink_url        text,          -- https://x.com/<username>/status/<post_id>
  first_seen_at        timestamptz not null default now()
);
create index if not exists x_posts_account_created_idx
  on public.x_posts (account_id, created_at desc);
-- Partial index for the attribution question: "every post that carried one of
-- our links" should not scan the whole table.
create index if not exists x_posts_with_links_idx
  on public.x_posts (account_id, created_at desc)
  where jsonb_array_length(coalesce(citizengo_urls, '[]'::jsonb)) > 0;

-- ---------------------------------------------------------------------------
-- Post metrics. APPEND-ONLY, one row per post per collection day, exactly as
-- meta_post_metrics: the latest row is the answer, and a raw SUM multiplies
-- every post by the number of days it was collected. Readers go through the
-- x_post_latest view or lib/shape.js-style reduction, never the table.
--
-- Three field groups, three different availabilities:
--   public_*      anyone, any age
--   nonpublic_*   own posts only, created within the last 30 days
--   organic_* /   own posts only, last 30 days; the organic/promoted split
--   promoted_*
-- NULL means "X did not serve this", never zero. private_window_open records
-- whether the post was young enough for the private groups at collection time,
-- so a NULL there can be told apart from a NULL caused by an error.
-- ---------------------------------------------------------------------------
create table if not exists public.x_post_metrics (
  id                     bigint generated always as identity primary key,
  post_id                text not null references public.x_posts(post_id),
  account_id             text not null references public.x_accounts(account_id),
  collected_date         date not null,
  collected_at           timestamptz not null default now(),
  post_age_days          integer,          -- at collection; drives the recollection schedule
  private_window_open    boolean,          -- post_age_days <= 30 when the private groups were requested
  -- public_metrics
  impressions            bigint,
  likes                  bigint,
  reposts                bigint,
  replies                bigint,
  quotes                 bigint,
  bookmarks              bigint,
  -- non_public_metrics (own posts, <=30 days)
  url_link_clicks        bigint,
  user_profile_clicks    bigint,
  engagements            bigint,
  -- organic_metrics (own posts, <=30 days)
  organic_impressions    bigint,
  organic_likes          bigint,
  organic_reposts        bigint,
  organic_replies        bigint,
  organic_url_clicks     bigint,
  organic_profile_clicks bigint,
  -- promoted_metrics (own posts, <=30 days; null unless the post was paid)
  promoted_impressions   bigint,
  promoted_likes         bigint,
  promoted_reposts       bigint,
  promoted_replies       bigint,
  promoted_url_clicks    bigint,
  -- video, from includes.media public/non_public metrics; null on a text post
  video_views            bigint,
  video_playback_100     bigint,
  errors                 jsonb
);
create unique index if not exists x_post_metrics_post_day_key
  on public.x_post_metrics (post_id, collected_date);
create index if not exists x_post_metrics_account_date_idx
  on public.x_post_metrics (account_id, collected_date desc);

-- ---------------------------------------------------------------------------
-- Account-level daily series. Point-in-time totals from the user object -
-- X has no account insights endpoint in v2, so follower growth is the
-- difference between consecutive days' followers_count, computed in the view.
-- ---------------------------------------------------------------------------
create table if not exists public.x_account_metrics (
  id               bigint generated always as identity primary key,
  account_id       text not null references public.x_accounts(account_id),
  metric_date      date not null,
  collected_at     timestamptz not null default now(),
  followers_count  bigint,
  following_count  bigint,
  post_count       bigint,
  listed_count     bigint,
  errors           jsonb
);
create unique index if not exists x_account_metrics_day_key
  on public.x_account_metrics (account_id, metric_date);

-- ---------------------------------------------------------------------------
-- Collection runs, one row per account per run - the watchdog's coverage
-- signal, as meta_collection_runs is for Meta - PLUS the cost ledger. X bills
-- per resource returned, so every run records what it read and what that
-- should have cost at the configured prices. scripts/check-x-health.js sums
-- the month to date against X_MONTHLY_BUDGET_USD, and the collector refuses to
-- start once the budget is spent. The figure is an ESTIMATE from our own count;
-- the invoice in the X developer console is the truth, and the two should be
-- reconciled monthly until they agree.
-- ---------------------------------------------------------------------------
create table if not exists public.x_collection_runs (
  id               bigint generated always as identity primary key,
  run_id           text not null,
  account_id       text,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  status           text not null default 'running',   -- running | ok | partial | failed | skipped
  posts_seen       integer default 0,
  metrics_written  integer default 0,
  api_calls        integer default 0,
  post_reads       integer default 0,     -- Post resources returned (billable)
  user_reads       integer default 0,     -- User resources returned (billable)
  est_cost_usd     numeric(10,4) default 0,
  error_code       integer,
  error_message    text
);
create index if not exists x_collection_runs_account_idx
  on public.x_collection_runs (account_id, started_at desc);
create index if not exists x_collection_runs_started_idx
  on public.x_collection_runs (started_at desc);

-- ---------------------------------------------------------------------------
-- Latest snapshot per post, joined to its account. The one view every tool
-- reads. Derived rates guard against a zero denominator the same way
-- meta_ig_latest does.
-- ---------------------------------------------------------------------------
create or replace view public.x_post_latest with (security_invoker = true) as
  select p.post_id, p.account_id, a.username, a.name as account_name, a.kind, a.country,
         p.created_at, p.text, p.lang, p.referenced_type, p.has_media, p.permalink_url,
         p.urls, p.citizengo_urls,
         jsonb_array_length(coalesce(p.citizengo_urls, '[]'::jsonb)) > 0 as has_citizengo_link,
         m.collected_date, m.post_age_days, m.private_window_open,
         m.impressions, m.likes, m.reposts, m.replies, m.quotes, m.bookmarks,
         m.url_link_clicks, m.user_profile_clicks, m.engagements,
         m.organic_impressions, m.promoted_impressions,
         m.video_views,
         coalesce(m.likes, 0) + coalesce(m.reposts, 0) + coalesce(m.replies, 0)
           + coalesce(m.quotes, 0) + coalesce(m.bookmarks, 0) as interactions,
         case when coalesce(m.impressions, 0) > 0
              then round((coalesce(m.likes, 0) + coalesce(m.reposts, 0) + coalesce(m.replies, 0)
                          + coalesce(m.quotes, 0) + coalesce(m.bookmarks, 0))::numeric
                         / m.impressions::numeric * 100, 2)
         end as engagement_rate_pct,
         case when coalesce(m.impressions, 0) > 0 and m.url_link_clicks is not null
              then round(m.url_link_clicks::numeric / m.impressions::numeric * 100, 2)
         end as click_rate_pct
    from public.x_posts p
    join public.x_accounts a on a.account_id = p.account_id
    join public.x_post_metrics m on m.post_id = p.post_id
   where m.collected_date = (select max(y.collected_date)
                               from public.x_post_metrics y
                              where y.post_id = p.post_id);

-- Follower movement per account per day, derived from consecutive snapshots.
create or replace view public.x_account_growth with (security_invoker = true) as
  select s.account_id, a.username, a.name as account_name, a.kind, a.country,
         s.metric_date, s.followers_count, s.following_count, s.post_count,
         s.followers_count - lag(s.followers_count) over (partition by s.account_id order by s.metric_date)
           as followers_change,
         s.metric_date - lag(s.metric_date) over (partition by s.account_id order by s.metric_date)
           as days_since_previous
    from public.x_account_metrics s
    join public.x_accounts a on a.account_id = s.account_id;

-- Month-to-date spend, for the budget guard and the health check.
create or replace view public.x_spend_month_to_date with (security_invoker = true) as
  select date_trunc('month', started_at)::date as month,
         count(*) as runs,
         sum(post_reads) as post_reads,
         sum(user_reads) as user_reads,
         sum(est_cost_usd) as est_cost_usd
    from public.x_collection_runs
   where started_at >= date_trunc('month', now())
   group by 1;

-- One row per post with the time of its newest snapshot. The checkpoint pass
-- (collector/x.js) reads this instead of every snapshot: one row per post
-- rather than ~12, which keeps each account well under PostgREST's 1,000-row
-- response cap. Added 30 Sep 2026 with the 0-7/14/28/60/85 schedule.
create or replace view public.x_post_last_collected with (security_invoker = true) as
  select p.post_id, p.account_id, p.created_at, max(m.collected_at) as last_collected_at
    from public.x_posts p
    left join public.x_post_metrics m on m.post_id = p.post_id
   group by p.post_id, p.account_id, p.created_at;

-- ---------------------------------------------------------------------------
-- PUBLIC-KEY LOCKDOWN, same discipline as the 29 Sept 2026 block in schema.sql:
-- Supabase grants anon/authenticated on every new object in public, so every
-- table here gets RLS and a revoke, every view a revoke, and meta_readonly a
-- select policy so it keeps working through the security_invoker views. The
-- collector and connector use the service key and are unaffected.
--
-- x_oauth_tokens is the one table meta_readonly must NOT read: the blobs are
-- sealed, but a credential table has no business on any read surface.
-- ---------------------------------------------------------------------------
alter table public.x_accounts        enable row level security;
alter table public.x_oauth_tokens    enable row level security;
alter table public.x_posts           enable row level security;
alter table public.x_post_metrics    enable row level security;
alter table public.x_account_metrics enable row level security;
alter table public.x_collection_runs enable row level security;

revoke all on public.x_accounts, public.x_oauth_tokens, public.x_posts, public.x_post_metrics,
  public.x_account_metrics, public.x_collection_runs,
  public.x_post_latest, public.x_account_growth, public.x_spend_month_to_date,
  public.x_post_last_collected
  from anon, authenticated;

grant select on public.x_accounts, public.x_posts, public.x_post_metrics,
  public.x_account_metrics, public.x_collection_runs,
  public.x_post_latest, public.x_account_growth, public.x_spend_month_to_date,
  public.x_post_last_collected
  to meta_readonly;

drop policy if exists meta_readonly_select_x_accounts on public.x_accounts;
create policy meta_readonly_select_x_accounts
  on public.x_accounts for select to meta_readonly using (true);
drop policy if exists meta_readonly_select_x_posts on public.x_posts;
create policy meta_readonly_select_x_posts
  on public.x_posts for select to meta_readonly using (true);
drop policy if exists meta_readonly_select_x_post_metrics on public.x_post_metrics;
create policy meta_readonly_select_x_post_metrics
  on public.x_post_metrics for select to meta_readonly using (true);
drop policy if exists meta_readonly_select_x_account_metrics on public.x_account_metrics;
create policy meta_readonly_select_x_account_metrics
  on public.x_account_metrics for select to meta_readonly using (true);
drop policy if exists meta_readonly_select_x_collection_runs on public.x_collection_runs;
create policy meta_readonly_select_x_collection_runs
  on public.x_collection_runs for select to meta_readonly using (true);

-- Belt and braces, as in schema.sql.
alter view public.x_post_latest         set (security_invoker = true);
alter view public.x_account_growth      set (security_invoker = true);
alter view public.x_spend_month_to_date set (security_invoker = true);
alter view public.x_post_last_collected set (security_invoker = true);
