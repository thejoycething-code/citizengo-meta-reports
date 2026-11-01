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
   engine_requests, engine_request, engine_evergreen, engine_evergreen_update, engine_connect, engine_media,
   engine_pause, engine_video, engine_inbox, engine_inbox_act, engine_inbox_undo, engine_inbox_history, engine_inbox_person,
   engine_inbox_posts, engine_inbox_rules, engine_inbox_rule, engine_inbox_alert, engine_inbox_bulk.
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
      connector list includes the engine tools, with the 23-tool manifest above.
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

### Nightly rights re-check (built 1 Nov)

`collector/rights-check.js` (rules in `lib/rightscheck.js`, tests `npm run test:rights-check`) runs on the Mini
at 03:30 (launchd `net.citizengo.content-rights-check`, log /tmp/content-rights-check.log). It opens each sealed
Page token and asks Facebook for the Page (or the linked Instagram account). A token Facebook refuses (invalid or
expired, permission gone, or now for another Page) loses its right and is deleted, so the person connects again
from the desk; a right from Connect Facebook with no token behind it goes too. Rate limits, outages and tokens the
key can't open are "couldn't check" and kept. If every token comes back refused at once (three or more), it looks
like a problem with the Meta app, so nothing is removed. Rights the maintainer seeded are never touched.
Limit: someone moved to a lesser Page role keeps a working token, so that case still shows only when the
publisher's post is refused.

### Pause everything (built 1 Nov, A + B + C)

`engine_pauses` (applied) holds each pause: scope `mine` (every account the person can post to: Facebook and
Instagram they hold a right for, plus their teams' X), `team` (one of their teams, same rule) or `all` (every
account, maintainers only), a reason the team sees, and `until` (24 hours) or open until resumed. `engine_pause`
pauses and resumes; the person who paused, a maintainer, or anyone who can post to all of its accounts can resume.
Active pauses come back with `engine_me` and `engine_posts`, so every desk sees one within a poll. The publisher
holds paused accounts before any other check (`P.plan` action `paused`), so a long pause never fails a post as
missed while it lasts; after resuming, a post more than 6 hours past its time asks for a new one. Nothing is
deleted or changed. Desk: A, the switch at the top of the Calendar queue; B, a chip in the header on every view and
a red line across the top while paused, with "‖ held" on held posts and in a post's Publishing box; C, the confirm
dialog with scope, reason and resume. Not yet: "Pause and tell Slack" (needs a Slack webhook and Chris's OK to
post), and automations pausing too (none exist yet).

### Reels and videos (built 1 Nov)

A published page can't reach Storage, so the desk ("Video to publish" on any video post going to Facebook or
Instagram) sends the MP4 or MOV through `engine_video` in 2 MB pieces (`part`), then `done`, which checks every
piece is there and the sizes add up, and returns `{prefix, parts, size, sha256, mime, name}`. The desk saves it
as `publishVideo` and the approved snapshot carries it as `final.<platform>.video`. The publisher joins the pieces
on the Mini (`P.assembleVideo`: size, SHA-256 and the MP4/MOV header checked) and uploads the file straight to
Meta: Facebook as a Page video (`graph-video …/{page}/videos`, the text as its description), Instagram as a Reel
(resumable upload to rupload.facebook.com, then it waits up to about 4.5 minutes for Instagram to finish
processing before publishing; longer and it tries again next run). No public link to the file is ever made. Up to
150 MB; pieces live in the private `engine-media` bucket (which now also takes application/octet-stream).
"Use the attached video" sends a clip already on the post (`video.url`). The Reel's cover is the post's card,
stored with the snapshot (`final.instagram.cover`) and sent as `cover_url`. Once every Facebook and Instagram
destination is out, the publisher removes all the post's video pieces, replaced uploads included
(`P.clearVideoPieces`, recorded as `videoPieces.clearedAt`). Not yet: posting the motion video made on the desk
without saving it first.

### Instagram Stories (built 1 Nov)

On a post with Story frames going to Instagram, the desk's Posting panel has "Also post the Story to Instagram"
(`posting.story`). The snapshot then renders each frame as a JPEG (`engine_media` platform `story`) into
`final.story = {media, skipped}`. Poll frames are left out and the desk says so: the Graph API can't add stickers,
so they are added by hand. The publisher gives each Instagram destination a second slot, `<account>:story`
(`P.slotsOf`), at the same time as the post, with its own claim, errors and `published` entry; each frame goes out
as its own `STORIES` container. If a frame fails after others are up, the slot stops for good with "N of M Story
frames went up", so nothing is posted twice. Facebook Pages get the same (built 1 Nov, later): a `<account>:story`
slot, each frame uploaded as an unpublished photo then posted with `/{page}/photo_stories` (Page Stories API; needs
the same CREATE_CONTENT task and pages_manage_posts as posts). The desk's tickbox names whichever of Instagram and
Facebook the post goes to.

### Instagram collabs (built 1 Nov)

The Posting panel has "Instagram collab" for any post going to Instagram: up to three handles (`posting.collaborators`,
no @), with the draft's suggested handles (`extras.collab.handles`) as one-tap chips. The snapshot copies them to
`final.instagram.collaborators`; the publisher checks them (`P.collaboratorsOf`) and invites them on the feed post,
the carousel itself (not its slides) or the Reel. Each collaborator still has to accept in Instagram. Stories
can't have collaborators. Facebook collaborators are added in Meta Business Suite for now.

### Still to build

- Going live: Connect Facebook switched on (Meta app + Vercel FB_* settings), Chris's OK to lift the Mini's
  "never public posting" rule, then ENGINE_PUBLISH_LIVE=1 and the plist without --dry-run.

