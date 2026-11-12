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
    check (status in ('review', 'changes', 'hold', 'scheduled', 'posted', 'rejected', 'archived')),
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

-- Pause everything [1 Nov, A + B + C]: for a national tragedy or a breaking
-- crisis, hold every scheduled post at once. A pause covers the accounts the
-- person could post to (all their teams', or one team's), or every account in
-- the organisation (scope 'all', maintainers only). Active while resumed_at is
-- null and until (if set) is in the future. Never deletes or changes a post:
-- the publisher just skips paused accounts.
create table if not exists public.engine_pauses (
  id bigint generated always as identity primary key,
  scope text not null check (scope in ('mine', 'team', 'all')),
  team_id text references public.engine_teams(id) on delete cascade,
  account_keys text[] not null default '{}',  -- empty for scope 'all'
  reason text not null,
  paused_by text not null,
  paused_at timestamptz not null default now(),
  until timestamptz,                           -- null = until someone resumes
  resumed_at timestamptz,
  resumed_by text
);
create index if not exists engine_pauses_open on public.engine_pauses (resumed_at) where resumed_at is null;
alter table public.engine_pauses enable row level security;
comment on table public.engine_pauses is 'Content Engine Pause everything: holds scheduled posts on the listed accounts (or all) until resumed or until.';

-- Videos [1 Nov]: the desk sends a Reel or video to the engine in pieces of up
-- to 2.5 MB (engine_video, through the connector, since a published page can't
-- reach Storage itself) under <team>/<post>/video-<upload>/NNN.part; the
-- publisher on the Mini joins them, checks size and SHA-256, and uploads the
-- file straight to Facebook and Instagram. So engine-media also takes
-- application/octet-stream pieces (still 3 MB per object).
update storage.buckets set allowed_mime_types = array['image/jpeg', 'image/png', 'application/octet-stream'] where id = 'engine-media';

-- Inbox [slice 3, 1 Nov]: comments and DMs on the teams' Facebook Pages and
-- Instagram accounts, read on the Mini (collector/inbox.js) with the sealed
-- Page tokens. The collector fills the platform columns; people own status,
-- assignment and labels, which a re-read never overwrites.
create table if not exists public.engine_inbox (
  id text primary key,                       -- fbc_<comment id>, igc_<comment id>, fbm_<message id>, igm_<message id>
  team_id text not null references public.engine_teams(id) on delete cascade,
  account_key text not null,
  platform text not null check (platform in ('facebook', 'instagram')),
  kind text not null check (kind in ('comment', 'message')),
  thread_id text not null,                   -- the post (comments) or conversation (DMs)
  object_id text not null,                   -- the comment or message id on Meta
  parent_id text,                            -- a reply's parent comment
  post_text text,                            -- the post the comment is on, first 200 characters
  post_url text,
  is_ad boolean not null default false,
  author_id text,
  author_name text,
  text text,
  created_at timestamptz not null,
  from_us boolean not null default false,
  hidden boolean not null default false,
  status text not null default 'open' check (status in ('open', 'done')),
  assigned_to text,
  labels text[] not null default '{}',
  replied_at timestamptz,
  deleted_at timestamptz,
  seen_at timestamptz not null default now(),
  updated_at timestamptz,
  updated_by text
);
create index if not exists engine_inbox_team_open on public.engine_inbox (team_id, status, created_at desc);
create index if not exists engine_inbox_thread on public.engine_inbox (thread_id, created_at);
alter table public.engine_inbox enable row level security;
comment on table public.engine_inbox is 'Content Engine Inbox: comments and DMs on the teams'' accounts. Collector fills platform columns; people own status, assigned_to, labels.';

-- Everything done in the Inbox, by whom: the moderation history. Actions on
-- Meta (reply, private reply, like, hide, unhide, delete) are queued and run
-- by the Mini (collector/inbox-actions.js) with the person's own Page token,
-- after a 10-second undo window; desk-only ones (done, reopen, assign, label)
-- are recorded as done straight away.
create table if not exists public.engine_inbox_actions (
  id bigint generated always as identity primary key,
  item_id text not null,
  team_id text not null,
  account_key text not null,
  action text not null check (action in ('reply', 'private_reply', 'like', 'hide', 'unhide', 'delete', 'done', 'reopen', 'assign', 'label')),
  text text,
  detail jsonb not null default '{}'::jsonb,
  by text not null,
  created_at timestamptz not null default now(),
  run_after timestamptz not null default now(),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'cancelled')),
  result jsonb,
  done_at timestamptz
);
create index if not exists engine_inbox_actions_queue on public.engine_inbox_actions (status, run_after) where status in ('queued', 'running');
create index if not exists engine_inbox_actions_team on public.engine_inbox_actions (team_id, created_at desc);
alter table public.engine_inbox_actions enable row level security;
comment on table public.engine_inbox_actions is 'Content Engine Inbox actions and moderation history. Meta actions are queued for the Mini with a 10-second undo window.';

