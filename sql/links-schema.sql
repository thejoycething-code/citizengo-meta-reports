-- Link performance: which tracked CitizenGO links our accounts posted, and the
-- signatures each campaign code brought. APPLIED to production on 15 Oct 2026
-- as migration link_performance_tables. Every statement is idempotent.
--
-- Three tables, filled by two different jobs:
--   link_shortcodes  cgo.ac short code -> full URL. A cache: the shortener never
--                    changes a code's target, so each code is resolved once.
--   link_posts       one row per (post, link) across every connected account:
--                    Facebook Pages, Instagram, X (spokespeople included).
--                    Built by collector/links.js in GitHub Actions.
--   link_signatures  signatures, new and reactivated members per campaign code
--                    and arrival source, from Looker (google_analytics_4 /
--                    petitions_signatures_3_0). Pulled on the Mac Mini by
--                    scripts/link-signatures-mini.sh, because Looker is only
--                    reachable through the claude.ai connector there.
--
-- campaign_code is always LOWERCASE: Looker stores utm_campaign lowercased, and
-- the join is on that column. The code follows the CitizenGO UTM standard
-- (LIST-DATE-TITLE-OWNER-CTA-SCOPE-TOPIC-ASSETID-SERIES), so owner (the
-- creator's initials, e.g. rda) and series (fb1, ig2...) are parsed from it.

create table if not exists public.link_shortcodes (
  short_code   text primary key,             -- 'scqA0hnxp' (the path after cgo.ac/)
  full_url     text,                          -- null when it could not be resolved
  http_status  integer,
  resolved_at  timestamptz not null default now()
);

create table if not exists public.link_posts (
  platform       text not null,               -- facebook | instagram | x
  post_id        text not null,
  url            text not null,               -- as it appeared in the post
  account_id     text not null,               -- page_id | ig_user_id | x account_id
  account_label  text,
  account_kind   text,                        -- organisation | spokesperson
  posted_at      timestamptz not null,
  permalink_url  text,
  short_code     text,
  full_url       text,                        -- after resolving cgo.ac
  campaign_code  text,                        -- lowercase utm_campaign (or campaign=)
  utm_source     text,
  utm_medium     text,
  petition_id    text,
  owner          text,                        -- initials from the code, lowercase
  series         text,                        -- fb1, ig2... lowercase
  updated_at     timestamptz not null default now(),
  primary key (platform, post_id, url)
);
create index if not exists link_posts_code_idx on public.link_posts (campaign_code);
create index if not exists link_posts_account_idx on public.link_posts (account_id, posted_at desc);
create index if not exists link_posts_owner_idx on public.link_posts (owner, posted_at desc);

create table if not exists public.link_signatures (
  campaign_code        text not null,         -- lowercase, as Looker stores it
  source               text not null,         -- where the signer arrived from: fb, ig, tw, wa, em...
  signatures           bigint,
  new_members          bigint,
  reactivated_members  bigint,
  owner                text,                  -- parsed from the code, lowercase
  petition_id          text,
  series               text,
  code_date            date,                  -- the DATE segment of the code
  pulled_at            timestamptz not null default now(),
  primary key (campaign_code, source)
);
create index if not exists link_signatures_owner_idx on public.link_signatures (owner, code_date desc);

alter table public.link_shortcodes enable row level security;
alter table public.link_posts enable row level security;
alter table public.link_signatures enable row level security;
