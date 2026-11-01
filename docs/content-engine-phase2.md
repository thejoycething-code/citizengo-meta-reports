# Content Engine, Phase 2: build plan

_Started 1 Nov 2026. Design: the "Content Engine Phase 2" canvas (claude.ai artifact HV9JHLDZfggUhZMZQ3E2Pn).
Decisions from Christopher Joyce are in brackets with the date._

## Shape

- **The desk stays a claude.ai artifact**, so the ✨ Claude tools (rewrite, change graphic, 3 more options, make the
  set, alt text, ask Claude) keep running on each person's own Claude allowance (the artifact `sample` capability).
  No paid API key.
- **Its data and rules live here**, in citizengo-meta-reports [chosen 1 Nov]: posts, teams and publishing rights in
  Supabase (`sql/engine-schema.sql`), reached only through the `engine_*` MCP tools (`mcp/engine-tools.js`). The
  desk calls them through the viewer's own "CitizenGO Organic Meta" connector (artifact `mcp` capability), so the
  server always knows who is acting and applies `lib/engine.js` itself.
- **Publishing is per person** [1 Nov]: each person connects their own Facebook; the Pages they admin become their
  publishing rights (`engine_publish_rights`). Greg (Canada) can only post to Canada; Chris to CitizenGO global and
  the UK, which includes Scotland.

## Rules (lib/engine.js, pinned by scripts/test-engine.js)

- Country teams [options 1 + 3, 1 Nov]: a team's desk is visible only to its members and maintainers
  (`ENGINE_ADMINS`). Every signed-in person sees every team's calendar, but other teams' items only once scheduled
  or posted, read-only, without their working text. "Copy as an idea" puts any visible post into one of your teams.
- Statuses: review, changes, hold, scheduled, posted, rejected. Approve = schedule [1 Nov]; "Approve and hold"
  = hold. Scheduled posts stay editable until they go out [1 Nov].
- Approving needs a publishing right for every Facebook and Instagram account the post goes to; others can't be
  ticked [1 Nov]. X is posted by hand until the X API is paid for, so it needs none.
- No last-minute checks, no second sign-off [1 Nov].
- Every save is pinned to the version read; a stale save is refused as a conflict, never overwritten.
- Every change is logged in `engine_events` (the activity log; its screen stays hidden for now [1 Nov]).
- Asana: record tasks for UK posts only, assigned to Christopher Joyce [1 Nov].

## Slice 1: posts desk + calendar [chosen 1 Nov]

1. ✅ Schema, rules, tools and tests (this branch).
2. ✅ Schema applied; UK team (uk-fb, uk-ig, uk-x, sc-fb, sc-ig) and global team seeded with Chris as admin;
   `ENGINE_ADMINS` set; deployed (1 Nov). Chris's publishing rights for UK, Scotland and global Facebook and
   Instagram seeded with source `maintainer` until the connect flow exists.
3. ◐ Move the review board's drafts into `engine_posts` (statuses mapped by `fromBoardStatus`), and point the
   daily engine (content-engine/DAILY.md) at `engine_create` / `engine_save` instead of the artifact's store.
   `scripts/engine-import-board.js` is ready and tested; it runs at cutover, from a dump of the board's
   `drafts` collection (ArtifactData list with out_dir), with the service key in the shell:
   `node scripts/engine-import-board.js <dump>/drafts --apply`. Board "archived" (purged rejects) become
   rejected. Re-running only refreshes posts nobody has edited in the engine yet.
