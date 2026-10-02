# CitizenGO — organic Facebook & Instagram reporting

Collects organic post performance across CitizenGO's Facebook pages into Postgres,
and exposes it to Claude as an MCP server so campaigners can ask questions in plain
English.

**For team members wanting to use it:** see [ONBOARDING.md](ONBOARDING.md).
This file is for whoever maintains it.

**Status:** 36 pages collecting (25 actively publishing), 2,700 posts, ~90 days
of history. Nightly collection, weekly digest and a daily watchdog all running
unattended.

---

## Quick start

Node lives at `~/.local/node/bin` and is not on the default PATH.

```bash
npm run db:check        # verify Supabase is reachable and the schema matches
npm run collect         # collect (writes to Supabase, or data/*.ndjson without it)
npm run digest          # build the weekly digest
npm run dev             # local-only dashboard on localhost:4321 (dev/dashboard.html)
npm run mcp             # MCP server over stdio
```

Tests, none of which need credentials except where noted:

```bash
npm run test:supabase     # write/read paths against a PostgREST mock
npm run test:mcp-http     # the HTTP transport, over real HTTP
npm run test:oauth        # the full OAuth flow
npm run test:truncation   # the silent-truncation regression
npm run db:schema-check   # sql/schema.sql vs what the preflight expects
npm run test:tool-size    # no tool response floods the conversation
npm run test:tokens       # token expiry thresholds, against a stubbed Graph API
npm run check:freshness   # freshness + completeness (needs Supabase)
npm run check:tokens      # days left on each Meta token (needs META_TOKENS)
```

---

## How it fits together

```
Meta Graph API
      │  nightly, GitHub Actions
      ▼
  collector ──────────► Supabase (Postgres, eu-west-2)
                              │
             ┌────────────────┼────────────────┐
             ▼                ▼                ▼
      MCP server        weekly digest     dev dashboard
   (stdio + HTTP)      (Actions summary)  (localhost only)
```

`lib/shape.js` is shared by every read surface, so the local dashboard, the digest
and the MCP tools cannot disagree about what a number means. The deployed
dashboard and its `/api/posts` and `/api/pages` endpoints were retired on
3 Sep 2026: never configured in production, and surface the connector does not
need. The production root serves a static notice and nothing else.

### Scheduled workflows

| Workflow | When | Does |
|---|---|---|
| Nightly collection | 04:30 UTC daily | Collects posts, metrics, page trends, ad spend |
| Weekly digest | Mondays 06:00 UTC | Plain-language summary on the run page |
| Watchdog | 09:00 UTC daily | Fails if data is stale, incomplete, **or a token is expiring** |
| Monthly heartbeat | 1st & 15th | Commits `STATUS.md` so GitHub doesn't disable the crons |
| Dry run | manual | Collects to files, never touches the database |

### Alerting

Three layers, deliberately independent of each other.

| Layer | Runs on | Catches |
|---|---|---|
| Watchdog workflow | GitHub, 09:00 UTC | Data stale (2+ days) or incomplete |
| GitHub → Slack | GitHub's servers | Any workflow failing, the watchdog included |
| Scheduled Claude task | This laptop, 10:30 | **GitHub Actions not running at all** |

The Slack posts come from GitHub's own app — subscribe with
`/github subscribe thejoycething-code/citizengo-meta-reports workflows`. No custom
Slack app and no `ALERT_WEBHOOK_URL` secret is needed; the webhook path in
`check-freshness.js` still works if one is ever set.

The third layer looks redundant and is not. GitHub cannot tell you that GitHub
stopped: if the cron is disabled after 60 days of repo inactivity, no workflow
runs, nothing fails, and no message is sent — silence is indistinguishable from
health. The scheduled task queries the database directly, so it notices data
going stale whether or not any workflow ran. Same reasoning as keeping the
watchdog separate from the collector: nothing can raise the alarm about its own
absence.

It DMs only on failure. A daily "all fine" message trains the reader to ignore
the channel, which is precisely what must not happen on the one day it matters.

#### Unreachable is not the same as broken

`check-freshness.js` separates the two by exit code, because they call for
opposite responses and used to be indistinguishable:

| Exit | Meaning |
|---|---|
| 0 | Healthy |
| 1 | A real fault — stale, incomplete, or shrinking page coverage |
| 2 | Misconfigured — no credentials to check with |
| 3 | The database could not be reached at all |

