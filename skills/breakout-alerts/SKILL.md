---
name: meta-breakout-alerts
description: Each morning, announce any CitizenGO post that has passed 100,000 views to #comm-social-networks, deduplicated so translated copies are not announced twice
---

Announce any CitizenGO Facebook post that has passed **100,000 views** to the Slack channel **#comm-social-networks** (channel id `C7YFZ17MH`), so other pages can consider reworking it for their own audience.

Which posts qualify, which are duplicates, and the wording of the alert are all decided by a script. Your job is to run it, **fact-check each post**, post the script's message with the fact check added, and record what you posted. **Do not rewrite the script's message and do not recalculate any figure.** The only text you write is the fact-check block described in Step 2.

**Step 1 — get today's decisions.**

```
export PATH="$HOME/.local/node/bin:$PATH"
cd "/Users/chrisjoyce/Desktop/Claude Code Projects/Meta Reports"
npm run -s alerts:breakout -- --json
```

This prints JSON on stdout. Diagnostics go to stderr, so ignore those. The shape is:

- `announce` — an array of posts to announce. Each has `post_id`, `page`, `views`, `media_type`, `permalink`, **`message`** (the post's full caption, which is what you fact-check) and **`slack_text`**, the ready-made alert.
- `suppressed` — posts over 100,000 views that were deliberately NOT announced, with the reason. These are copies of a story already announced. **Never post these.**
- `channel` — the channel id to post to.

**If `announce` is empty, stop.** Say briefly that there was nothing over 100,000 views to announce today and finish. That is the normal outcome most days — roughly one alert every two or three days. Do not post anything, and do not report the suppressed items to the channel.

**Step 2 — fact-check each post.**

Other pages reuse these posts, so each alert carries a fact check made at the moment it is shared. For every entry in `announce`:

1. Read the full `message`. Pick out its **checkable factual claims**: figures, dates, named people and what they said or did, laws and court rulings, votes, and events. Most posts have one to four. Ignore opinion, calls to action, moral judgements and framing ("a scandalous attack on the family"). Those are campaign positions, not facts, and you do not rule on them.
2. Check each claim with web search (load the WebSearch and WebFetch tools with ToolSearch if they are not loaded yet). Prefer primary sources: the court judgment, the official vote record, the government or parliament page, the statistics office. Otherwise use reputable news reporting. Posts are often in Spanish, Italian, Portuguese, Polish or other languages: search in the post's language and in English.
3. Give each claim one verdict:
   - **Verified**: a source supports it as stated.
   - **Wrong**: a source contradicts it (wrong figure, wrong date, misattributed quote, a law that has not passed).
   - **Unverified**: you could not find support either way. An unverified claim is not a wrong one; say so plainly.
   - **Outdated**: it was true, but has since changed (a bill that has moved on, a figure that has been revised).

Then build the fact-check block. Write it **in English, in standard Markdown** (`**bold**`, `[label](url)`), the same format as `slack_text`, and never invent a link: every URL must be a page you actually opened in this run.

If **every** claim is Verified, add this at the very end of `slack_text`, after a blank line:

```
**✅ Fact check:** the claims check out.
• <claim in a few words>: [source](url)
• …
```

If **any** claim is Wrong, Unverified or Outdated, the reader must see it before they reuse the post. Put this block **directly under the first line** of `slack_text` (the "Automated alert…" line), with a blank line either side, and leave the rest of `slack_text` exactly as it is:

```
**⚠️ Check before reusing:** <one line saying what is wrong or unsupported>
• ❌ Wrong: <claim>: <what the source says instead> ([source](url))
• ❓ Unverified: <claim>: no source found
• 🕓 Outdated: <claim>: <what changed> ([source](url))
• ✅ Verified: <claim> ([source](url))
```

Special cases:
- **No checkable claims** (for example a caption that is only a slogan or a prayer): add `**Fact check:** no factual claims in the caption to check.` at the end.
- **A video or image post** (`media_type` is not text): add the line `_The caption was checked; the video or image itself was not._` after the fact-check block. Only the caption is available to you.
- **You cannot run the check** (search is unavailable or keeps failing): post anyway, with `**⚠️ Fact check could not be run today. Verify before reusing.**` directly under the first line. Never let a failed check stop the alert or make it look checked.

Keep the block short: one line per claim and no essays. The alert has to stay readable in a Slack channel.

**Step 3 — post each one.**

For every entry in `announce`, send the `slack_text` **with its fact-check block added as above** to channel `C7YFZ17MH` using the Slack connector. Apart from adding that block, change nothing: the text is standard Markdown, which the connector converts, and editing it will break the links.

Post them one at a time and note whether each succeeded.

**Step 4 — record only what actually posted.**

For the entries that posted successfully, pass their `post_id` values back so they are never announced again:

```
npm run -s alerts:breakout -- --record <post_id> <post_id>
```

This matters: recording happens **only** after Slack has accepted the message. If a post failed to send, leave it out — it will be offered again tomorrow rather than being silently lost.

**Step 5 — tell Chris what happened**, in the terminal only: which posts were announced, the fact-check verdict for each (and any warning it carried), and which were suppressed and why. Keep it to a few lines.

Notes:
- Node is at `~/.local/node/bin` and is not on the default PATH, hence the export.
- HazteOir is excluded by design — its median post is around 25,000 views, so 100,000 is routine rather than news there.
- The dedup rule: a post is announced when it passes 100,000 views. A later copy of the same story in the same format is not, unless it appears 35 days or more after the story's first post, in which case it is announced as a revival. A *different format* on the same story — a video where a photo was already announced — is always announced, because it is a different piece of work.
- If the script errors, report the error to Chris and post nothing. Do not attempt to work around it by writing your own message.
- The fact check covers facts only. Never add a comment on whether the post's position is right, and never soften or drop an alert because you disagree with its framing.