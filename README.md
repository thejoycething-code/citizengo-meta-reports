# CitizenGO — organic Facebook & Instagram reporting

Collects organic post performance across CitizenGO's Facebook pages into Postgres,
and exposes it to Claude as an MCP server so campaigners can ask questions in plain
English.

**For team members wanting to use it:** see [ONBOARDING.md](ONBOARDING.md).
This file is for whoever maintains it.

**Status:** 36 pages, ~2,200 posts, ~90 days of history. Nightly collection,
weekly digest, and a daily watchdog all running unattended.

---

## Quick start

Node lives at `~/.local/node/bin` and is not on the default PATH.

```bash
npm run db:check        # verify Supabase is reachable and the schema matches
npm run collect         # collect (writes to Supabase, or data/*.ndjson without it)
npm run digest          # build the weekly digest
npm run dev             # dashboard on localhost:4321
npm run mcp             # MCP server over stdio
```

Tests, none of which need credentials except where noted:

```bash
npm run test:supabase     # write/read paths against a PostgREST mock
npm run test:mcp-http     # the HTTP transport, over real HTTP
npm run test:oauth        # the full OAuth flow
npm run test:truncation   # the silent-truncation regression
npm run db:schema-check   # sql/schema.sql vs what the preflight expects
npm run check:freshness   # freshness + completeness (needs Supabase)
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
      MCP server        weekly digest      dashboard
   (stdio + HTTP)      (Actions summary)   (localhost)
```

`lib/shape.js` is shared by every read surface, so the dashboard, the digest and
the MCP tools cannot disagree about what a number means.

### Scheduled workflows

| Workflow | When | Does |
|---|---|---|
| Nightly collection | 04:30 UTC daily | Collects posts, metrics, page trends, ad spend |
| Weekly digest | Mondays 06:00 UTC | Plain-language summary on the run page |
| Watchdog | 09:00 UTC daily | Fails if data is stale **or incomplete** |
| Monthly heartbeat | 1st & 15th | Commits `STATUS.md` so GitHub doesn't disable the crons |
| Dry run | manual | Collects to files, never touches the database |

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

The last two were each found by accident and now have tests: `test:truncation`
and the watchdog's completeness check.

---

## Setup

### Supabase

Run `sql/schema.sql`, then `sql/readonly-role.sql` for the restricted role the
hosted MCP should use. Set `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in `.env` and
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
`MCP_TOKENS` (comma-separated, one per person), `OAUTH_SIGNING_SECRET`.

Deploy with `vercel --prod`. **Vercel Deployment Protection must be off** for
production, or every request is blocked before reaching the auth in `api/mcp.js`.

---

## Known gaps

- **Instagram** — 8 accounts and 126 posts collected, metrics blocked on
  `instagram_manage_insights`
- **Access runs through a personal Facebook profile** — should be a System User in
  a CitizenGO Business Portfolio; expires every 60 days and is against Meta's terms
- **Data shares a database with supporter records** (`clacton_actions`) — the
  `meta_readonly` role exists to limit the blast radius but no key is issued yet
- **One shared MCP token** — per-person tokens are supported but not configured, so
  there's no audit trail
- **Comment text deliberately not collected** — see ONBOARDING.md

---

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