A dropped connection used to exit 1 carrying the INCOMPLETE-data message, which
asserts that every figure the tools publish is understated. On 6 Sep 2026 a
network blip on a laptop said exactly that and a re-run half a minute later was
clean. A check that never got an answer knows nothing about the data, and now
says so instead of guessing. Exit 3 still fails the workflow — a GitHub runner
that cannot reach Supabase is worth looking at — but the job summary says
"could not reach" rather than "collection has stopped".

---

## What Meta actually serves

Everything here was established by probing live pages. **Meta's documentation was
wrong in both directions during this build** — do not reason from it.

### Reach survived; the metric names didn't

Every `post_impressions*` variant is retired, along with `page_impressions` and
`page_fans`. But the breakdown mechanism survived:

| What you want | How to get it |
|---|---|
| Unique reach | `post_total_media_view_unique` |
| Total views | `post_media_view` |
| Organic vs paid | `post_media_view` + `breakdown=is_from_ads` |
| Follower vs not | `post_media_view` + `breakdown=is_from_followers` |
| Reactions by type | `post_reactions_by_type_total` |

Confirmed retired, don't retry without probing — the list lives in
`probe/metrics.js` as `CONFIRMED_RETIRED`: `post_video_retention_graph` and every
`page_fans_*` / audience-demographics metric.

### Five traps that cost real time

1. **Page-scoped edges reject user tokens** (`#210`/`#190`). You must exchange for
   a Page token via `/me/accounts?fields=access_token`. A System User token alone
   is not enough.
2. **One gated field fails the whole call.** Putting `comments.summary(...)` in a
   `published_posts` field list returns `#10` and loses *every* post — not just
   that field. Comment counts are fetched in a separate, failure-tolerant pass.
3. **One invalid metric fails the whole `/insights` call.** Hence one call per
   metric.
4. **`#100` is overloaded** — it means both "retired metric" and "object does not
   exist". Classify on the message text, never the code.
5. **A token without `read_insights` gets `200` with an empty body**, not an error.
   The collector detects that signature and says so.

---

## Rules the code enforces

These are the ones that produce wrong answers if broken, and every read surface
depends on them.

- **`meta_post_metrics` is append-only** — one row per post per collection day.
  Always reduce to the latest snapshot before aggregating, or every post is
  multiplied by its number of snapshots. Use `meta_post_latest`, never the base
  table.
- **NULL means Meta refused the metric.** Never coalesce to 0 — a permissions gap
  would read as a performance collapse.
- **Medians, not means, per page.** One 833k-view post otherwise defines the
  average and makes every other post look like a failure.
- **Never sum unique reach across posts.** Two posts reaching 1,000 people each
  have not reached 2,000 people. Views are additive; people are not.
- **Benchmark each post against its own page.** Pages range from 7 followers to
  292,876, so a single estate-wide baseline is meaningless.

This is why the MCP exposes tools rather than a SQL connection: an LLM given raw
tables gets all five wrong, confidently.

---

## Failure modes seen in production

Worth reading before debugging anything — this project's characteristic bug is
something reporting success while achieving nothing.

| Symptom | Cause |
|---|---|
| Every metric null, no errors recorded | Token lacks `read_insights` |
| `Session has expired` | A short-lived Explorer token, not a System User token |
| Token works, zero pages | System User has no Pages assigned |
| "No permissions available" in the token wizard | System User has no role on the app |
| Aggregates plausible but low | **PostgREST caps at 1,000 rows** and ignores a larger `limit` |
| Collection silently stopped | Cron disabled after 60 days of repo inactivity |
| A self-signed role JWT gets `Invalid API key` | The gateway validates against **issued** keys, not signatures |
| A tool response floods the conversation | An unbounded list; cap it and state what was dropped |

Each of these was found by accident rather than by a test, which is the point of
the table. Three now have one: `test:truncation`, `test:tool-size`, and the
watchdog's completeness check.

---

## Setup

### Supabase

