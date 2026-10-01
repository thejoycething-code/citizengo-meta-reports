#!/usr/bin/env node
'use strict';
// Announce a post to #comm-social-networks once it passes 100,000 views, so
// other pages can consider reworking it.
//
//   node scripts/breakout-alerts.js              # dry run, prints what it would post
//   node scripts/breakout-alerts.js --json       # machine-readable, for a skill to post
//   node scripts/breakout-alerts.js --record ID  # mark IDs announced, after posting
//   node scripts/breakout-alerts.js --all        # ignore the alert log, for previewing
//
// ONE WAY TO POST: the scheduled Claude task on Christopher's computer
// (skills/breakout-alerts/SKILL.md). It reads --json, fact-checks each post,
// posts through its Slack connector and then calls --record, so an
// announcement is recorded ONLY after Slack has accepted it and a failure
// retries tomorrow instead of being silently marked done.
//
// There used to be a second route, --post, sending through a Slack webhook from
// the nightly GitHub workflow. It was removed on 29 Sept 2026, because every
// alert must be fact-checked and the fact check runs as a skill on
// Christopher's computer, on his own Claude usage. A route that could post
// without it has no place here.
//
// WHAT COUNTS AS A DUPLICATE, which is the whole difficulty.
//
// The Olivia Maurel surrogacy story ran on nine pages in five languages inside a
// week. Announcing each copy would be noise. But a VIDEO of Olivia and a PHOTO
// of Olivia are two different pieces of work, and if both pass 100,000 views
// both are worth surfacing. So the dedup key is the story AND the media type -
// keying on topic alone would have silently swallowed the second format.
//
// A copy that appears REVIVAL_DAYS or more after the story's first post is
// announced again: at that distance it is a deliberate revival of old material
// rather than a simultaneous translation, and that is itself the useful signal.
//
// HazteOir is excluded. Its median post is ~25,000 views, so 100,000 is routine
// rather than news there, and including it produced 26 of 37 alerts in testing -
// it would have drowned the channel. It can have its own rule if it wants one.
//
// X POSTS (added 2 Oct 2026) have their own rule, chosen by Christopher from the
// last 90 days of data: 10,000 ORGANIC impressions OR 250 interactions (likes +
// reposts + quotes + replies + bookmarks, the X Analytics definition, counted
// organically where X splits them - see interactionsOf).
//   - Organic, not total: total impressions include paid boosts, and the old
//     all-time leaders were plainly ads (Netflix, 1.36M impressions and 200
//     interactions). X gives the split for ~89 days, which covers any post young
//     enough to alert on. A read without it never qualifies on impressions.
//   - Interactions as a second route: Justin Bieber on Canada had 16.7k
//     impressions and 3,253 interactions - spreading, and exactly what another
//     page would rework - while Sall Grover reached 42k with 68.
//   - Absolute, not per account: followers run from 95 to 40,000, and "10x its
//     own median" would announce 500-impression posts from Belgium.
// 100,000 would have fired once in 90 days; this rule fires about twice a week.
// Replies are left out (37% of X posts, nearly all conversation). Dedup is the
// same story-and-format rule, within X only: an X post of a story already
// announced from Facebook is a different piece of work and is announced.

const { cluster, shouldAnnounce } = require('../lib/stories');
const { loadEnv } = require('../lib/graph');
loadEnv();

const THRESHOLD = Number(process.env.BREAKOUT_VIEWS || 100000);
const REVIVAL_DAYS = Number(process.env.BREAKOUT_REVIVAL_DAYS || 35);
const EXCLUDE_PAGES = String(process.env.BREAKOUT_EXCLUDE_PAGES || '154268578340')
  .split(',').map((s) => s.trim()).filter(Boolean);
