# CitizenGO — organic Facebook + Instagram post data

One shared dataset of organic post performance across CitizenGO Pages, read by a
web dashboard and mirrored to a Google Sheet. Plan:
`~/.claude/plans/can-you-scope-out-federated-moon.md`

**Status: probe, schema, collector, dashboard, Sheet mirror and MCP server all built
and verified against live data (20 Aug 2026), on the 3 pages currently reachable.**
Remaining: Supabase credentials, real auth, and page coverage (Phase 3 — blocked on
Business Portfolio access, not on code).

## What the probe found

The scoping assumptions were wrong in a useful direction. Do not reason about this
API from the deprecation headlines — reason from `fixtures/`.

### Reach is not dead. The metric *names* died.

Meta retired all seven `post_impressions*` variants (and `page_impressions`,
`page_fans`) — confirmed, they return *"The value must be a valid insights
metric"*. But the **breakdown mechanism survived**, which restores everything that
mattered. Observed on a real post (`434058216680321_1517220967114396`):

| Metric | Value |
|---|---|
| `post_total_media_view_unique` | 569 — unique reach |
| `post_media_view` | 789 — total views |
| `post_media_view` + `breakdown=is_from_ads` | **789 organic / 0 paid** |
| `post_media_view` + `breakdown=is_from_followers` | 683 followers / 106 beyond |
| `post_reactions_by_type_total` | `{like: 15, love: 1, haha: 1}` |
| `post_clicks_by_type` | `{other: 13, photo view: 2, link clicks: 1}` |
| `post_activity_by_action_type` | `{share: 8, like: 17}` |
| `post_clicks` | 16 |

Third-party sources claiming the breakdowns were removed are wrong.

### The design is the inverse of what was planned

Everything numeric comes from **`/insights`**, not post-object fields. The post
object turned out to be *more* permission-gated than the insights edge:

| Requested on `/published_posts` | Result |
|---|---|
| `id`, `created_time`, `message`, `permalink_url`, `status_type`, `full_picture`, `attachments`, **`shares`** | OK with `pages_read_engagement` |
| `comments.summary(...)`, `reactions...` | **#10 — needs `pages_read_user_content`** |

Reactions are recoverable from `post_reactions_by_type_total` instead. Comment
counts are not — those genuinely need `pages_read_user_content` (a non-review
permission, but one the plan wrongly assumed we could skip).

### Three traps that cost real debugging time

1. **Page-scoped edges reject user tokens.** `/{page}/published_posts` and
   `/{page}/insights` return #210 / #190 for a user token. You must exchange for a
   **Page** token via `/me/accounts?fields=access_token`. A System User token alone
   is not sufficient.
2. **One gated field fails the whole call.** Putting `comments.summary(...)` in the
   field list returns #10 and you lose *every* post, not just that field. Same
   principle for insights: one invalid metric fails the entire call, which is why
   metrics are probed and collected one at a time.
3. **`#100` is overloaded.** It means both "retired metric" *and* "object does not
   exist". Classify on the message text, not the code — the probe originally got
   this wrong.

Also: `post_total_media_view_unique` returned **#200 Permissions error** on a
28-follower page while working fine on the 117k-follower page. Treat it as
"unavailable for this page", not a failure.

### The real blocker is inventory, not metrics

`/me/accounts` returns **3** readable pages, against the 35 the Ads API listed:

| Page | ID | Followers |
|---|---|---|
| CitizenGO | 434058216680321 | 117,665 |
| Citizen GO Scotland | 1202888116239414 | 28 |
| CGO Sandbox | 1116066201596147 | 0 |

**Ads permission is not read permission.** The 35-page figure came from an edge
that lists pages with *advertising* access. Closing this gap — System User admin
across 12+ Business Managers — is the actual work of Phase 3, and the ceiling may
land well below 35.

