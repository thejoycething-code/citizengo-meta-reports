-- Usage of the CitizenGO Page Inviter Chrome extension: invites sent per day,
-- per Page, per person (their Chrome sign-in email) and per computer. Sent by
-- the extension through inviter_report_usage (mcp/inviter-tools.js) and read
-- with page_inviter_usage, so Christopher can see who uses the tool and its
-- effect on Page follower growth. Nothing about the people invited is stored.
--
-- One row per (day, user, device, page). The extension sends its own running
-- daily totals, so a report replaces the row rather than adding to it, and
-- sending the same day twice is harmless.
--
-- RLS on with no policies: only the service key (the hosted MCP) reaches it.

create table if not exists public.inviter_usage (
  day date not null,
  user_email text not null,
  device_id text not null,
  page_id text not null,
  page_name text,
  invites integer not null default 0 check (invites >= 0),
  extension_version text,
  updated_at timestamptz not null default now(),
  primary key (day, user_email, device_id, page_id)
);
alter table public.inviter_usage enable row level security;
comment on table public.inviter_usage is
  'Page Inviter usage: invites per day, Page, person and computer, reported by the extension (inviter_report_usage).';