// How far back to look for candidates. Deliberately short: this runs nightly and
// a post that crossed the line weeks ago is not news.
//
// Cut from 10 to 4 on 8 Sept 2026, after both of the first two live alerts were
// deleted by hand for being stale: a 28 Aug post announced on 7 Sept, and a
// 2 Sept post announced on 8 Sept. The cause is upstream - meta_post_metrics
// refreshes only ~370 posts a day and sweeps all ~2,650 irregularly, so a post
// that crosses 100,000 views after leaving the daily slice is unseen until the
// next sweep, by which time it is a week old. Four days will therefore emit
// nothing most days: on the day of the change it took the candidate count from
// 2 to 0. That is the intended trade - a rare fresh alert is worth acting on,
// a stale one is not. Raise this again if the daily collection is ever widened.
const LOOKBACK_DAYS = Number(process.env.BREAKOUT_LOOKBACK_DAYS || 4);
// How far back to read for CLUSTERING, which must be able to see a story's first
// post even when it is older than the revival window.
const CLUSTER_DAYS = Number(process.env.BREAKOUT_CLUSTER_DAYS || 75);
// X thresholds; see "X POSTS" above. Either one qualifies.
const X_IMPRESSIONS = Number(process.env.BREAKOUT_X_IMPRESSIONS || 10000);
const X_INTERACTIONS = Number(process.env.BREAKOUT_X_INTERACTIONS || 250);
const X_EXCLUDE = String(process.env.BREAKOUT_X_EXCLUDE_ACCOUNTS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const ALL = process.argv.includes('--all');
const JSON_OUT = process.argv.includes('--json');
// --record p1 p2 / --record p1,p2 — the ids a caller successfully posted.
const RECORD = (() => {
  const i = process.argv.indexOf('--record');
  if (i === -1) return null;
  return process.argv.slice(i + 1).filter((a) => !a.startsWith('--'))
    .flatMap((a) => a.split(',')).map((a) => a.trim()).filter(Boolean);
})();

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_MCP_KEY;
if (!url || !key) { console.error('SUPABASE_URL and a Supabase key are required.'); process.exit(2); }
const base = url.trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
const H = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };

const n = (v) => Number(v || 0).toLocaleString('en-GB');
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();

async function readAll(path) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(`${base}/rest/v1/${path}&limit=1000&offset=${offset}`, { headers: H });
    if (!res.ok) throw new Error(`read ${path.split('?')[0]}: HTTP ${res.status}`);
    const batch = await res.json();
    if (!Array.isArray(batch) || !batch.length) break;
    out.push(...batch);
    if (batch.length < 1000) break;
  }
  return out;
}

// TWO FLAVOURS, because the two posting routes want different syntax and getting
// it wrong mangles every link in the message:
//   'mrkdwn'   for an incoming webhook - *bold*, <url|label>
//   'markdown' for the Slack MCP connector, which takes standard Markdown and
//              converts it itself - **bold**, [label](url)
// Caught before the first live post: the JSON path feeds the connector, so it
// must not emit mrkdwn.
function render({ post, pageName, otherPages, metrics, revival, flavour = 'mrkdwn' }) {
  const md = flavour === 'markdown';
  const b = (t) => (md ? `**${t}**` : `*${t}*`);
  const link = (url, label) => (md ? `[${label}](${url})` : `<${url}|${label}>`);
  const beyond = (metrics.views_total && metrics.views_from_nonfollowers != null)
    ? Math.round((metrics.views_from_nonfollowers / metrics.views_total) * 100) : null;
  const text = String(post.message || '').replace(/\s+/g, ' ').trim();
  const quote = text.length > 240 ? text.slice(0, 239) + '…' : (text || '(no text)');

  const L = [];
  L.push('_Automated alert from the Meta reporting connector._');
  L.push('');
  L.push(`${md ? '🚀' : ':rocket:'} ${b(n(metrics.views_total) + ' views')} — ${pageName}`);
  L.push('');
  L.push('> ' + quote);
  L.push('');
  const facts = [];
  if (beyond !== null) facts.push(`${b(beyond + '%')} of its reach was beyond our own followers`);
  if (metrics.reactions_total) facts.push(`${n(metrics.reactions_total)} reactions`);
  if (metrics.shares_total) facts.push(`${n(metrics.shares_total)} shares`);
  if (metrics.comments_total) facts.push(`${n(metrics.comments_total)} comments`);
  facts.push(post.media_type || 'post');
  L.push(facts.join(' · '));
  if (post.permalink_url) L.push(link(post.permalink_url, 'See the post'));
  L.push('');
  if (revival) {
    L.push(`This story first ran on ${revival.first}, ${revival.days} days ago, and is working again — worth a second look if you skipped it first time.`);
  } else if (otherPages.length) {
    // Each page links to ITS OWN copy, not to the post being announced: someone
    // deciding whether to run this wants to see how it was written for an
    // audience like theirs, and a bare list of page names makes them hunt.
    //
    // EVERY page, not a capped list. A cap of six hid Citizengo México behind
    // "and 1 more" - and the pages left out are exactly the ones a reader needs
    // in order to know who has already covered this and who has not.
    const shown = otherPages.map((o) => (o.url ? link(o.url, o.name) : o.name));
    L.push(`Already running on ${shown.join(', ')}.`);
  }
  L.push(`${b('Could this work on your page?')} It is proven copy — worth asking ${pageName} for the assets before writing something new.`);
  return L.join('\n');
}