Run `sql/schema.sql`. Set `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in `.env` and
run `npm run db:check` — it verifies tables, every column the collector writes,
that RLS blocks the anon key, and a write round-trip.

### Meta tokens

`META_TOKENS` takes a comma-separated list, one per Business Portfolio. The
collector merges what each reaches; first token to see a page wins, and a dead
token stales one portfolio rather than breaking the run.

Creating a System User token, in this order — steps 2 and 3 are both skippable and
fail differently:

1. The app must be in the business — *Accounts → Apps*
2. System User needs **Develop app** on it — *Assign Assets → Apps*
3. System User needs **View Performance** on the Pages — *Assign Assets → Pages*
4. Generate token, expiry **Never**, scopes: `pages_show_list`,
   `pages_read_engagement`, `read_insights`, `pages_read_user_content`, plus
   `instagram_basic` and `instagram_manage_insights` for Instagram

### GitHub secrets

| Secret | Required | For |
|---|---|---|
| `META_TOKENS` | yes | Collection |
| `SUPABASE_URL` | yes | Storage (may be a repo variable) |
| `SUPABASE_SERVICE_KEY` | yes | Storage |
| `ALERT_WEBHOOK_URL` | no | Slack/Chat alerts when collection stops |

### Hosted MCP (Vercel)

Environment: `SUPABASE_URL`, `SUPABASE_MCP_KEY` (or `SUPABASE_SERVICE_KEY`),
`OAUTH_SIGNING_SECRET`. `MCP_TOKENS` (comma-separated `name:token` pairs) is
the break-glass credential source only; day-to-day tokens live in the database. Optional: `PUBLIC_ORIGIN` to pin the token issuer to
one hostname; `MCP_ALLOWED_ORIGINS` to allow browser origins beyond claude.ai,
chatgpt.com and loopback.

**Per-person tokens live in `meta_access_tokens`**, as SHA-256 hashes. Issue,
revoke and list them from the repo with no redeploy:

```bash
npm run tokens -- add candela --note "Candela García"   # prints the token once, valid 90 days
npm run tokens -- revoke candela                        # 401 within 30 seconds
npm run tokens -- rotate candela
npm run tokens -- list                                  # issued, last used, expires, state
```

Tokens **expire 90 days after issue** (`TOKEN_TTL_DAYS`); `list` flags anything
inside 14 days of expiry and `rotate` renews. The daily watchdog also runs
`check:access`, which warns 21 days out and fails the run inside 7, so an
expiry is noticed before the holder finds the tool broken. Expiry is enforced in
`lib/tokens.js`, not left to the query, so a row written by hand obeys it too.

The connector caches active hashes for 30 seconds per instance; if the table is
unreachable the last good list stays in force and `MCP_TOKENS` still applies,
so a database fault degrades rather than locks everyone out. An empty table
with an empty `MCP_TOKENS` refuses everything.

**Authentication is required.** `MCP_PUBLIC=true`, which served every request
without a credential, was withdrawn on 3 Sep 2026 after Carlo Manuali's review
and is ignored on Vercel production. Every request needs a team token or an
OAuth token this server issued. OAuth tokens are checked for signature, expiry,
type, **issuer, audience and scope**, and re-checked against `MCP_TOKENS` on
every call, so removing a person's entry ends their session on their next
request. Browser origins are allowlisted and anything else gets 403; CORS names
the origin rather than `*`; every MCP response is `Cache-Control: private,
no-store`. `npm run test:security` and `npm run test:oauth` cover each of
these.

**Client registration.** Both routes the MCP spec allows: Client ID Metadata
Documents (Claude's recommended option — the client_id is an https URL on
claude.ai / chatgpt.com whose document we fetch, cache and validate; other
hosts are refused before any fetch, see `lib/cimd.js`) and dynamic client
registration (RFC 7591, used by ChatGPT). Either way the redirect_uri must also
pass our own allowlist.

**Breakout alerts.** `npm run alerts:breakout` announces a post to
#comm-social-networks once it passes 100,000 views, so other pages can consider
reworking it. The script only decides and dry-runs; the scheduled Claude task
on Christopher's computer fact-checks and posts.

The hard part is what counts as a duplicate. The Olivia Maurel surrogacy story
ran on nine pages in five languages inside a week, so `lib/stories.js` clusters
posts into stories using Titlecase proper nouns — which survive translation,
where shared rare words do not: a first attempt keyed on rarity merged 591 posts
across 23 pages, because an everyday word in a minority language looks rare in a
Spanish-dominated corpus. The dedup key is then the story **and the media type**,
so a video of Olivia and a photo of Olivia both surface. A same-format copy is
suppressed until 35 days after the story's first post, then announced as a
revival. HazteOir is excluded (`BREAKOUT_EXCLUDE_PAGES`): its median post is
~25,000 views, so 100,000 is routine there and including it produced 26 of 37
alerts in testing. One way to post: `--json` emits the decisions and the
ready-to-send text, the scheduled task in `skills/breakout-alerts/SKILL.md`
fact-checks each post (factual claims only; a problem posts with a warning),
posts through its Slack connector, and `--record <ids>` marks what actually
sent, so an announcement is recorded only after Slack accepts it. The webhook
route (`--post`) was removed on 29 Sept 2026 so that no alert can skip the
fact check. `npm run test:breakout` covers both halves.

**Google sign-in — built, tested, not enabled.** (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`; optional
`ALLOWED_GOOGLE_DOMAINS`, default `citizengo.net`; `MCP_REVOKED_EMAILS` for
instant revocation). When configured, the consent page offers *Continue with
Google*: a standard OpenID Connect flow, verified locally against Google's
published keys — signature, issuer, audience, expiry, nonce, `email_verified`
and the Workspace `hd` claim, so a consumer account with a work alias is
refused. Identity is the verified work email; it is re-checked on every call and
every refresh, so removing a person from the Workspace, listing their email in
`MCP_REVOKED_EMAILS`, or unsetting the client ID ends their access on the next
request. Google refresh tokens last seven days rather than thirty. To create
the client: Google Cloud Console → APIs & Services → Credentials → OAuth client
ID → *Web application*, authorised redirect URI
`https://meta-organic-reporting.vercel.app/api/oauth/google/callback`; set the
consent screen's user type to *Internal* so only Workspace accounts can even
start. Team tokens keep working alongside for anyone issued one.

