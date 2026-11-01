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
4. ⬜ Rewire the desk artifact to the engine tools (artifact `mcp` capability) and add Plan › Calendar and queue.
   Keep every existing Claude tool.
5. ⬜ Until Meta publishing works, "Approve" still hands UK posts to Asana as today.

## Slice 2: Meta publishing

- "Connect Facebook" flow per person (pattern: lib/igflow.js), storing the Pages they admin as publishing rights,
  re-checked nightly.
- Scheduled publishing to Facebook and Instagram with the person's own Page access; first comment; Stories;
  Instagram collab invites; Facebook collaborators added in Meta Business Suite for now.
- Pause everything (A + B + C).

## Slice 3 onwards

Inbox (conversations, Assistant, bulk by topic, by post, moderation and history, automations flow builder, tracked
links 1 + 3), Listening (on the phase-2 monitoring tables), Analytics (CitizenGO dashboard by default), Page Inviter
tab, team and access screens.
