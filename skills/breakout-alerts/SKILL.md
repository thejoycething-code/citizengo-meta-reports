---
name: meta-breakout-alerts
description: Each morning, announce any CitizenGO post that has passed 100,000 views to #comm-social-networks, deduplicated so translated copies are not announced twice
---

Announce any CitizenGO Facebook post that has passed **100,000 views** to the Slack channel **#comm-social-networks** (channel id `C7YFZ17MH`), so other pages can consider reworking it for their own audience.

All the judgement — which posts qualify, which are duplicates, and the exact wording — is already done by a script. Your job is to run it, post what it returns, and record what you posted. **Do not compose your own message and do not recalculate any figure.**

**Step 1 — get today's decisions.**

```
export PATH="$HOME/.local/node/bin:$PATH"
cd "/Users/chrisjoyce/Desktop/Claude Code Projects/Meta Reports"
npm run -s alerts:breakout -- --json
```

This prints JSON on stdout. Diagnostics go to stderr, so ignore those. The shape is:

- `announce` — an array of posts to announce. Each has `post_id`, `page`, `views`, `permalink` and **`slack_text`**, which is the complete, ready-to-send message.
- `suppressed` — posts over 100,000 views that were deliberately NOT announced, with the reason. These are copies of a story already announced. **Never post these.**
- `channel` — the channel id to post to.

**If `announce` is empty, stop.** Say briefly that there was nothing over 100,000 views to announce today and finish. That is the normal outcome most days — roughly one alert every two or three days. Do not post anything, and do not report the suppressed items to the channel.

**Step 2 — post each one.**

For every entry in `announce`, send its `slack_text` to channel `C7YFZ17MH` using the Slack connector, **exactly as given, with no edits**. The text is already Slack mrkdwn: `*bold*`, `<url|label>` links, and a leading line saying the message is automated. Reformatting it will break the links.

Post them one at a time and note whether each succeeded.

**Step 3 — record only what actually posted.**

For the entries that posted successfully, pass their `post_id` values back so they are never announced again:

```
npm run -s alerts:breakout -- --record <post_id> <post_id>
```

This matters: recording happens **only** after Slack has accepted the message. If a post failed to send, leave it out — it will be offered again tomorrow rather than being silently lost.

**Step 4 — tell Chris what happened**, in the terminal only: which posts were announced, and which were suppressed and why. Keep it to a few lines.

Notes:
- Node is at `~/.local/node/bin` and is not on the default PATH, hence the export.
- HazteOir is excluded by design — its median post is around 25,000 views, so 100,000 is routine rather than news there.
- The dedup rule: a post is announced when it passes 100,000 views. A later copy of the same story in the same format is not, unless it appears 35 days or more after the story's first post, in which case it is announced as a revival. A *different format* on the same story — a video where a photo was already announced — is always announced, because it is a different piece of work.
- If the script errors, report the error to Chris and post nothing. Do not attempt to work around it by writing your own message.