# Asking about our Facebook and Instagram performance

You can now ask Claude or ChatGPT how our organic posts are doing — across every
CitizenGO page and Instagram account we collect — and get an answer from real
data rather than digging through Business Suite page by page.

This takes about two minutes to set up.

---

## Connecting

You'll need an **access token** — ask Chris for yours. It is personal to you, so
don't share it: if it leaks, Chris can cancel yours alone without disturbing
anyone else.

### In Claude (claude.ai, desktop or mobile)

1. **Settings → Connectors → Add custom connector**
2. URL: `https://meta-organic-reporting.vercel.app/api/mcp`
3. Leave Advanced settings empty — you don't need a Client ID or Secret
4. Click **Add**, then **Connect**. A CitizenGO page opens asking for your
   token — paste it and click **Allow access**

Then in any conversation, press **+** → **Connectors** and switch it on.

### In ChatGPT

1. **Settings → Connectors → Create** (or **Add sources → Connect more**)
2. URL: `https://meta-organic-reporting.vercel.app/api/mcp`
3. Authentication: **OAuth** — not "No authentication"
4. Follow the sign-in prompt and paste your token when the CitizenGO page asks

You need a ChatGPT plan that supports custom connectors; on some plans this sits
behind **Settings → Connectors → Advanced → Developer mode**.

**Staying connected.** You'll be asked for your token again about once a month,
and straight away if your access is withdrawn. There is nothing else to renew.

**The URL on its own does not give access** — your token does. The connector
reads our performance figures, including what we spent boosting posts. It
cannot post, change or delete anything.

---

## What to ask

Ask in plain English. Some starting points:

**Comparing pages**
- *Which of our Facebook pages performed best last month?*
- *How is CitizenGO Italia doing compared with the others?*
- *Which pages are growing their followers?*

**Finding posts**
- *What did we post about assisted dying?*
- *Find our posts about marriage and how they did*
- *Show me the top ten posts since last Monday*

**Understanding what worked**
- *Was the Charlie Kirk post any good?*
- *What's normal for CitizenGO Argentina, and what beat it?*
- *Which posts travelled furthest beyond our own followers?*

**Money**
- *Which boosted posts were worth the spend?*
- *What did we pay per person reached last month?*

You can follow up conversationally — *"why did that one do so well?"*, *"show me
the same for France"* — it keeps context.

---

## Reading the answers

A few things are worth knowing, because they're what make the numbers meaningful.

### "3.2× a normal post" beats a raw number

Every post is compared with what **its own page** normally does. A page with 200
followers and one with 200,000 aren't comparable on raw reach, so each is measured
against itself. That's why a strong post on a small page can outrank a bigger post
on a large one — and it should.

### "Beyond followers" is usually the number that matters

The share of people who saw a post **without already following the page**. It's the
closest thing we have to whether something actually travelled, rather than being
shown to the audience we already had. High numbers mean supporters shared it.

### A dash means missing, not zero

Facebook refuses to report some figures — usually on pages with few followers.
Those show as `—` and are left out of totals. **They are gaps in what Facebook
told us, not a post that performed badly.**

### It should match what Facebook shows you

Reactions, comments and shares are counted the way Facebook counts them **on the
post itself**, so they line up with what you see when you open it. If they differ
slightly, it is almost always **timing** — these figures are taken once a night,
and people keep reacting afterwards.

Facebook does publish a second, larger reaction number in its insights, which
also counts reactions people left on *reshares* of your post. On a widely shared
post that runs around 20% higher. We report the first, because it is the one you
can check.

If something is off by more than a little, say so. That is worth looking at, and
it is how a genuine problem gets found.

### If the data is stale, it says so

If collection has stopped, every answer opens with a warning like *"These figures
are 4 days old."* If you see that, mention it to Chris rather than quoting the
numbers as current.

---

## What it covers, and what it doesn't

**Covers:** organic posts across 36 CitizenGO Facebook pages and 8 Instagram
accounts, going back about three months — reach, shares, saves, comments, clicks,
follower growth, and what we spent boosting posts.

**Doesn't cover:**

- **What people wrote in comments** — we count comments but deliberately don't
  store the text. That's a data-protection decision, not an oversight.
- **Pages that haven't granted access** — if a page is missing, it's an access gap
  rather than an inactive page. Ask Chris.
- **Anything paid beyond boosted posts** — full ad reporting lives in Business
  Manager.

---

## If something looks wrong

Claude is reading real data, but it can misread a question. If a number looks
surprising:

- Ask it to **show its working** — *"which posts is that based on?"*
- Ask for the **post links** — every result can link straight to the post
- Check the **date range** it used, and say so explicitly if you meant something else

And if a figure genuinely looks wrong rather than surprising, say so — the
underlying data is checked daily, but that's exactly how errors get caught.