// Likes, reposts and replies come from the ORGANIC split wherever X gives one;
// quotes and bookmarks have no organic split and are taken as they are. Equal to
// the public counts on 130 of 131 posts tested. The exception is why: Samuel
// Adrián on Latam showed 474,375 impressions, 3,622 organic, promoted 0 - a
// boost the API does not label - and 725 likes of which 36 were organic.
const organicOr = (m, k) => (m['organic_' + k] != null ? m['organic_' + k] : m[k]);
const interactionsOf = (m) => Number(organicOr(m, 'likes') || 0) + Number(organicOr(m, 'reposts') || 0)
  + Number(organicOr(m, 'replies') || 0) + Number(m.quotes || 0) + Number(m.bookmarks || 0);

// The X alert. Standard Markdown only: it goes through the Slack connector, never
// a webhook. Same skeleton as the Facebook alert so the skill's fact-check block
// lands in the same place (under the first line, or at the end).
function renderX({ post, accountName, otherAccounts, metrics, revival }) {
  const b = (t) => `**${t}**`;
  const organic = metrics.organic_impressions;
  const interactions = interactionsOf(metrics);
  const text = String(post.message || '').replace(/\s+/g, ' ').trim();
  const quote = text.length > 240 ? text.slice(0, 239) + '…' : (text || '(no text)');
  // Lead with whichever threshold it crossed; impressions when it crossed both.
  const byReach = organic != null && organic >= X_IMPRESSIONS;

  const L = [];
  L.push('_Automated alert from the X reporting connector._');
  L.push('');
  L.push(`🚀 ${b(byReach ? n(organic) + ' organic impressions' : n(interactions) + ' interactions')} — ${accountName} on X`);
  L.push('');
  L.push('> ' + quote);
  L.push('');
  const facts = [];
  if (byReach) facts.push(`${n(interactions)} interactions`);
  else if (organic != null) facts.push(`${n(organic)} organic impressions`);
  for (const k of ['reposts', 'likes', 'replies']) if (organicOr(metrics, k)) facts.push(`${n(organicOr(metrics, k))} ${k}`);
  if (metrics.url_link_clicks) facts.push(`${n(metrics.url_link_clicks)} link clicks`);
  if (metrics.video_views) facts.push(`${n(metrics.video_views)} video views`);
  if (metrics.promoted_impressions) facts.push(`plus ${n(metrics.promoted_impressions)} paid impressions`);
  facts.push(post.media_label);
  L.push(facts.join(' · '));
  // Total far above organic with no paid figure: a boost the API does not label.
  // Said plainly, because the reader may compare against X's own count.
  const unlabelled = (metrics.impressions || 0) - (organic || 0) - (metrics.promoted_impressions || 0);
  if (organic != null && unlabelled > Math.max(1000, organic)) {
    L.push(`_X counts ${n(metrics.impressions)} impressions in all, most of them not organic — probably a boost the API does not label. The figures above are organic only._`);
  }
  if (post.permalink_url) L.push(`[See the post](${post.permalink_url})`);
  L.push('');
  if (revival) {
    L.push(`This story first ran on ${revival.first}, ${revival.days} days ago, and is working again — worth a second look if you skipped it first time.`);
  } else if (otherAccounts.length) {
    L.push(`Also on X from ${otherAccounts.map((o) => (o.url ? `[${o.name}](${o.url})` : o.name)).join(', ')}.`);
  }
  L.push(`${b('Could this work on your account?')} It is proven copy — worth asking ${accountName} for the assets before writing something new.`);
  return L.join('\n');
}

