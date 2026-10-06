-- Config for the CitizenGO Page Inviter Chrome extension. Applied 6 Oct 2026
-- (Supabase migration "page_inviter"), seeded with the extension's built-in
-- config.default.js at version 1.
--
-- One row per version; the newest row is live. Rows are only ever inserted -
-- by update_inviter_config (mcp/inviter-tools.js), which validates the config
-- first - so the table is its own history and a revert is a new row copying an
-- old one.
--
-- RLS on with no policies: only the service key reaches it, which is what the
-- hosted MCP holds. No anon or authenticated access.

create table if not exists public.inviter_config (
  id bigint generated always as identity primary key,
  config jsonb not null,
  note text,
  updated_at timestamptz not null default now()
);
alter table public.inviter_config enable row level security;
comment on table public.inviter_config is
  'Page Inviter Chrome extension config. The newest row is served to every copy of the extension. Edit by inserting a new row (keeps history).';