## Slice 3: Inbox [chosen 1 Nov]

1. ✅ Engine (built 1 Nov). `engine_inbox` holds comments and DMs on the teams' Facebook Pages and Instagram
   accounts; `engine_inbox_actions` holds every action and is the moderation history.
   - Reading: `collector/inbox.js` on the Mini every 5 minutes (launchd `net.citizengo.content-inbox`, log
     /tmp/content-inbox.log) with the most recently connected person's sealed token per account: comments on the
     last 7 days of Facebook posts and ads (`/ads_posts`, marked `is_ad`), Instagram media comments and their
     replies, and Messenger and Instagram conversations. Read-only on Meta. People's columns (status,
     assigned_to, labels) are never in the collector's upsert, so a re-read can't undo them; our own comments and
     messages arrive done.
   - Acting: `engine_inbox_act`. done, reopen, assign and label apply at once. reply, private_reply (Facebook
     comments, within 7 days), like (Facebook only), hide, unhide and delete need the person's own right on the
     account and are queued with a 10-second undo window (`engine_inbox_undo`); DM replies only within 24 hours of
     their last message (Meta's rule) and go to whoever wrote last. `collector/inbox-actions.js` (launchd
     `net.citizengo.content-inbox-actions`, every minute, `--dry-run` hard-coded) sends them with that person's
     token, records the result, and marks replied items done. Live needs ENGINE_INBOX_LIVE=1, the plist without
     --dry-run, and Chris's OK: public replies are public posting.
   - `engine_inbox_history`: the moderation history, newest first.
   - Connect Facebook now also asks for pages_read_user_content, pages_manage_engagement, pages_messaging,
     instagram_manage_comments and instagram_manage_messages, so anyone already connected connects again.
   - Tests: `npm run test:inbox`.
2. ◐ Desk Inbox view (built 1 Nov in content-engine/desk.html, tab "Inbox" with the open count). Conversations:
   filters All / Facebook / Instagram / Messages / Assigned to me and Open / Done, AD and hidden markers, the post or
   ad it's on, the thread or conversation. Reply box with the checks on one line beside Send (option A: under an
   ad, tracked cgo.ac link or not, Messenger's 24-hour rule); "Draft with Claude" gives three replies in CitizenGO's
   voice (the viewer's own allowance, `sample`), and `[ACTION LINK]` must be replaced before sending. Done, Assign
   to me, Label, Like (Facebook), Hide / Unhide, Delete (asks first), Send as private message (Facebook comments);
   Meta actions show "Sending…" with Undo for 10 seconds. Moderation history tab. Tested in a stubbed harness.
   By post (built 1 Nov, later): `engine_inbox_posts` groups the last 7 days' comments by post or ad (comments, open,
   hidden, our replies; most open first; Ads filter); picking one lists its comments, and opening a comment goes to
   it in Conversations. Supporter history: `engine_inbox_person` (90 days on the team's accounts: comments,
   messages, on ads, hidden by us, labels, recent) shown above the comment. Tracked-link clicks per person aren't
   possible (links aren't tied to a Facebook or Instagram user). Not yet: bulk by topic.
   Auto-hide list (built 1 Nov): `engine_inbox_rules` (each team: words, phrases, "any link that isn't
   citizengo.org or cgo.ac", and the built-in scam phrases in `lib/inbox.js` SCAM_PHRASES), changed by team admins
   with `engine_inbox_rule`, shown at the top of the desk's Moderation tab. Plain matching only (no regular
   expressions from people). The inbox collector checks each new comment once (`auto_checked_at`, comments from the
   last 2 days) and queues a hide, never a delete, as the person who made the rule, labelled auto-hidden; the
   action worker sends it like any other (so it stays in dry run with the rest). History shows "Auto-hide: <why>".
   Pile-on alert (built 1 Nov): after each read the collector looks for a post with at least 10 comments in the
   last hour, 3x its account's normal pace (comments per post per active hour, last 7 days) and at least 30%
   hostile (`I.HOSTILE_WORDS` or the auto-hide rules; no paid AI). One `engine_inbox_alerts` row per post per 6
   hours. `engine_inbox` returns the last 24 hours' open alerts; the desk shows a red banner (See its comments,
   Open the post, Seen) and a red ! on the Inbox tab; `engine_inbox_alert` marks one seen for the team. Slack
   messages wait for Chris's OK and a webhook.
   Bulk by topic (built 1 Nov): "✨ Sort by topic" in Conversations sends the open comments (up to 150) to Claude on
   the viewer's own allowance, which groups them (2-8 groups, every comment once; made-up ids dropped, left-overs
   in "Other") with a suggested action and two or three replies in CitizenGO's voice. Each group has "Reply to all"
   (wordings separated by a blank line, rotated; `[ACTION LINK]` must be replaced); ticked groups can be liked,
   hidden, marked done, assigned or labelled with the group's name. `engine_inbox_bulk` applies the same rules as
   one at a time (`actOn`), refusals are listed (DMs are answered one by one; Instagram likes refused), and
   Facebook and Instagram actions wait 30 seconds so `engine_inbox_undo action_ids` can undo the whole batch.
3. ⬜ Later: automations (comment to DM), X, pile-on alert to Slack.

## Slice 3 onwards

Inbox (conversations, Assistant, bulk by topic, by post, moderation and history, automations flow builder, tracked
links 1 + 3), Listening (on the phase-2 monitoring tables), Analytics (CitizenGO dashboard by default), Page Inviter
tab, team and access screens.
