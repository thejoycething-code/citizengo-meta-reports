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