Deploy with `vercel --prod`. **Vercel Deployment Protection must be off** for
production, or every request is blocked before reaching the auth in `api/mcp.js`.

---

## Known gaps

- **Instagram follower attribution is FEED-only.** 8 accounts and 790 posts are
  collected with full metrics — the older note here about
  `instagram_manage_insights` blocking them is long fixed. What remains partial
  is `follows` / `profile_visits` / `profile_activity`: Meta serves them for
  FEED posts and refuses them for Reels, which is 374 of our 790 posts. So a
  followers-per-post number covers feed posts only and must say so; blending it
  across Reels or Facebook would invent most of it. Facebook has no per-post
  follower metric at any level. Re-check both with
  `scripts/probe-follower-metrics.js` when `GRAPH_VERSION` moves.
- **Nothing is backfilled before 7 September 2026** for those three metrics —
  they fill going forward as each post is re-polled inside the 14-day window.
  An older post needs a longer `lookback_days` to pick them up.
- **Access runs through a personal Facebook profile.** A System User is not
  currently possible: it must live in a Business Portfolio, and the citizenGO
  portfolio — which owns 11 pages carrying **86.7% of all views**, HazteOir alone
  being 65.5% — cannot have apps added to it.

  The token itself does **not** expire. What expires is Meta's **data access
  window**: 90 days, currently ending **24 November 2026**. Past that the token
  still authenticates and simply returns nothing — no error, no failed request,
  just empty results. Renewal means the profile owner re-authorising the app,
  which resets the window. The watchdog warns 21 days out and fails at 7.
- **Tokens are issued by one operator** — `npm run tokens -- add` needs the
  service key, so Chris mints and distributes them. No redeploy, but no
  self-service either; Google sign-in exists in the code for the day that is
  wanted.
- **Comment text deliberately not collected** — see ONBOARDING.md

---

---

## X (Twitter) source — LIVE for @CitizenGO

Scoped 8 Sep 2026 (Asana task 1218268802872745; brief in Drive, "X data via MCP –
scoping brief"). **Live since 30 Sep 2026 for the Global account @CitizenGO
only.** Nightly collection at 05:15 UTC, six tools on the connector, 242 posts
backfilled to 100 days on the first run for an estimated $0.25. X developer app:
"CitizenGO Reporting". Adding another account is step 5 of the checklist below;
switching off is the paragraph after it.

### What X gives us, and what it does not

Verified against X's own documentation on 8 Sep 2026 (`docs.x.com`), not yet
against the live API — `npm run probe:x` is that check and must run first.

- **Private metrics have a window, and it is not the documented one.**
  `non_public_metrics` (link clicks, profile clicks), `organic_metrics` and
  `promoted_metrics` are served only for the account's OWN posts. X documents
  30 days, and its refusal message says "older than 30 days". Probed live on
  30 Sep 2026 (`fixtures/x-2026-09-30-05-*`, `-06-*`), @CitizenGO originals were
  served private metrics at 27-76 days and refused from 90 days. The schedule
  stays on the documented 30 so an unannounced tightening loses nothing; the
  slack was used once, for the initial backfill. `public_metrics`
  (impressions, likes, reposts, replies, quotes, bookmarks) have no window and
  cover the 3,200 most recent posts.
- **Retweets are not collected** (`--include-retweets` to override). A retweet
  reports its own impressions beside the original's repost count (109 against
  1,176 in the probe) and serves no private metrics. Replies and quote posts
  are ours and are kept.
