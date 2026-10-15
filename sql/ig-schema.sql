-- Instagram accounts connected by their holders (lib/igauth.js). APPLIED to
-- production on 16 Oct 2026 as migration ig_connected_accounts. Idempotent.
--
-- Separate from meta_ig_media: those rows hang off a Facebook Page in
-- CitizenGO's Business Manager (page_id references meta_pages), and a
-- spokesperson's personal professional account has no such Page. The ig_*
-- prefix (no meta_) marks the different route in, as x_* does for X.
--
-- kind 'spokesperson': only posts carrying a CitizenGO link or mentioning
-- CitizenGO are stored (lib/xschedule.js isAboutUs) - a commitment made to the
-- account holder on the consent page (api/ig/authorize.js).

create table if not exists public.ig_accounts (
  ig_user_id       text primary key,
  username         text,
  name             text,
  account_type     text,                    -- BUSINESS | MEDIA_CREATOR
  kind             text not null default 'spokesperson',
  country          text,
  label            text,
  is_active        boolean not null default true,
  followers_count  bigint,
  media_count      bigint,
  authorized_at    timestamptz,
  authorized_by    text,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz,
  constraint ig_accounts_kind check (kind in ('organisation', 'spokesperson'))
);

-- How we reach the account (migration ig_accounts_access_route, 16 Oct 2026):
--   login   - the holder connected through Instagram Login; token in ig_oauth_tokens.
--   partner - the holder added CitizenGO's Business Manager as a partner with
--             Insights access in Meta Business Suite; read with the System User
--             token (META_TOKENS) of business_id. No app review, no app role.
alter table public.ig_accounts add column if not exists access text not null default 'login';
alter table public.ig_accounts add column if not exists business_id text;
alter table public.ig_accounts drop constraint if exists ig_accounts_access;
alter table public.ig_accounts add constraint ig_accounts_access check (access in ('login', 'partner'));

-- Long-lived tokens (60 days), SEALED to the collector's public key. The
-- collector refreshes each one when it is a day old and writes the new token
-- back sealed; a re-authorisation revokes the old row.
create table if not exists public.ig_oauth_tokens (
  id             bigint generated always as identity primary key,
  ig_user_id     text not null references public.ig_accounts(ig_user_id),
  sealed_token   text not null,
  scopes         text,
  authorized_at  timestamptz not null default now(),
  refreshed_at   timestamptz,
  expires_at     timestamptz,
  revoked_at     timestamptz,
  last_error     text
);
create unique index if not exists ig_oauth_tokens_live_idx
  on public.ig_oauth_tokens (ig_user_id) where revoked_at is null;

create table if not exists public.ig_media (
  media_id            text primary key,
  ig_user_id          text not null references public.ig_accounts(ig_user_id),
  caption             text,
  media_type          text,                 -- IMAGE | VIDEO | CAROUSEL_ALBUM
  media_product_type  text,                 -- FEED | REELS
  permalink           text,
  timestamp           timestamptz not null,
  citizengo_urls      jsonb not null default '[]'::jsonb,
  first_seen_at       timestamptz not null default now()
);
create index if not exists ig_media_user_time_idx on public.ig_media (ig_user_id, timestamp desc);

-- One snapshot per media per collection date. NULL = not served, never zero.
create table if not exists public.ig_media_metrics (
  media_id            text not null references public.ig_media(media_id),
  collected_date      date not null,
  collected_at        timestamptz not null default now(),
  reach               bigint,
  views               bigint,
  likes               bigint,
  comments            bigint,
  shares              bigint,
  saved               bigint,
  total_interactions  bigint,
  primary key (media_id, collected_date)
);

create table if not exists public.ig_collection_runs (
  id            bigint generated always as identity primary key,
  run_id        text not null,
  ig_user_id    text,
  started_at    timestamptz not null,
  finished_at   timestamptz,
  status        text,
  media_seen    integer,
  media_kept    integer,
  metrics_written integer,
  error_message text
);

-- Latest snapshot per media, for the tools.
create or replace view public.ig_media_latest with (security_invoker = true) as
select distinct on (m.media_id)
  m.media_id, m.ig_user_id, a.username, a.label, a.kind, m.caption, m.media_type, m.media_product_type,
  m.permalink, m.timestamp, m.citizengo_urls,
  x.collected_date, x.reach, x.views, x.likes, x.comments, x.shares, x.saved, x.total_interactions
from public.ig_media m
join public.ig_accounts a using (ig_user_id)
left join public.ig_media_metrics x using (media_id)
order by m.media_id, x.collected_date desc nulls last;

alter table public.ig_accounts enable row level security;
alter table public.ig_oauth_tokens enable row level security;
alter table public.ig_media enable row level security;
alter table public.ig_media_metrics enable row level security;
alter table public.ig_collection_runs enable row level security;

-- Sequences: no client role needs them (the service key bypasses this).
revoke all on sequence public.ig_oauth_tokens_id_seq from anon, authenticated;
revoke all on sequence public.ig_collection_runs_id_seq from anon, authenticated;
