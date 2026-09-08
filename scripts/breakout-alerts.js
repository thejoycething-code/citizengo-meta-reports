#!/usr/bin/env node
'use strict';
// Announce a post to #comm-social-networks once it passes 100,000 views, so
// other pages can consider reworking it.
//
//   node scripts/breakout-alerts.js              # dry run, prints what it would post
//   node scripts/breakout-alerts.js --post       # posts via webhook, and records it
//   node scripts/breakout-alerts.js --json       # machine-readable, for a skill to post
//   node scripts/breakout-alerts.js --record ID  # mark IDs announced, after posting
//   node scripts/breakout-alerts.js --all        # ignore the alert log, for previewing
//
// TWO WAYS TO POST. --post needs SLACK_BREAKOUT_WEBHOOK_URL, which needs Slack
// app permissions. Where those are not available, --json hands the decisions to
// a caller that already has a Slack connector (a scheduled Claude task), which
// posts them and then calls --record. Either route keeps the rule that an
// announcement is recorded ONLY after Slack has accepted it, so a failure
// retries tomorrow instead of being silently marked done.
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

const POST = process.argv.includes('--post');
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

    toSend.push({
      post, story, mediaType, pageName, metrics: latest[post.post_id],
      body: render({ post, pageName, otherPages, metrics: latest[post.post_id], revival }),
      bodyMarkdown: render({ post, pageName, otherPages, metrics: latest[post.post_id], revival, flavour: 'markdown' }),
    });
    pending.push({ post_id: post.post_id, story_key: story.story_key, media_type: mediaType, first_post_at: story.first.created_time });
  }

  if (RECORD) {
    if (!RECORD.length) { console.error('--record needs at least one post id.'); process.exit(2); }
    const wanted = new Set(RECORD);
    const rows = toSend.filter((i) => wanted.has(i.post.post_id)).map((i) => ({
      story_key: i.story.story_key, post_id: i.post.post_id, page_id: i.post.page_id,
      media_type: i.mediaType, views_at_alert: i.metrics.views_total,
      first_post_at: i.story.first.created_time,
    }));
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
      channel: process.env.BREAKOUT_CHANNEL || 'C7YFZ17MH',
      candidates: candidates.length,
      announce: toSend.map((i) => ({
        post_id: i.post.post_id, page: i.pageName, published: i.post.created_time,
        views: i.metrics.views_total, media_type: i.mediaType,
        permalink: i.post.permalink_url || null,
        // Standard Markdown, for the Slack MCP connector that converts it.
        // The --post webhook path sends item.body (Slack mrkdwn) straight to the
        // hook and does not read this payload, so it is unaffected.
        slack_text: i.bodyMarkdown,
      })),
      suppressed: suppressed.map((x) => ({
        post_id: x.post.post_id, page: pages[x.post.page_id],
        views: (latest[x.post.post_id] || {}).views_total || null, reason: x.why,
      })),
    }, null, 2) + '\n');
    console.error(`${toSend.length} to announce, ${suppressed.length} suppressed`);
    return;
  }

  console.error(`candidates over ${n(THRESHOLD)} views, published in the last ${LOOKBACK_DAYS} days: ${candidates.length}`);
  console.error(`  to announce: ${toSend.length}    suppressed as duplicates: ${suppressed.length}`);
  for (const s of suppressed) console.error(`  - ${pages[s.post.page_id]} ${s.post.created_time.slice(0, 10)} (${n(latest[s.post.post_id].views_total)} views): ${s.why}`);

  for (const item of toSend) {
    console.log('\n' + '='.repeat(72));
    console.log(item.body);
  }

  if (!POST) { console.error('\ndry run — nothing posted, nothing recorded. Use --post to send.'); return; }

  const hook = process.env.SLACK_BREAKOUT_WEBHOOK_URL;
  if (!hook) { console.error('SLACK_BREAKOUT_WEBHOOK_URL is not set, so there is nothing to post to.'); process.exit(2); }
  for (const item of toSend) {
    const res = await fetch(hook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: item.body, unfurl_links: false }),
    });
    if (!res.ok) { console.error(`post failed: HTTP ${res.status} ${await res.text()}`); continue; }
    // Recorded only after a successful post, so a Slack failure retries tomorrow
    // rather than being silently marked as done.
    const w = await fetch(`${base}/rest/v1/meta_breakout_alerts`, {
      method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify([{
        story_key: item.story.story_key, post_id: item.post.post_id, page_id: item.post.page_id,
        media_type: item.mediaType, views_at_alert: item.metrics.views_total,
        first_post_at: item.story.first.created_time,
      }]),
    });
    if (!w.ok) console.error(`WARNING: posted but failed to record ${item.post.post_id}: HTTP ${w.status} — it may announce again`);
    else console.error(`posted and recorded: ${item.pageName} ${n(item.metrics.views_total)} views`);
  }
}

main().catch((e) => { console.error('breakout alerts failed:', e.message); process.exit(1); });
