-- Content Engine, Phase 2 (Nov 2026): the posts desk and calendar move out of
-- the review board artifact's own store and into Postgres, so country teams,
-- per-person Meta publishing rights and the calendar can be enforced in one
-- place. The desk stays a claude.ai artifact (so its Claude tools run on each
-- person's own allowance) and reaches these tables only through the engine_*
-- MCP tools (mcp/engine-tools.js), which apply the rules in lib/engine.js.
--
-- RLS on with no policies: only the service key (the hosted MCP) reaches them.

-- A country team: its own Content Engine and calendar.
create table if not exists public.engine_teams (
  id text primary key,                       -- 'uk', 'de', 'at', 'global'
  name text not null,                        -- 'United Kingdom'
  flag text,                                 -- '🇬🇧'
  accounts jsonb not null default '[]'::jsonb, -- [{key:'uk-fb', platform:'facebook', page_id:'…', name:'Citizen GO UK'}]
  created_at timestamptz not null default now()
);

-- Who is in which team. `who` is the MCP identity: a token name ('chris') or a
-- Google sign-in email. Editors see and edit the team's posts and calendar;
-- admins also manage the team's members.
create table if not exists public.engine_members (
  team_id text not null references public.engine_teams(id) on delete cascade,
  who text not null,
  role text not null default 'editor' check (role in ('editor', 'admin')),
  added_at timestamptz not null default now(),
  added_by text,
  primary key (team_id, who)
);

-- The Pages a person can publish to, proven by their own Meta connection
-- (Facebook Login, filled by the connect flow). Approving a post schedules it,
-- so a person may only approve for accounts listed here. Never filled by hand
-- except by the maintainer while the connect flow is being built.
create table if not exists public.engine_publish_rights (
  who text not null,
  account_key text not null,                 -- matches engine_teams.accounts[].key
  checked_at timestamptz not null default now(),
  source text not null default 'meta' check (source in ('meta', 'maintainer')),
  primary key (who, account_key)
);

-- One row per post. `doc` is the post as the desk knows it (platform texts,
-- card, options, facts, posting {destinations, at}, first comment …), the same
-- shape the review board stored, so the desk and the daily engine move over
-- without a rewrite. `version` is bumped on every write: a save pinned to an
-- older version is refused, never silently overwritten.
create table if not exists public.engine_posts (
  id text primary key,
  team_id text not null references public.engine_teams(id),
  status text not null default 'review'
    check (status in ('review', 'changes', 'hold', 'scheduled', 'posted', 'rejected')),
  title text not null default '',
  post_at timestamptz,                       -- earliest scheduled time across accounts, for the calendar
  doc jsonb not null default '{}'::jsonb,
  version integer not null default 1,
  source_team text,                          -- set when copied or reworked from another team
  source_post text,
  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz not null default now(),
  updated_by text
);
create index if not exists engine_posts_team_status on public.engine_posts (team_id, status);
create index if not exists engine_posts_post_at on public.engine_posts (post_at);

-- Everything done to a post, by whom: the activity log (screen hidden for now).
create table if not exists public.engine_events (
  id bigint generated always as identity primary key,
  post_id text not null,
  team_id text not null,
  at timestamptz not null default now(),
  who text not null,
  action text not null,                      -- 'create', 'save', 'approve', 'hold', 'changes', 'reject', 'reopen', 'copy', 'posted'
  detail jsonb not null default '{}'::jsonb
);
create index if not exists engine_events_post on public.engine_events (post_id, at);

alter table public.engine_teams enable row level security;
alter table public.engine_members enable row level security;
alter table public.engine_publish_rights enable row level security;
alter table public.engine_posts enable row level security;
alter table public.engine_events enable row level security;

comment on table public.engine_teams is 'Content Engine country teams: each has its own posts desk and calendar.';
comment on table public.engine_members is 'Content Engine team membership (who = MCP identity). Editors see and edit their team only.';
comment on table public.engine_publish_rights is 'Accounts a person can publish to, from their own Meta connection. Approving needs a row here.';
comment on table public.engine_posts is 'Content Engine posts (the desk). doc = the post as the desk knows it; version guards concurrent saves.';
comment on table public.engine_events is 'Content Engine activity log: every create, save and status change, by whom.';

-- Key dates on the calendar [1 Nov]: CitizenGO-wide days (team_id null) first,
-- then each team's own, including its own Mother's Day. No parliament days.
create table if not exists public.engine_key_dates (
  id bigint generated always as identity primary key,
  team_id text references public.engine_teams(id) on delete cascade, -- null = CitizenGO-wide
  starts date not null,
  ends date,                                 -- for weeks and seasons
  title text not null,
  kind text not null default 'key' check (kind in ('key', 'mothers_day')),
  confidence text,                           -- verified, calendar, pattern, unverified
  angle text,                                -- the post idea, for "draft it"
  source text
);
create unique index if not exists engine_key_dates_unique on public.engine_key_dates (coalesce(team_id, ''), starts, title);
create index if not exists engine_key_dates_starts on public.engine_key_dates (starts);
alter table public.engine_key_dates enable row level security;
comment on table public.engine_key_dates is 'Content Engine key dates for the calendar: CitizenGO-wide (team_id null) and per team. No parliament days.';

-- Plan [1 Nov]: "draft this for that date" requests from the Plan page's ideas
-- tray (a key date, a post on hold, or a person's own idea). The daily engine
-- reads the open ones, drafts each into Review for its date and marks it
-- drafted with the new post's id.
create table if not exists public.engine_requests (
  id bigint generated always as identity primary key,
  team_id text not null references public.engine_teams(id) on delete cascade,
  for_date date not null,
  title text not null,
  angle text,
  source text not null default 'idea' check (source in ('key_date', 'idea')),
  status text not null default 'open' check (status in ('open', 'drafted', 'cancelled')),
  post_id text,
  requested_by text not null,
  requested_at timestamptz not null default now(),
  done_at timestamptz,
  done_by text
);
create index if not exists engine_requests_team_date on public.engine_requests (team_id, for_date);
alter table public.engine_requests enable row level security;
comment on table public.engine_requests is 'Content Engine Plan: requests to draft a post for a date. The daily engine drafts open ones into Review.';

-- Evergreen bank [1 Nov, bank A]: past winners (5x the Page's normal or
-- better). Each is due a fresh version 10 weeks after it last went out (the
-- 10-12 week window), unless snoozed or retired. Suggest only: nothing reaches
-- the queue unless someone picks "Make a fresh draft", which files a Plan
-- request (engine_requests.source = 'evergreen').
create table if not exists public.engine_evergreen (
  id bigint generated always as identity primary key,
  team_id text not null references public.engine_teams(id) on delete cascade,
  title text not null,
  url text,
  format text,                               -- 'Reel', 'Image', 'Carousel' ...
  account_key text,                          -- where it went out, e.g. 'uk-fb'
  last_out date not null,
  result text,                               -- '10.4x, 821 shares'
  why text,                                  -- the refresh idea
  status text not null default 'active' check (status in ('active', 'retired')),
  snoozed_until date,
  source_post text,
  added_by text,
  added_at timestamptz not null default now(),
  updated_by text,
  updated_at timestamptz not null default now()
);
create index if not exists engine_evergreen_team on public.engine_evergreen (team_id, status);
alter table public.engine_evergreen enable row level security;
comment on table public.engine_evergreen is 'Content Engine evergreen bank: past winners, due a fresh version 10 weeks after they last went out. Suggest only.';

alter table public.engine_requests add column if not exists evergreen_id bigint references public.engine_evergreen(id) on delete set null;
alter table public.engine_requests drop constraint if exists engine_requests_source_check;
alter table public.engine_requests add constraint engine_requests_source_check check (source in ('key_date', 'idea', 'evergreen'));

-- Slice 2, "Connect Facebook": each person's Page tokens, SEALED to the
-- publishing public key (ENGINE_TOKEN_PUBLIC_KEY, lib/xauth.js seal), so the hosted MCP can write them
-- but never read them back. Only the publisher on the Mini, which holds the
-- private key, opens one, and only to publish a post that person approved.
create table if not exists public.engine_page_tokens (
  who text not null,
  account_key text not null,
  page_id text not null,
  ig_id text,
  sealed text not null,
  connected_at timestamptz not null default now(),
  primary key (who, account_key)
);
alter table public.engine_page_tokens enable row level security;
comment on table public.engine_page_tokens is 'Content Engine: per-person Page tokens from Connect Facebook, sealed to the publishing key (private half only on the Mini). Never stored in the clear.';