- **Refusals are sorted, not stored.** X refuses per field, so an unboosted
  post brings five promoted-metrics refusals every read (251 for 37 posts in
  the probe). Expected refusals are dropped (`expectedRefusal` in
  `lib/xapi.js`); anything else lands in `x_post_metrics.errors`.
- **X 5xx is retried twice** (2s, 6s). A pass that still fails marks the run
  `failed` or `partial`, never `ok` with zero posts.
- **Billing is per resource RETURNED**, prepaid: $0.001 per own post, $0.005
  per anyone else's, $0.010 per user lookup; repeats within a UTC day charged
  once. So the collection schedule is the cost. Agreed 30 Sep 2026
  (`lib/xschedule.js`): every post is read **daily for days 0-7, then at days
  14, 28, 60 and 85** - 12 reads per post. Day 28 is the insurance read inside
  X's documented 30 days; 60 and 85 rely on the observed ~89. A missed night
  catches up at the next run (`dueForCheckpoint`). Steady state from the third
  month: 18 accounts at 5 posts/day is **$37.80/month** ($167.40 if X bills the
  ordinary rate); @CitizenGO alone is about $1.20. `x_collection_runs` is the
  ledger; the collector refuses to start once `X_MONTHLY_BUDGET_USD` (default
  $100) is spent, and `npm run check:x` warns at 80%.
- **The watchdog watches the slack.** If reads of posts aged 31-89 days stop
  returning private metrics, `check-x-health.js` warns that X has tightened
  and the day-60 and day-85 checkpoints are buying public metrics only.
- **Each account authorises once** (OAuth 2.0 user context, PKCE, read-only
  scopes). X refresh tokens ROTATE on every refresh, so they live in
  `x_oauth_tokens`, **sealed**: the Vercel callback encrypts to a public key and
  only the GitHub Actions collector holds the private key. The deployment that
  faces the internet can write a credential it cannot read (`lib/xauth.js`).
- **Spokesperson accounts are collected only for posts carrying a CitizenGO
  link** (citizengo.org, hazteoir.org, cgo.ac, derechoavivir.org). That rule
  is in the schema (`x_accounts.kind`), the collector and the tools, because it
  is a commitment made to the account holders, not a preference.
- **Attribution stops at the click.** `x_link_posts` lists which post carried
  which link, its UTM tags and X's click count. Signatures from those clicks
  are in the Bluebook under the same UTM; our UTM scheme has no
  per-spokesperson slot and adding one is a URL-shortener change, not ours.