-- Auto-hide list [slice 3, 1 Nov]: per team, banned words, banned phrases, "any
-- link except ours", and the built-in scam phrases (kind 'scams'). The Mini
-- checks each new comment once (auto_checked_at) and queues a hide, never a
-- delete, as the person who made the rule; anyone can unhide it.
create table if not exists public.engine_inbox_rules (
  id bigint generated always as identity primary key,
  team_id text not null references public.engine_teams(id) on delete cascade,
  kind text not null check (kind in ('word', 'phrase', 'links', 'scams')),
  value text not null default '',
  created_by text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists engine_inbox_rules_unique on public.engine_inbox_rules (team_id, kind, lower(value));
alter table public.engine_inbox_rules enable row level security;
comment on table public.engine_inbox_rules is 'Content Engine Inbox auto-hide list: words, phrases, links and scam phrases that hide new comments.';
alter table public.engine_inbox add column if not exists auto_checked_at timestamptz;

-- Pile-on alert [slice 3, 1 Nov]: a post getting at least 10 comments in an
-- hour, 3x the account's normal pace, with at least 30% hostile (word list or
-- the auto-hide rules). Shown on the desk; Slack waits for Chris's OK.
create table if not exists public.engine_inbox_alerts (
  id bigint generated always as identity primary key,
  team_id text not null references public.engine_teams(id) on delete cascade,
  account_key text not null,
  thread_id text not null,
  post_text text,
  post_url text,
  is_ad boolean not null default false,
  at timestamptz not null default now(),
  comments_hour integer not null,
  hostile_hour integer not null,
  baseline numeric not null,
  status text not null default 'open' check (status in ('open', 'seen')),
  seen_by text,
  seen_at timestamptz
);
create index if not exists engine_inbox_alerts_team on public.engine_inbox_alerts (team_id, status, at desc);
alter table public.engine_inbox_alerts enable row level security;
comment on table public.engine_inbox_alerts is 'Content Engine Inbox pile-on alerts: a burst of mostly hostile comments on one post.';

-- Mentions [slice 3, 1 Nov]: other people's posts that tag our Pages
-- (/{page}/tagged) or Instagram accounts (/{ig}/tags), read by the inbox
-- collector. Desk actions only: replying would mean commenting on someone
-- else's post, so the desk links to it instead.
alter table public.engine_inbox drop constraint if exists engine_inbox_kind_check;
alter table public.engine_inbox add constraint engine_inbox_kind_check check (kind in ('comment', 'message', 'mention'));

