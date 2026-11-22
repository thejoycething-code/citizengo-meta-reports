-- Listening D5 (Chris, 22 Nov 2026): Bluesky public posts of the organisations
-- we already watch on Instagram (peer_ig_accounts). Public API, no key.
-- Opponent posts are kept 120 days like every opponent row; collector/bluesky.js deletes older ones.
create table if not exists public.listen_bsky_accounts (
  ig_username     text primary key,          -- the watched account this is the Bluesky side of
  handle          text,                      -- null: no Bluesky account found
  did             text,
  label           text,
  stance          text,
  country         text,
  status          text not null,             -- matched | manual | none
  checked_at      timestamptz not null default now()
);
create table if not exists public.listen_bsky_posts (
  uri             text primary key,
  handle          text not null,
  label           text,
  stance          text,
  country         text,
  text            text,
  url             text,
  created_at      timestamptz not null,
  like_count      integer,
  repost_count    integer,
  reply_count     integer,
  quote_count     integer,
  collected_at    timestamptz not null default now()
);
create index if not exists listen_bsky_posts_created on public.listen_bsky_posts (created_at desc);
alter table public.listen_bsky_accounts enable row level security;
alter table public.listen_bsky_posts enable row level security;
