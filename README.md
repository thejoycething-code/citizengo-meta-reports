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
| `SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON` | no | Sheet mirror |

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
inside 14 days of expiry and `rotate` renews. Expiry is enforced in
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

- **Instagram** — 8 accounts and 126 posts collected, metrics blocked on
  `instagram_manage_insights`
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
collector/     collect.js, instagram.js, adspend.js, sync-sheet.js, verify.js
lib/           shape.js (shared rules), store.js, graph.js, oauth.js, retry.js
mcp/           tools.js (10 tools), server.js (stdio), test-client.js
api/           mcp.js (HTTP transport), oauth/*, posts.js, pages.js
digest/        build.js — the weekly summary
scripts/       preflight, watchdog, mocks, tests
sql/           schema.sql, readonly-role.sql
probe/         metrics.js — the ledger of what Meta actually serves
fixtures/      raw probe output, committed as evidence
```