// X candidates and verdicts, in the same item shape as the Facebook ones.
async function collectX(announced) {
  const accounts = Object.fromEntries((await readAll('x_accounts?select=account_id,username,label'))
    .map((a) => [a.account_id, a]));
  // Originals only: replies are conversation, and retweets are never collected.
  const rows = await readAll(`x_posts?created_at=gte.${ago(CLUSTER_DAYS)}&in_reply_to_user_id=is.null&select=post_id,account_id,created_at,text,media,permalink_url`);
  const posts = rows.map((p) => {
    const kind = (Array.isArray(p.media) && p.media[0] && p.media[0].type) || 'text';
    const label = { photo: 'photo', video: 'video', animated_gif: 'GIF', text: 'text post' }[kind] || kind;
    // created_time/message/page_id are the names lib/stories reads. media_type
    // carries an "x:" prefix so the shared ledger says which platform it was.
    return { ...p, page_id: p.account_id, created_time: p.created_at, message: p.text,
      media_type: 'x:' + kind, media_label: label };
  });
  const since = ago(LOOKBACK_DAYS);
  const fresh = new Set(posts.filter((p) => p.created_time >= since).map((p) => p.post_id));
  const metricRows = await readAll(`x_post_metrics?collected_date=gte.${ago(LOOKBACK_DAYS + 1).slice(0, 10)}&select=post_id,collected_at,impressions,organic_impressions,promoted_impressions,likes,reposts,quotes,replies,bookmarks,organic_likes,organic_reposts,organic_replies,url_link_clicks,video_views`);
  const latest = {};
  for (const m of metricRows) {
    if (!fresh.has(m.post_id)) continue;
    const c = latest[m.post_id];
    if (!c || m.collected_at > c.collected_at) latest[m.post_id] = m;
  }
  const qualifies = (m) => m && ((m.organic_impressions != null && m.organic_impressions >= X_IMPRESSIONS)
    || interactionsOf(m) >= X_INTERACTIONS);
  // For sorting and the ledger's views_at_alert: organic where we have it.
  const reach = (m) => (m.organic_impressions != null ? m.organic_impressions : 0);

  const stories = cluster(posts);
  const storyOf = new Map();
  for (const s of stories) for (const m of s.members) storyOf.set(m.post_id, s);
  const announcedPosts = new Set(announced.map((a) => a.post_id));
  const nameOf = (id) => (accounts[id] && accounts[id].label) || (accounts[id] && accounts[id].username) || id;

  const candidates = posts
    .filter((p) => fresh.has(p.post_id) && !X_EXCLUDE.includes(p.account_id))
    .filter((p) => qualifies(latest[p.post_id]) && !announcedPosts.has(p.post_id))
    .sort((a, b) => reach(latest[b.post_id]) - reach(latest[a.post_id]));

  const items = []; const suppressed = []; const pending = [...announced];
  for (const post of candidates) {
    const story = storyOf.get(post.post_id);
    const metrics = latest[post.post_id];
    const verdict = shouldAnnounce({ post, story, prior: pending, revivalDays: REVIVAL_DAYS });
    if (!verdict.announce) {
      suppressed.push({ platform: 'x', post_id: post.post_id, page: nameOf(post.account_id),
        published: post.created_time, views: metrics.organic_impressions,
        reason: `${verdict.reason} — first ran on ${nameOf(story.first.account_id)}` });
      continue;
    }
    const best = new Map();
    for (const m of story.members) {
      if (m.post_id === post.post_id || m.account_id === post.account_id) continue;
      if (!best.has(m.account_id)) best.set(m.account_id, { name: nameOf(m.account_id), url: m.permalink_url || null });
    }
    const accountName = nameOf(post.account_id);
    items.push({
      platform: 'x', post_id: post.post_id, page: accountName, published: post.created_time,
      views: metrics.organic_impressions, interactions: interactionsOf(metrics),
      media_type: post.media_label, permalink: post.permalink_url || null, message: post.text || null,
      body: null,
      bodyMarkdown: renderX({ post, accountName, otherAccounts: [...best.values()], metrics, revival: verdict.revival }),
      record: { story_key: story.story_key, post_id: post.post_id, page_id: post.account_id,
        media_type: post.media_type, views_at_alert: reach(metrics), first_post_at: story.first.created_time },
    });
    pending.push({ post_id: post.post_id, story_key: story.story_key, media_type: post.media_type, first_post_at: story.first.created_time });
  }
  return { candidates: candidates.length, items, suppressed };
}