4. ◐ Rewire the desk artifact to the engine tools (artifact `mcp` capability) and add Plan › Calendar and queue.
   Keep every existing Claude tool. Started 1 Nov as content-engine/desk.html (a fork of the board): posts come
   from `engine_posts`, saves go through `engine_save`, status changes through `engine_status` (new `posted`
   action; a scheduled post can be reopened). Approve schedules; the menu adds "Approve and hold". At cutover the
   desk is published onto the board's own artifact URL, because card photos are `/_blob/<id>` assets of that
   artifact and would not load anywhere else.
   Calendar view added 1 Nov (Calendar B): week or month, your team's posts (drafts hatched at their suggested
   time, 🕒 scheduled, ✓ posted), other teams' scheduled and posted items read-only behind "Other teams", key
   dates dashed; the queue alongside lists On hold posts and key dates in the next four weeks with nothing drafted.
   Key dates live in `engine_key_dates` (CitizenGO-wide rows have no team; each team has its own, including its
   Mother's Day; no parliament days), seeded by `scripts/engine-key-dates.js` from content-engine/evergreen-calendar.md.
   Plan view added 1 Nov (Plan C): the month with an ideas tray (key dates with nothing planned, posts on hold, your
   own idea). Picking one stores a request in `engine_requests` (`engine_request` create / cancel); it shows on its
   day as "Requested". At cutover the daily run reads open requests (`engine_requests`, status open), drafts each
   into Review for its date with `engine_create`, then calls `engine_request` drafted with the new post id.
   Evergreen view added 1 Nov (bank A): `engine_evergreen` lists the team's bank with each post's state (due 10
   weeks after it last went out; coming up in the 4 weeks before; resting; retired). "Make a fresh draft" files a
   Plan request (source evergreen, with the bank post's id) for a date the person picks; Snooze 4 weeks, Retire,
   Restore and "It went out" use `engine_evergreen_update`, which also adds posts. Seeded with the UK refresh list
   from content-engine/evergreen-bank.md (the 3.5x post left out). Later: the monthly run adds new 5x winners.
   The desk's connector manifest: engine_me, engine_posts, engine_save, engine_status, engine_calendar,
   engine_requests, engine_request, engine_evergreen, engine_evergreen_update, engine_connect, engine_media.
5. ⬜ Until Meta publishing works, "Approve" still hands UK posts to Asana as today.
6. ◐ Cutover (prepared 1 Nov; nothing switched yet). The daily engine's instructions are ready in
   content-engine/DAILY.md, section "Engine mode", which only applies once the file content-engine/ENGINE_LIVE
   exists. It reads the desk through `engine_posts` (each row carries `track`, the Asana / results / source fields
   the run checks, so it never needs whole posts except for tracked links), writes new drafts with `engine_create`,
   changes with `engine_save`, and its bookkeeping on posts in any status, posted and rejected included, with
   `engine_record` (results, posted, stale and the Asana fields of posting only; anything else is refused).
   `make_links.py` reads engine rows. On the day, in this order:
   1. Pick a quiet time between runs (after the midday run, before the next morning's).
   2. Dump the board's `drafts` collection (ArtifactData list, out_dir) and run
      `node scripts/engine-import-board.js <dump>/drafts --apply` with the service key in the shell. Posts nobody
      has edited in the engine are refreshed; ones edited there are left alone.
   3. Publish content-engine/desk.html onto the board URL (SxCXeQPMkaBMNiABjiiULw) from a session whose
      connector list includes the engine tools, with the 11-tool manifest above.
   4. `touch content-engine/ENGINE_LIVE`. The next run works in the engine.
   5. Check the first run: new drafts appear on the desk in Review, nothing was written to the board's `drafts`.
   To go back: delete ENGINE_LIVE and republish review-board.html onto the board URL (its drafts are as they were
   at step 2; anything created in the engine since then would need copying back by hand).

## Slice 2: Meta publishing

### Connect Facebook (built 1 Nov, switched off until the Meta app is set up)

- The desk's "Connect Facebook" button asks `engine_connect` for a ten-minute link naming the signed-in person, which
  opens `api/fb/authorize.js` and then Facebook. `api/fb/callback.js` reads the Pages they manage (`/me/accounts`):
  each Page where they have CREATE_CONTENT, and its linked Instagram account, that matches a team account becomes a
  publishing right (`engine_publish_rights`, source `meta`; `lib/engine.js` `rightsFromPages`). Each Page token is
  sealed to the publishing public key (`ENGINE_TOKEN_PUBLIC_KEY`) into `engine_page_tokens`; only the Mini,
  with the private key, can open one. Reconnecting removes Facebook rights they no longer have; rights a maintainer
  added by hand stay.
- The desk locks Facebook and Instagram accounts you can't post to (🔒: can be unticked, not ticked).
- Tests: `npm run test:engine`, `npm run test:fb-connect` (end to end against a fake Facebook and database).

To switch it on (Chris, in Meta for Developers):
1. In the CitizenGO Meta app (or a new Business app), add the Facebook Login product.
2. Valid OAuth redirect URI: `https://meta-organic-reporting.vercel.app/api/fb/callback`.
3. Permissions: pages_show_list, pages_read_engagement, pages_manage_posts, instagram_basic,
   instagram_content_publish, business_management. With standard access only people who have a role on the app
   (admin, developer, tester) can connect, which suits a small team; anyone else needs App Review and Business
   Verification.
4. In Vercel (meta-organic-reporting, production): `FB_APP_ID`, `FB_APP_SECRET`,
   `FB_REDIRECT_URI` = the URI above. `OAUTH_SIGNING_SECRET`, `ENGINE_TOKEN_PUBLIC_KEY` and `PUBLIC_ORIGIN` are already set.
   Until then the endpoints answer "Not available yet" and the desk says Connect Facebook isn't switched on.

### Publisher (built 1 Nov, dry run until switched on)

- On approve the desk saves the post's `final` snapshot: per platform the exact text with its tracked link, the first
  comment, and the finished images (drawn in the browser, uploaded as JPEGs through `engine_media` into the private
  `engine-media` Storage bucket). Any edit while scheduled refreshes it two seconds later. The publisher only ever
  posts this snapshot.
- `collector/publish.js` (on the Mini, the only place `ENGINE_TOKEN_PRIVATE_KEY` exists; made there by
  `scripts/engine-keygen.js`, which prints only the public half for Vercel): for each scheduled post's Facebook and
  Instagram destinations whose own time has come, it re-checks that the approver still holds the right, opens their
  sealed Page token, signs one-hour links to the images, publishes (photo, multi-photo post, text post, Instagram
  image or carousel), adds the first comment, and records `published[account]` with the link. X stays manual. When
  every Meta destination is out and nothing is left for X, the post becomes Posted.
- Never twice: each destination is claimed before the call; a claim older than 15 minutes with no answer is reported
  ("check the Page"), never retried. A failed first comment is recorded on the published post, never retried.
  Missed by over 6 hours, approver without the right or without a connected Facebook, no snapshot, video: reported
  in the post's Publishing box for a person to act on. Facebook errors are retried up to 3 times.
- Dry run unless `ENGINE_PUBLISH_LIVE=1` on the Mini; `npm run publish:dry` prints what it would do.
- Tests: `npm run test:publish` (22, against an in-memory engine and a fake Facebook).

To switch it on (after Connect Facebook works): install a launchd job on the Mini running `npm run publish` every
5 minutes from ~/citizengo-meta-reports with the runner env, watch a few dry runs, then set `ENGINE_PUBLISH_LIVE=1`.

### Still to build

- Nightly re-check of connected rights on the Mini (open each sealed token, ask Facebook for the person's Page
  tasks, drop rights they have lost).
- Stories; Reels and videos;
  Instagram collab invites; Facebook collaborators added in Meta Business Suite for now.
- Pause everything (A + B + C).

## Slice 3 onwards

Inbox (conversations, Assistant, bulk by topic, by post, moderation and history, automations flow builder, tracked
links 1 + 3), Listening (on the phase-2 monitoring tables), Analytics (CitizenGO dashboard by default), Page Inviter
tab, team and access screens.