Still unverified: **Instagram** (the probe token lacked `instagram_basic` and
`instagram_manage_insights`, so `instagram_business_account` silently returned
nothing rather than erroring) and **comment counts**.

## Phase 1 — schema and collector

```bash
npm run collect:dry -- --lookback-days 30      # writes data/*.ndjson, no DB needed
npm run collect                                # writes to Supabase when creds are set
npm run verify -- <dirA> <dirB>                 # idempotency check between two runs
```

Apply `sql/schema.sql` once in the Supabase SQL editor. Set `SUPABASE_URL` and
`SUPABASE_SERVICE_KEY` and the collector switches from the NDJSON sink to
PostgREST automatically — same auth headers and `resolution=merge-duplicates`
pattern as `clacton-vercel/api/record.js`.

### Verified

| Check | Result |
|---|---|
| Live collection | 71 posts, 71 metric rows across 3 pages, 643 API calls |
| Idempotency | Two full runs: 0 duplicates, 0 missing, 0 extra, 0 value drift |
| Cross-check vs independent endpoint | shares and reactions corroborate within ~1–3% |
| Supabase sink | **NOT exercised** — no credentials available. NDJSON path only |

### What the data looks like

Real numbers from the CitizenGO main page, per post: total views, unique reach,
organic vs paid, follower vs non-follower, reactions by type, clicks by type,
shares. Example — 3,684 views / 2,460 unique / 3,684 organic / 0 paid /
1,059 from followers / 2,625 beyond.

### Two things the data revealed

**Meta's endpoints disagree with each other by a few percent.** `post_activity_by_action_type`
reports shares and reactions independently of the post object's `shares` field and
`post_reactions_by_type_total` — and they differ (58 vs 57, 163 vs 164, 12 vs 10).
Insights are eventually consistent. **Pick one source per metric and never switch**,
or trends become artefacts of source choice. Current choices: shares from the post
object, reactions from `post_reactions_by_type_total`. `activity_by_type` is stored
as corroboration only.

**9 of 14 Citizen GO Scotland posts return #200 on every metric.** Not explained by
post age or type — `added_photos` both succeeds and fails on different dates. These
are real posts with real engagement (one has 325 shares). Most likely the token's
page role cannot see insights for posts it does not own; a System User with explicit
View Performance should resolve it. Recorded in `meta_post_metrics.errors` so the
gap is visible rather than reading as zero.

### Signed URLs are not storable

`full_picture` comes back as a signed CDN URL whose signature rotates every request
*and* expires. Storing it made all 70 post rows churn on every run and would leave
dead links on historical posts. The collector strips the query string and keeps the
path as a media identity key only — not a fetchable URL.

## Phase 2 — dashboard and Sheet mirror

```bash
npm run dev                      # dashboard on http://localhost:4321 (reads data/*.ndjson)
npm run sheet -- --csv out.csv   # Sheet mirror as CSV; Drive converts it to a Sheet
npm run sheet -- --push          # two-tab push; needs SHEET_ID + GOOGLE_ACCESS_TOKEN
```

The dashboard shows per-page rollup cards and a cross-page post league table,
sortable by views, unique reach, engagement, rate, shares, and **reach beyond
followers** — the virality signal, and the most actionable column here for
campaigning. Verified rendering in light and dark, no console errors.

`lib/shape.js` is shared by the dashboard API, the dev server and the Sheet
mirror, so the surfaces cannot disagree. Medians rather than means on the page
cards: one 2M-view viral post would otherwise define the average and make every
other post look like a failure.

### Two rules the read surfaces enforce