async function main() {
  const pages = Object.fromEntries((await readAll('meta_pages?select=page_id,name')).map((p) => [p.page_id, p.name]));
  const posts = await readAll(`meta_posts?created_time=gte.${ago(CLUSTER_DAYS)}&select=post_id,page_id,created_time,media_type,permalink_url,full_picture,message`);
  const metricRows = await readAll(`meta_post_metrics?collected_date=gte.${ago(CLUSTER_DAYS)}&select=post_id,collected_date,views_total,views_from_nonfollowers,reactions_total,shares_total,comments_total`);
  const latest = {};
  for (const m of metricRows) {
    const c = latest[m.post_id];
    if (!c || m.collected_date > c.collected_date) latest[m.post_id] = m;
  }

  const stories = cluster(posts);
  const storyOf = new Map();
  for (const s of stories) for (const m of s.members) storyOf.set(m.post_id, s);

  const announced = ALL ? [] : await readAll('meta_breakout_alerts?select=post_id,story_key,media_type,first_post_at');
  const announcedPosts = new Set(announced.map((a) => a.post_id));

  const since = ago(LOOKBACK_DAYS);
  const candidates = posts
    .filter((p) => !EXCLUDE_PAGES.includes(p.page_id))
    .filter((p) => p.created_time >= since)
    .filter((p) => (latest[p.post_id] && latest[p.post_id].views_total >= THRESHOLD))
    .filter((p) => !announcedPosts.has(p.post_id))
    .sort((a, b) => latest[b.post_id].views_total - latest[a.post_id].views_total);

  const toSend = [];
  const suppressed = [];
  // Mirrors what this run would have written, so two crossings in one run cannot
  // both slip through as "no prior announcement".
  const pending = [...announced];

  for (const post of candidates) {
    const story = storyOf.get(post.post_id);
    const mediaType = post.media_type || 'unknown';
    const verdict = shouldAnnounce({ post, story, prior: pending, revivalDays: REVIVAL_DAYS });
    if (!verdict.announce) {
      suppressed.push({ post, why: `${verdict.reason} — first ran on ${pages[story.first.page_id]}` });
      continue;
    }
    const revival = verdict.revival;

    // One entry per OTHER page, carrying a link to that page's own copy. Where a
    // page ran it more than once - the global page posted the same thing twice a
    // minute apart - the better-performing copy is the one worth linking to.
    const bestPerPage = new Map();
    for (const m of story.members) {
      if (m.post_id === post.post_id || !pages[m.page_id]) continue;
      const views = (latest[m.post_id] && latest[m.post_id].views_total) || 0;
      const held = bestPerPage.get(m.page_id);
      if (!held || views > held.views) bestPerPage.set(m.page_id, { name: pages[m.page_id], url: m.permalink_url || null, views });
    }
    const otherPages = [...bestPerPage.values()].sort((a, b) => b.views - a.views);
    const pageName = pages[post.page_id] || post.page_id;

    const metrics = latest[post.post_id];
    toSend.push({
      platform: 'facebook', post_id: post.post_id, page: pageName, published: post.created_time,
      views: metrics.views_total, media_type: mediaType, permalink: post.permalink_url || null,
      message: post.message || null,
      body: render({ post, pageName, otherPages, metrics, revival }),
      bodyMarkdown: render({ post, pageName, otherPages, metrics, revival, flavour: 'markdown' }),
      record: { story_key: story.story_key, post_id: post.post_id, page_id: post.page_id,
        media_type: mediaType, views_at_alert: metrics.views_total, first_post_at: story.first.created_time },
    });
    pending.push({ post_id: post.post_id, story_key: story.story_key, media_type: mediaType, first_post_at: story.first.created_time });
  }
  const suppressedRows = suppressed.map((x) => ({
    platform: 'facebook', post_id: x.post.post_id, page: pages[x.post.page_id],
    published: x.post.created_time, views: (latest[x.post.post_id] || {}).views_total || null, reason: x.why,
  }));

  // X runs after Facebook and cannot take it down: a failure there is reported
  // (x_error in the JSON, and on stderr) while the Facebook alerts still go out.
  // It is never swallowed - the skill tells Christopher about it.
  let x = { candidates: 0, items: [], suppressed: [] };
  let xError = null;
  try { x = await collectX(announced); } catch (e) { xError = e.message; console.error(`X alerts failed: ${e.message}`); }

  const items = [...toSend, ...x.items];
  const allSuppressed = [...suppressedRows, ...x.suppressed];

  if (RECORD) {
    if (!RECORD.length) { console.error('--record needs at least one post id.'); process.exit(2); }
    const wanted = new Set(RECORD);
    const rows = items.filter((i) => wanted.has(i.post_id)).map((i) => i.record);
    const unknown = RECORD.filter((id) => !rows.some((r) => r.post_id === id));
    if (unknown.length) console.error(`not among today's announcements, ignored: ${unknown.join(', ')}`);
    if (!rows.length) { console.error('nothing to record.'); return; }
    const w = await fetch(`${base}/rest/v1/meta_breakout_alerts`, {
      method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(rows),
    });
    if (!w.ok) { console.error(`recording failed: HTTP ${w.status} ${await w.text()}`); process.exit(1); }
    console.error(`recorded ${rows.length}: ${rows.map((r) => r.post_id).join(', ')}`);
    return;
  }

  if (JSON_OUT) {
    // stdout is JSON only; every diagnostic goes to stderr, so a caller can pipe
    // this straight into a parser.
    process.stdout.write(JSON.stringify({
      threshold: THRESHOLD, revival_days: REVIVAL_DAYS,
      x_threshold: { organic_impressions: X_IMPRESSIONS, interactions: X_INTERACTIONS },
      channel: process.env.BREAKOUT_CHANNEL || 'C7YFZ17MH',
      candidates: candidates.length + x.candidates,
      x_error: xError,
      announce: items.map((i) => ({
        platform: i.platform, post_id: i.post_id, page: i.page, published: i.published,
        // Facebook: views. X: organic impressions (null if X withheld the split).
        views: i.views, ...(i.platform === 'x' ? { interactions: i.interactions } : {}),
        media_type: i.media_type, permalink: i.permalink,
        // The full caption, for the fact check the scheduled task runs before
        // posting. slack_text quotes only the first 240 characters, and a claim
        // past that point would otherwise go unchecked.
        message: i.message,
        // Standard Markdown, for the Slack MCP connector that converts it.
        slack_text: i.bodyMarkdown,
      })),
      suppressed: allSuppressed,
    }, null, 2) + '\n');
    console.error(`${items.length} to announce (${x.items.length} from X), ${allSuppressed.length} suppressed`);
    return;
  }

  console.error(`Facebook candidates over ${n(THRESHOLD)} views, published in the last ${LOOKBACK_DAYS} days: ${candidates.length}`);
  console.error(`X candidates over ${n(X_IMPRESSIONS)} organic impressions or ${n(X_INTERACTIONS)} interactions: ${x.candidates}${xError ? ' (X FAILED: ' + xError + ')' : ''}`);
  console.error(`  to announce: ${items.length}    suppressed as duplicates: ${allSuppressed.length}`);
  for (const s of allSuppressed) console.error(`  - [${s.platform}] ${s.page} ${String(s.published).slice(0, 10)} (${n(s.views)}): ${s.reason}`);

  for (const item of items) {
    console.log('\n' + '='.repeat(72));
    console.log(item.body || item.bodyMarkdown);
  }
  console.error('\ndry run — nothing posted, nothing recorded. The scheduled task posts, via --json and --record.');
}

main().catch((e) => { console.error('breakout alerts failed:', e.message); process.exit(1); });