- **Every field X gives for free is kept** (2 Oct 2026). X bills per post or
  user returned, not per field, so the requests ask for everything useful:
  the full text of long posts (`note_tweet`; `text` alone stops at 280
  characters, which cut 6 of @CitizenGO's last 17 posts), X's topic labels,
  hashtags, mentions, edit count, reply settings, video length, alt text and
  how far viewers got through each video, plus profile fields. Expansions are
  NOT free (they return extra billed posts and users), so only media is
  expanded.
- **Threads are exact.** `x_post_latest.thread_role` labels each post
  `original`, `thread_start`, `thread` (a reply to our own account), `reply`
  or `quote` from X's `conversation_id` and `in_reply_to_user_id`, and
  `x_thread_summary` / `x_threads` give one row per thread. Never infer
  threads from posting gaps: Ireland's gaps have no natural break.

### Pieces

| Piece | File | State (30 Sep 2026) |
| --- | --- | --- |
| Schema (6 tables, 3 views) | `sql/x-schema.sql` | live: migration `x_source_tables`, 30 Sep 2026 |
| API client with billing tally, 429 wait, 5xx retry | `lib/xapi.js` | live |
| OAuth, PKCE, sealed box, invites | `lib/xauth.js`, `lib/xflow.js` | live; keys in GitHub, Vercel, local .env |
| Enrolment pages | `api/x/authorize.js`, `api/x/callback.js` | live; invite-gated |
| Collector (daily 0-7, checkpoints 14/28/60/85, optional backfill) | `collector/x.js` | live |
| Nightly workflow | `.github/workflows/x-collect.yml` | on: repo var `X_COLLECT_ENABLED=true` |
| Health check (freshness, re-auth, budget) | `scripts/check-x-health.js` | in the daily watchdog |
| Six connector tools | `mcp/x-tools.js` | on: `X_TOOLS_ENABLED=true` on Vercel |
| Probe | `scripts/probe-x.js` | `--stored` uses an enrolled account |
| Tests (no network) | `npm run test:x` | — |

### Go-live checklist

Steps 1-7 were completed on 30 Sep 2026 for @CitizenGO. Kept as the record of
how, and because step 5 onward is how any further account is added. The keys
step used `npm run x:set-client` (echo off, writes .env, GitHub and Vercel),
and the probe step used `npm run probe:x -- --stored` against the enrolled
account instead of a pasted token.

1. **X developer account and app.** Check with Ignacio whether one exists (he
   uses the X API). Create an OAuth 2.0 app: type Web App, read-only, callback
   `https://meta-organic-reporting.vercel.app/api/x/callback`. Load $20 of
   credits and set a spending cap in the console.
2. **Keys.** `npm run x:keygen`. Private key to GitHub Actions secrets ONLY;
   public key to Vercel ONLY; invite secret to both and to local `.env`.
   Also to Vercel: `X_CLIENT_ID`, `X_CLIENT_SECRET` (if confidential),
   `X_REDIRECT_URI`. To GitHub: `X_CLIENT_ID`, `X_CLIENT_SECRET`.
3. **Probe.** Get a user-context token for one CitizenGO account (developer
   portal playground, or the enrolment flow on a preview deployment) and run
   `X_PROBE_TOKEN=... npm run probe:x -- --days 40`. Confirm: private groups
   present under 30 days; how X refuses them on an older post (whole request
   or partial error — the collector assumes partial and must be changed if
   not); and, next day, that the console's usage matches the owned-read
   estimate. Reconcile `sql/x-schema.sql` against `fixtures/x-*.json`.
4. **Schema.** Apply `sql/x-schema.sql` in the Supabase SQL editor. `npm run
   db:check` should now report the six X tables present.
5. **Enrol accounts.** `npm run x:invite -- "CitizenGO UK" --country GB` per
   account; send each link to the holder through Filip's weekly X task. For
   spokespersons: `--kind spokesperson`, after they have agreed.
6. **First run by hand.** Actions → X collection → Run workflow (dispatch
   always runs). Check the step summary's cost line. Optionally a one-off
   `backfill_days=90` (public metrics only, ~$0.10 per 100 posts).
7. **Switch on.** Repo variable `X_COLLECT_ENABLED=true`; add
   `node scripts/check-x-health.js` as a step in `watchdog.yml` (with
   `if: always()`); set `X_TOOLS_ENABLED=true` on Vercel and redeploy. Tell
   token holders the connector now answers X questions.

To switch off: unset `X_TOOLS_ENABLED` (tools vanish), set
`X_COLLECT_ENABLED=false` (collection stops), revoke the app in the X console
(every credential dies at once). The tables and their data stay.

---

## Why the connector can hold a service key

The reporting tables are the **only** things PostgREST exposes on this project.
`clacton_actions` and `clacton_events` (supporter records from a closed campaign)
live in a `private` schema, which PostgREST does not serve, so no key reaches
them over the API — verified with the service key itself: `404 PGRST205`. The
empty `meta_page_tokens` table was dropped.

A restricted `meta_readonly` role exists and is correct, but **cannot be reached
over the REST API**: Supabase's gateway validates against issued API keys, so a
correctly-signed JWT carrying a custom role is rejected as `Invalid API key`
before Postgres sees it. Removing the sensitive data from the API surface
achieves the same protection more completely. The role is kept for the day the
MCP talks to Postgres directly.

## Layout

```
collector/     collect.js, instagram.js, adspend.js, x.js (X source), sync-sheet.js, verify.js
lib/           shape.js (shared rules), store.js, graph.js, oauth.js, retry.js,
               xapi.js, xauth.js, xschedule.js, xflow.js (X source)
mcp/           tools.js (10 tools), x-tools.js (6, flag-gated), server.js (stdio), test-client.js
api/           mcp.js (HTTP transport), oauth/*, x/authorize.js + x/callback.js (X account enrolment)
digest/        build.js — the weekly summary
scripts/       preflight, watchdog, mocks, tests
sql/           schema.sql, x-schema.sql (X source), readonly-role.sql
probe/         metrics.js — the ledger of what Meta actually serves
fixtures/      raw probe output, committed as evidence
```