**A gap is never a zero.** 9 of 71 posts have no metrics (Meta #200). They render
as — and export as an empty cell, never 0 — otherwise a permissions gap reads as
a performance collapse.

**The Sheet is a mirror, never a second source of truth.** `--push` clears each tab
before writing, because a shrinking dataset would otherwise leave stale rows behind
the new ones, which is how a mirror silently starts lying.

### Verified

| Check | Result |
|---|---|
| Dashboard render | Light + dark, no console errors, sorting and filters work |
| API contract | `/api/posts` and `/api/pages` return shaped JSON from real data |
| CSV integrity | Parsed back: 72 rows x 20 cols consistently, quoting round-trips |
| Drive to Sheet | Pages rollup created as a real Sheet, content read back and matches |
| Supabase path | **NOT exercised** — no credentials |
| Sheets API two-tab push | **NOT exercised** — see below |
| Auth | **NOT implemented** — interim shared token only, see below |

### Two things that are NOT done

**Real auth.** The plan calls for Supabase Auth magic links restricted to
`@citizengo.net`. What exists is `api/_auth.js`: a single shared bearer token from
`DASHBOARD_TOKEN`, giving no per-user identity and no audit trail. It refuses to
serve if the variable is unset rather than defaulting to open. **Do not deploy this
publicly as it stands** — it is a doorstop, not a lock.

**The two-tab Sheets API push.** `--push` is written but unrun. The Google Sheets
connector available here cannot read or write files created by the Drive connector
(different app identity, `drive.file`-style scope) and has no create tool of its
own, so it can never reach any file. The CSV route works and is verified, but CSV
is single-tab and creates a new file each time — no stable URL. For a nightly
mirror with a fixed link, `--push` needs a `GOOGLE_ACCESS_TOKEN` from a service
account with the target Sheet shared to it.

## Wiring up Supabase

```bash
npm run test:supabase      # exercises every Supabase path against a mock, no credentials
npm run db:schema-check    # sql/schema.sql vs what the preflight expects
npm run db:check           # preflight against a REAL project
```

### Setup

1. Create a Supabase project. Pro ($25/mo) is worth it for daily backups — reach
   history cannot be backfilled, so losing it is the one expensive failure here.
2. Run `sql/schema.sql` in the SQL editor.
3. Put `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` and (optionally, for the RLS check)
   `SUPABASE_ANON_KEY` in `.env`.
4. `npm run db:check`, then `npm run collect`.

The collector and MCP switch from local NDJSON to Supabase automatically once
`SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are present. No flag needed.

### What the preflight checks

In the order things actually go wrong: credentials well-formed (including that the
service key really carries the `service_role` claim — an anon key in that slot is a
common and confusing mistake), every table present, **every column the collector
writes present**, RLS genuinely blocking the anon key, and a write/read/delete
round-trip with a self-cleaning canary row.

### Tested without a database

`scripts/mock-postgrest.js` is a PostgREST test double covering the subset we use.
It exists because `supabaseSink` and `supabaseStore` were written and never run, and
untested write paths are where silent data loss lives. 13 assertions cover upsert
semantics, the `merge-duplicates` header, null preservation, error shapes, and the
exact `on_conflict` targets we send.

The most important of those: two snapshots of one post (500 views, then 800) must
reduce to **800**, not 1300. That is the append-only double-count guard, verified
over Supabase-shaped data rather than assumed.

### Three things this process caught

- One assertion ended in `|| true` and could never fail. Fixing it revealed that
  `loadAll()` fans out to three tables, so one bad-key probe yields three rejections
  — my expectation was wrong, not the client. A test that cannot fail is worse than
  no test.
- The column check and canary cleanup initially passed **spuriously**: the mock
  ignored `select=` and had no DELETE. It now enforces both, and a negative test
  confirms an unknown column is rejected by name.
- The schema is now described in three places, so `db:schema-check` parses the DDL
  and diffs it against the preflight to stop them drifting.

## Nightly collection (GitHub Actions)

`.github/workflows/nightly-collect.yml` runs at **04:30 UTC**, collects every
portfolio we hold a token for, writes to Supabase, then refreshes the Sheet mirror.

GitHub Actions rather than Vercel Cron because at 35 pages the collector runs for
15–25 minutes (~9 API calls per post) and Vercel functions cap at 300s even on Pro.
Actions allows 6 hours; the nightly job uses ~450–750 of the 2,000 free minutes.

### Secrets to set

Settings → Secrets and variables → Actions.

| Secret | Required | Purpose |
| --- | --- | --- |
| `META_TOKENS` | yes | Comma- or newline-separated System User tokens, **one per Business Portfolio** |
| `SUPABASE_URL` | yes | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | yes | `service_role` key |
| `SHEET_ID` | no | Target Sheet. Omit and the mirror step skips rather than fails |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | no | Full service account JSON. Share the Sheet with its `client_email` as Editor |
| `ALERT_WEBHOOK_URL` | no | Slack/Chat webhook for failures. PII-free message |

### Multi-token, because one token cannot reach everything

Our pages sit across 12+ Business Portfolios with no common owner, so the collector
takes a **list** of tokens, queries `/me/accounts` for each, and merges the results —
first token to reach a page wins, so overlapping grants are harmless.

A single dead token does **not** abort the run. It logs which token failed, carries
on with the others, and prints a coverage warning. Only if *every* token fails does
the job stop.

### It fails loudly, on purpose

The failure mode most likely to go unnoticed is a green nightly run over an empty
dataset. The collector therefore exits non-zero when pages were reachable but zero
metric rows were written, or when every page failed. Verified: exit code 1.

Each run writes a summary table to the GitHub run page (pages, statuses, posts,
metric rows, API calls) so a partial collection is visible without reading logs.

### Two GitHub gotchas encoded here

- **Step-level `env` is invisible to that step's own `if`.** `SHEET_ID` and
  `ALERT_WEBHOOK_URL` are declared at *job* level for exactly this reason. Declared
  at step level, both conditional steps silently never run.
- **GitHub disables scheduled workflows after 60 days of repository inactivity.**
  A quiet repo will stop collecting without telling you. Either commit something
  occasionally or watch for the collection gap in `meta_collection_runs`.

### Backfill

Use the manual trigger (Actions → Nightly collection → Run workflow) with
`lookback_days: 90`. Nightly defaults to 14 days because engagement largely settles
within two weeks, and re-polling 30 days doubles the API cost for little gain.

## MCP server — ask Claude directly

```bash
npm run mcp:test
```

Register it with Claude Code:

```bash
claude mcp add citizengo-meta --scope user -- /Users/chrisjoyce/.local/node/bin/node "/Users/chrisjoyce/Desktop/Claude Code Projects/Meta Reports/mcp/server.js"
```

Then ask things like "which of our posts travelled furthest beyond our followers
last month". Five tools: `list_pages`, `top_posts`, `page_summary`, `compare_pages`,
`data_health`. Dependency-free JSON-RPC over stdio. Reads Supabase when credentials
are set, otherwise the collector NDJSON — so it works today.

### Why tools instead of a database connection

This is the important design decision. Pointing an LLM at these tables with SQL
invites three silent, confident errors:

1. **Double-counting.** `meta_post_metrics` is append-only, one row per post per
   collection day. `SUM(views_total)` multiplies every post by the number of days it
   has been collected.
2. **Gaps read as zeros.** NULL means "Meta refused this metric". `COALESCE(x, 0)`
   or `AVG()` turns a permissions gap into apparent bad performance.
3. **Means where medians are honest.** One 2M-view post defines the average for a
   whole page and makes the other 56 posts look like failures.

Every tool routes through `lib/shape.js`, which reduces to the latest snapshot per
post, preserves nulls, and uses medians. The rules travel with the tools. If you do
expose SQL instead, point it at the `meta_post_latest` view, never the raw tables.

### Three bugs the protocol test caught

Recorded because they are the same class of error the tools exist to prevent, and
they still got written:

- `compare_pages` reported **0 views** for a page with no measurable posts, ranking
  it as the worst performer instead of showing "—".
- `compare_pages` compared pages of unequal completeness with no warning. Scotland
  totals come from 5 of 14 posts. It now labels that `14 (9 no data)` and will not
  present the ranking without a caveat.
- `top_posts` on an uncollected page returned "Top 0 posts", which reads as "that
  page had no posts" rather than "that page is not collected".

## Running the probe

```bash
cp .env.example .env    # paste a token into META_TOKEN
npm run probe
```

Node is at `~/.local/node/bin`, not on the default PATH:

```bash
~/.local/node/bin/node probe/probe.js [page_id ...]
```

With no arguments it probes whatever `/me/accounts` returns, rather than an
aspirational pilot list. Takes 2–5 minutes; writes one fixture per page per probe
area, error envelopes included.

## Getting a token

Scopes needed: `pages_show_list`, `pages_read_engagement`, `read_insights`, plus
`pages_read_user_content` for comment counts and `instagram_basic` +
`instagram_manage_insights` for Instagram. None require App Review for your own
pages — `read_insights` was granted to the probe token without review.

**Quick (probe only):** [Graph API Explorer](https://developers.facebook.com/tools/explorer/)
→ select app → add the scopes → Generate. Expires in ~1 hour.

**Proper (collector):** a **System User** token — non-expiring, survives staff
turnover.

1. A Meta App must exist and be linked to the Business Manager. Development mode
   is fine.
2. [business.facebook.com](https://business.facebook.com) → **Business Settings** →
   **Users → System Users → Add**. Role **Employee** (least privilege; it only reads).
3. Because it is Employee, assign assets explicitly: **Assign Assets → Pages** →
   grant **View Performance** only. Skipping this yields a token that authenticates
   but returns an empty page list.
4. **Generate New Token** → select the app → tick the scopes → Generate. Shown once.
5. Paste into `.env`.

Repeat per Business Manager in Phase 3.

## Security

- The token travels in an `Authorization: Bearer` header, never in a URL.
- Redaction happens at **save time**, in `save()` in `probe/probe.js` — the single
  choke point for anything written to disk. Redacting at fetch time (the original
  design) corrupted the page tokens the collector needs in memory.
- Verified: no token material in `fixtures/`; page tokens appear as `<redacted>`.
- `.env` is gitignored and mode 600.

## Layout

```
probe/probe.js          probe entry point
probe/graph.js          minimal Graph client, no dependencies
probe/metrics.js        metric sets, annotated with observed verdicts and values
probe/pilot-pages.json  fallback page list (unused when /me/accounts works)
lib/graph.js            shared Graph client (used by probe and collector)
lib/pool.js             bounded-concurrency map
sql/schema.sql          Supabase schema, RLS-locked
collector/collect.js    nightly collector
collector/lib/sinks.js  Supabase (PostgREST) + NDJSON sinks
collector/verify.js     idempotency verifier
data/                   NDJSON collector output (gitignored)
lib/shape.js            shared shaping for ALL read surfaces
lib/store.js            supabaseStore + fileStore, no implicit fallback
api/posts.js            Vercel: post league table (Supabase only)
api/pages.js            Vercel: per-page rollup (Supabase only)
api/_auth.js            interim shared-token gate
index.html              the dashboard
dev-server.js           local server, NDJSON-backed, same API contract
collector/sync-sheet.js Sheet mirror
mcp/server.js           MCP server (stdio, no dependencies)
mcp/tools.js            the five tools, all via lib/shape.js
mcp/test-client.js      protocol test harness
lib/google-auth.js      mints Google tokens from a service account (RS256 JWT)
.github/workflows/      nightly collection
scripts/check-supabase.js         preflight against a real project
scripts/check-schema-consistency.js  DDL vs preflight drift guard
scripts/mock-postgrest.js         PostgREST test double
scripts/test-supabase-paths.js    integration tests, no credentials needed
fixtures/               raw probe output, committed as evidence
```