-- Comment-to-DM automations [slice 3, 1 Nov]: a keyword (whole word) in a new
-- Facebook comment queues a private reply with the petition link, and an
-- optional public reply, as the person who made the rule, through the inbox
-- action worker (so it stays in dry run with the rest until Chris's OK).
-- Each comment is checked once (automation_checked_at); at most one private
-- reply per comment (Meta's rule) and AUTOMATION_DAILY_MAX per rule a day.
create table if not exists public.engine_automations (
  id bigint generated always as identity primary key,
  team_id text not null references public.engine_teams(id) on delete cascade,
  name text not null,
  keywords text[] not null,
  dm_text text not null,
  reply_text text,
  thread_id text,                               -- one post only, or null for every post
  active boolean not null default true,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  updated_by text
);
create index if not exists engine_automations_team on public.engine_automations (team_id, active);
alter table public.engine_automations enable row level security;
comment on table public.engine_automations is 'Content Engine comment-to-DM automations: a keyword in a new Facebook comment queues a private reply (and optional public reply) as the rule maker.';
alter table public.engine_inbox add column if not exists automation_checked_at timestamptz;

-- Ban and unban [1 Nov, gaps §4]: block a comment's or message's author from a
-- Facebook Page (POST/DELETE /{page}/blocked); Instagram has no ban API.
alter table public.engine_inbox_actions drop constraint if exists engine_inbox_actions_action_check;
alter table public.engine_inbox_actions add constraint engine_inbox_actions_action_check check (action in ('reply', 'private_reply', 'like', 'hide', 'unhide', 'delete', 'ban', 'unban', 'done', 'reopen', 'assign', 'label'));

-- Automation flow builder [1 Nov, gaps §5]: what a rule applies to (one post,
-- a post type, or every post; the most specific wins), Facebook and/or
-- Instagram, public replies taking turns, "already got this link → just react",
-- the tag put on each comment it answered, and who it is handed to.
alter table public.engine_automations add column if not exists scope text not null default 'all';
alter table public.engine_automations drop constraint if exists engine_automations_scope_check;
alter table public.engine_automations add constraint engine_automations_scope_check check (scope in ('all', 'type', 'post'));
alter table public.engine_automations add column if not exists post_type text;
alter table public.engine_automations add column if not exists reply_texts text[] not null default '{}';
alter table public.engine_automations add column if not exists platforms text[] not null default '{facebook}';
alter table public.engine_automations add column if not exists skip_repeat boolean not null default true;
alter table public.engine_automations add column if not exists tag text;
alter table public.engine_automations add column if not exists hand_to text;

-- Team and access [1 Nov, gaps §7]: a team admin narrows what someone can do
-- on an account (post, reply and DM, moderate) or Analytics for the team
-- (account_key '*'). Rights still come from Facebook; a row only turns
-- things off, and a row with everything on is deleted.
create table if not exists public.engine_access_limits (
  team_id text not null references public.engine_teams(id) on delete cascade,
  who text not null,
  account_key text not null,
  can_post boolean not null default true,
  can_reply boolean not null default true,
  can_moderate boolean not null default true,
  can_analytics boolean not null default true,
  set_by text,
  set_at timestamptz not null default now(),
  primary key (team_id, who, account_key)
);
alter table public.engine_access_limits enable row level security;

-- Tracked links [1 Nov, gaps §6]: initials, links made, the engine's Copilot sign-in.
create table if not exists public.engine_people (
  who text primary key,
  initials text check (initials ~ '^[A-Z]{2,3}$'),
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table public.engine_people enable row level security;
create table if not exists public.engine_tracked_links (
  code text primary key, short_url text, long_url text not null, via text not null check (via in ('copilot', 'long')),
  petition_id text, mark text, who text, link_id text, created_at timestamptz not null default now()
);
alter table public.engine_tracked_links enable row level security;
create table if not exists public.engine_copilot_auth (
  id int primary key default 1 check (id = 1), client_id text not null, access_token text, refresh_token text,
  expires_at timestamptz, owner text, signed_in_by text, updated_at timestamptz not null default now()
);
alter table public.engine_copilot_auth enable row level security;

-- Video previews [2 Nov]: collector/video-preview.js stores a small MP4 of a cut
-- clip (<team>/<post>/preview-*.mp4, up to 25 MB) for the desk's trimmer, which
-- only gets a 1-hour signed link (engine_preview). The app keeps its own limits
-- (images 3 MB, video pieces 2.5 MB); the bucket ceiling is for previews.
update storage.buckets set allowed_mime_types = array['image/jpeg', 'image/png', 'application/octet-stream', 'video/mp4'], file_size_limit = 26214400 where id = 'engine-media';

-- Link in bio [Phase 3, 2 Nov]: one public page per team (/links/<slug>),
-- filled with the team's recent campaigns (lib/bio.js) plus links people pin.
-- Clicks are counted per button per day by the page's redirect (api/bio.js).
create table if not exists public.engine_bio (
  team_id text primary key references public.engine_teams(id) on delete cascade,
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,30}$'),
  title text not null default 'CitizenGO',
  intro text,
  auto boolean not null default true,
  items jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table public.engine_bio enable row level security;
comment on table public.engine_bio is 'Content Engine Link in bio: one public page per team. items = saved buttons (pinned, retitled, hidden, dated, added by hand, or auto ones with their BIO tracked link).';
create table if not exists public.engine_bio_clicks (
  slug text not null,
  item_id text not null,
  day date not null,
  clicks integer not null default 0,
  primary key (slug, item_id, day)
);
alter table public.engine_bio_clicks enable row level security;
create or replace function public.engine_bio_click(p_slug text, p_item text) returns void
language sql security definer set search_path = public as $$
  insert into public.engine_bio_clicks (slug, item_id, day, clicks) values (p_slug, left(p_item, 40), (now() at time zone 'Europe/London')::date, 1)
  on conflict (slug, item_id, day) do update set clicks = engine_bio_clicks.clicks + 1;
$$;
revoke all on function public.engine_bio_click(text, text) from public, anon, authenticated;
-- Link in bio parity [2 Nov 2026]: page settings (Donate, emails, WhatsApp
-- channel, grid, icons, totals, quiet rule) and, per petition, its Bluebook
-- total and signatures in the last 14 days, plus closed or won hints from
-- the campaign's Asana project. Pulled nightly on the Mini
-- (scripts/link-signatures-mini.sh, scripts/load-petition-status.js).
-- Page views are rows in engine_bio_clicks with item_id '_v' or '_v:<source>'.
alter table public.engine_bio add column if not exists settings jsonb not null default '{}'::jsonb;
create table if not exists public.petition_status (
  petition_id text primary key,
  total bigint,                 -- Bluebook signatures, all time
  last14 bigint,                -- Bluebook signatures in the last 14 days
  bb_pulled_at timestamptz,
  asana_project text,           -- 'EN_GB - <title> - MM/YYYY'
  asana_closed boolean not null default false,  -- project complete or archived, or its evaluation task done
  asana_victory boolean not null default false, -- "Update the status of the Petition on the Landing Page" done
  asana_checked_at timestamptz
);
alter table public.petition_status enable row level security;
comment on table public.petition_status is 'Link in bio: per petition, Bluebook totals and Asana closed/won hints, nightly from the Mini. Read by lib/bio.js.';
-- Priority One, Inbox batch [3 Nov 2026]: a tone fixed by hand (kept, and
-- recorded as a 'tone' action so the word lists can be tuned from the fixes);
-- teammates whose Meta actions wait for a check (status 'check' until a team
-- admin approves, then queued as usual); each person's own desk settings and
-- saved Inbox views.
alter table public.engine_inbox add column if not exists tone_set text check (tone_set in ('positive', 'neutral', 'negative', 'mixed'));
alter table public.engine_inbox add column if not exists tone_set_by text;
alter table public.engine_members add column if not exists needs_check boolean not null default false;
alter table public.engine_people add column if not exists prefs jsonb not null default '{}'::jsonb;
alter table public.engine_inbox_actions drop constraint if exists engine_inbox_actions_action_check;
alter table public.engine_inbox_actions add constraint engine_inbox_actions_action_check check (action in ('reply', 'private_reply', 'like', 'hide', 'unhide', 'delete', 'ban', 'unban', 'done', 'reopen', 'assign', 'label', 'tone'));
alter table public.engine_inbox_actions drop constraint if exists engine_inbox_actions_status_check;
alter table public.engine_inbox_actions add constraint engine_inbox_actions_status_check check (status in ('check', 'queued', 'running', 'done', 'failed', 'cancelled'));
-- Link in bio upgrades [12 Nov 2026, L1/L4]: each petition's title and
-- picture as its public citizengo.org page (or our own post about it) shows
-- them, with the picture copied into desk-assets so it never expires; and a
-- kept copy of each Instagram grid picture. Filled by api/cron/bio.js.
alter table public.petition_status add column if not exists page_title text;
alter table public.petition_status add column if not exists page_image text;
alter table public.petition_status add column if not exists page_image_src text;
alter table public.petition_status add column if not exists page_checked_at timestamptz;
alter table public.meta_ig_media add column if not exists image_copy text;
-- 'page' (the petition page) or 'post' (the first line of our own post about
-- it, when the page gives none; the desk asks someone to check it).
alter table public.petition_status add column if not exists page_title_src text;

-- Link in bio: the petition as citizengo.org shows it (12 Nov 2026).
alter table public.petition_status add column if not exists site_total bigint;
alter table public.petition_status add column if not exists site_count bigint;
alter table public.petition_status add column if not exists share_url text;
alter table public.petition_status add column if not exists page_image_from text;
alter table public.petition_status add column if not exists site_goal bigint;
