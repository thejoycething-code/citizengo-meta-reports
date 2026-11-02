# Content Engine: what the mock-ups promise that isn't built yet

Desk changes live in content-engine/desk.html (outside this repo); each batch is published to the test link.

Checked frame by frame against the Phase 2 canvas (38 frames) on 1 Nov 2026. Work through in order; tick as
built. Items marked **(needs Chris)** depend on an outside permission, a sign-off or money and are built only
as far as that allows.

## 1. Layout and navigation
- [x] Sidebar replacing the tab row (header "GO Content Engine"), sections by the life of a post:
      Content Engine (Posts, Evergreen) · Calendar (Calendar, Plan) · Inbox (Conversations, Assigned to me,
      By post, Automations, Moderation) · Listening (Mentions, Allies and opponents, …) · Analytics (Overview)
      · Tools (Page Inviter). Never more than about 15 links.
- [x] Action badges only where action is needed (Posts to review, Evergreen due, Conversations, Assigned to me,
      Moderation flagged, Mentions); Analytics never badges.
- [x] Country switcher at the top that filters every screen (the team picker; per-account filtering is in Analytics' account picker, §9).
- [x] Minimal footer: initials, name, "● live", Settings · Help. (Sign out left out: a claude.ai page can't sign anyone out of claude.ai, so the link would do nothing.)
- [x] Publishing live at the sidebar foot: "Publishing live · 6 scheduled · next at 14:00", red "Paused · n held".
- [x] Settings area: your access per account and Connect Facebook. Team and access for admins comes with §7.

## 2. Posts desk
- [x] Where and when per account: each destination its own time with its own ★, "Same time everywhere" toggle;
      "Approve · goes out at these times".
- [x] Approve ▾: Post now, Add to queue (next free best slot).
- [x] 📱 Feed preview in a phone frame per platform, first comment under it.
- [x] Previews per placement (FB feed 4:5, IG feed 4:5, IG grid 3:4, Reel cover 9:16, Story 9:16, X 16:9),
      amber where something is cut off; "Preview every placement" link.
- [x] Story view (in the preview); Instagram link in bio as a reminder (the API can't change the bio).
- [x] Ready checks: "✓ Links tracked"; campaign label (auto).
- [x] ✨ Rewrite on the first comment; "Stronger hook" chip (the free "Tell Claude what to change" box was already there).
- [x] Comment to DM ("SIGN") on the draft, on by default for petition posts, untickable. (Built with §5.) Done 1 Nov: a tick box on the draft's Post tab, saved as posting.comment_dm. It DMs the post's own cgo.ac link; someone who already got it just gets a like.
- [x] Instagram collab picker of CitizenGO accounts, alongside free handles (3 in all, Instagram's limit).

## 3. Calendar and Plan
- [x] Drag a post or idea onto a day to schedule / request it.
- [x] Each day's free best-time slots ("+ free 19:00").
- [x] "→ draft it" on key dates in the grid and the queue.
- [x] Evergreen due items in the queue and as a Plan tray tab.
- [x] Week heading with its theme ("Red Week · 3 posts, 2 key dates").
- [x] Key date categories (CitizenGO-wide, church calendar, awareness day, country only, new suggestion) and a
      year list.
- [x] Images-only month view (grid planner).

## 4. Inbox
- [x] Channel tabs with counts: Facebook, Messenger, Instagram (comments), Instagram DMs, X · later.
- [x] Filters: Moderated (hidden, deleted); Organic and ads / Ads only; sort Newest / Supporters first.
- [x] Tick boxes on rows and a bulk bar (Like · Hide · Label · Assign · Done · Delete).
- [x] Ad banner: ad name, account, comment count, "Open all comments on this ad".
- [x] Assign to a named colleague (people with reply rights on that Page).
- [x] Assistant one-tap combos ("Thanks! We've sent you the link 💌 (+ DM)", "❤️ and done"); saved replies;
      live petition picker.
- [x] Reply checks: petition live (H12), house style.
- [x] Automatic "Supporter" and question tags by rule (no paid AI).
- [x] Moderation tabs Flagged / History / Banned / Rules; history filters; CSV export; ban and unban
      (Facebook Page block); threats kept as a saved copy, never deleted. Ban is a new action value: claude.ai passes it once the connector is refreshed (one reconnect at the end of the build).
- [x] By post: the post beside its comments, answered count, topics, sort, inline reply / hide, state tags.
- [x] Presence and live updates (room); assignment notices.
- [ ] Pile-on and pause messages to Slack: not for now (Chris, 2 Nov). X Inbox: not for now (Chris, 1 Nov).

## 5. Automations (flow builder)
- [x] Applies to: this post / post type (petition, prayer, Reel, wins, news reaction) / all posts, with precedence.
- [x] Instagram comment-to-DM; account scope.
- [x] Steps: trigger words, rotated public replies, DM, optional wait (≤23 h, only if no click), condition
      (already has the link → just react), tag and hand over. Done 1 Nov except the wait step, which needs click data and comes with §6.
- [x] Per-step stats; Test on my account; Rewrite in CitizenGO voice. (Test it is a dry run on the desk: it shows which rule answers and what would be sent. A real send to your own account waits for Inbox live mode.)
- [x] Pause everything also pauses automations.

## 6. Tracked links
- [x] Rewrite on send: citizengo.org links in replies and DMs become Copilot cgo.ac links (on the Mini),
      owner = the sender's initials, series FBR / IGR / FBDM / IGDM; chip turns green before sending. Done 1 Nov, minted on Vercel at queue time (docs/tracked-links.md). Agreed with Chris: the series stays FB1/IG1, the marker (DM/RE/ADM/ARE) and sender initials go at the front of the title in utm_campaign, and Copilot being down means the long link with the same code. The chip shows once the link is made: the send toast says ✓ tracked.

## 7. Team, access and countries
- [x] Settings › Team and access: per person and Page, Post / Reply and DM / Moderate / Analytics, source
      (Meta / admin narrowed); admins narrow, never widen. Done 1 Nov: engine_access; limits in engine_access_limits, applied in engineRights({kind}) for approve/save, inbox, the Mini publisher and the sender; initials for tracked links.
- [x] Per-country calendar switcher; lock banner on other countries; "Copy as an idea to <my team>". Done 1 Nov: "Copy as an idea" adds a Plan request (engine_request) rather than a draft copy.

## 8. Listening
- [x] Topics tab; mentions count. Done 1 Nov: Topics merges allies, opponents and CitizenGO (engine topics per tab); mentions count is the sidebar badge.
- [x] Rework team picker for people in several teams; Share. Done 1 Nov: "Rework for" picker when in several teams; Share saves to the artifact db (listenShares) and copies the link.
- [x] Convergence "building" (one account twice) before the alert. Done 1 Nov: engine building[] (one account twice, or two accounts).
- [x] Language tag and filter; HazteOir filter off by default; "Already reworked by"; landed drafts marked
      "From <Page>" with the original's numbers. Done 1 Nov: lang from common words (no paid AI); HazteOir Pages included but hidden by default; reworked[] from Plan requests; drafts show "From <Page>" with the original's numbers.
- [x] Sentiment without paid AI. Done 2 Nov: tone from English and Spanish word lists and emoji (lib/sentiment.js), with "not" flipping the next words; on every Inbox item, Negative first sort, each post's comment tone in By post, and on Listening › Mentions. It is the tone of the words, not whether someone agrees with us. Digest by Slack or email: not wanted (Chris, 1 Nov). Opponent-watch data protection: signed off by Chris 1 Nov (public information only).

## 9. Analytics
- [x] Account picker: search, saved groups, platform filter, multi-select, compare side by side. Done 1 Nov: on the desk (search, platform, tick, compare side by side); saved groups in the artifact db (analyticsGroups).
- [x] Account selector on the Facebook, Instagram and X pages; X date range and KPIs (engagements, rate,
      link clicks, profile clicks); Facebook views, post engagements, median engagement; every post ranked. Done 1 Nov: account selector on each platform page; X impressions, engagements, rate, link and profile clicks; Facebook views, post engagements, median engagement and every post ranked (team scope; top posts across every Page).
- [x] Overview: followers total with net, fastest growing, best post tiles; page growth chart; format and
      language tags in top posts. Done 1 Nov: followers with net, fastest growing, best post tiles, the 12-week chart (net follows metric), format and language tags.
- [x] Phase 2 figures: comment-to-DM links sent, clicks on reply and DM links. Done 1 Nov except clicks: comment-to-DM links sent and tracked links in replies/DMs; clicks need shortener click data.
- [x] Signatures from social (Looker on the Mini). Done 1 Nov: the nightly Looker pull (link_signatures) joined to each post's tracked links by campaign code, on team Analytics, plus signatures from reply and DM links by marker.

## 10. Tools
- [x] Tools › Page Inviter: version, download, install steps, what's new, guide links, team usage. Done 1 Nov (test link v14): version, install and update steps, what's new, guide link (draft), team usage (page_inviter_usage, 7/30/90 days). Download button waits for the zip to be uploaded as an artifact asset (it carries the built-in token, so only with Chris's OK).
