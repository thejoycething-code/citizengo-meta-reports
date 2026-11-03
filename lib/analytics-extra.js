'use strict';
// Analytics boards A and B (Nov 2026): change against the period before,
// daily lines for the headline figures, "what changed" sentences written from
// the figures (no AI), and campaigns: posts grouped by the petition they link
// to, with views and the signatures their tracked links brought (Looker).

const sum = (xs) => { const v = xs.filter((x) => typeof x === 'number'); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
const med = (xs) => { const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null; };
const pct = (a, b) => (typeof a === 'number' && typeof b === 'number' && b > 0 ? Math.round(((a - b) / b) * 100) : null);

// growth rows: pageGrowth store rows (daily, per Page). Returns per-day sums
// for the Pages in scope over the window's days, oldest first.
function dailySeries(rows, pageIds, { now = Date.now(), days = 30 } = {}) {
  const dates = Array.from({ length: days }, (_, i) => new Date(now - (days - i) * 864e5).toISOString().slice(0, 10));
  const idx = Object.fromEntries(dates.map((d, i) => [d, i]));
  const blank = () => dates.map(() => null);
  const out = { dates, reach: blank(), engagements: blank(), net: blank() };
  const add = (k, i, v) => { if (typeof v === 'number') out[k][i] = (out[k][i] || 0) + v; };
  for (const r of rows || []) {
    if (!pageIds.has(r.page_id)) continue;
    const i = idx[String(r.metric_date).slice(0, 10)];
    if (i === undefined) continue;
    add('reach', i, r.media_view_unique); add('engagements', i, r.post_engagements);
    if (typeof r.daily_follows === 'number' || typeof r.daily_unfollows === 'number') add('net', i, (r.daily_follows || 0) - (r.daily_unfollows || 0));
  }
  return out;
}

// Totals for a set of page_growth tool rows (Facebook) and Instagram rows.
function totals(fb, ig, x) {
  return { reach: sum(fb.map((r) => r.reach)), views: sum(fb.map((r) => r.views)), engagements: sum(fb.map((r) => r.engagements)),
    net_follows: sum(fb.map((r) => r.netFollows)), ig_new: sum(ig.map((r) => r.newFollowers)), x_impressions: sum((x || []).map((r) => r.impressions)) };
}
function changes(cur, prev) { const out = {}; for (const k of Object.keys(cur)) out[k] = pct(cur[k], prev[k]); return out; }

// Sentences from the figures. detail: facebookDetail(); top: top_posts;
// sig / sigPrev: signaturesFor totals (team scope only).
function whatChanged({ kpis, prev, detail, top, sig, sigPrev, days }) {
  const out = [];
  const r = pct(kpis.reach, prev.reach);
  if (r !== null && Math.abs(r) >= 5) out.push({ icon: r > 0 ? 'up' : 'down', text: `Facebook reach ${r > 0 ? 'up' : 'down'} ${Math.abs(r)}% on the ${days} days before (${fmt(kpis.reach)} against ${fmt(prev.reach)}).` });
  const f = ((detail && detail.formats) || []).filter((x) => x.posts >= 3);
  if (f.length >= 2 && f[0].median_views && f[1].median_views) {
    const others = med(f.slice(1).map((x) => x.median_views));
    const times = others ? Math.round((f[0].median_views / others) * 10) / 10 : null;
    if (times && times >= 1.3) out.push({ icon: 'format', text: `${f[0].format} posts did best: ${times}× the views of our other formats (median ${fmt(f[0].median_views)}, ${f[0].posts} posts).` });
  }
  const h = ((detail && detail.hours) || [])[0];
  if (h && h.posts >= 3) out.push({ icon: 'time', text: `Best time to post: ${h.when} UK time (median ${fmt(h.median_views)} views over ${h.posts} posts).` });
  const t = (top || [])[0];
  if (t && t.x_median >= 3) out.push({ icon: 'star', text: `Best post: ${t.page}'s ${String(t.format || 'post').toLowerCase()} on ${String(t.created_time).slice(0, 10)} at ${t.x_median}× its Page's normal: “${String(t.text || '').slice(0, 70)}”.` });
  const n = kpis.net_follows, np = prev.net_follows;
  if (typeof n === 'number' && typeof np === 'number' && n !== np) out.push({ icon: n < np ? 'down' : 'up', text: `Net follows ${n < np ? 'fell' : 'rose'} from ${signed(np)} to ${signed(n)}.` });
  if (sig && sigPrev && (sig.total || sigPrev.total)) { const s = pct(sig.total, sigPrev.total); out.push({ icon: 'sign', text: `${fmt(sig.total)} signatures from our posts' links${s !== null ? `, ${s >= 0 ? 'up' : 'down'} ${Math.abs(s)}% on the ${days} days before` : ''}.` }); }
  return out.slice(0, 6);
}
const fmt = (v) => (typeof v === 'number' ? Math.round(v).toLocaleString('en-GB') : '—');
const signed = (v) => (v > 0 ? '+' : '') + fmt(v);

// Campaigns: posts (from signaturesFor's per-post list, every post with a
// tracked link) grouped by petition link. views: Facebook rows and Instagram
// rows matched by the post's live URLs.
const postKey = (u) => { const m = String(u || '').match(/(\d{8,})(?!.*\d{8,})/); return m ? m[1] : String(u || '').replace(/[?#].*$/, '').replace(/\/$/, ''); };
function campaigns(posts, { fbRows = [], igRows = [] } = {}) {
  const fbBy = {}; for (const r of fbRows) if (r.permalink_url) fbBy[postKey(r.permalink_url)] = r;
  const igBy = {}; for (const r of igRows) if (r.permalink) igBy[postKey(r.permalink)] = r;
  const by = {};
  for (const p of posts) {
    const k = String(p.action_url || '').replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/$/, '') || 'no petition';
    const c = by[k] = by[k] || { key: k, title: p.action_title || null, url: p.action_url || null, posts: [], signatures: 0, new_members: 0, views: 0, ig_reach: 0, by_platform: {}, last: null };
    let views = 0, reach = 0;
    for (const u of p.urls || []) { const f = fbBy[postKey(u)]; if (f && typeof f.views_total === 'number') views += f.views_total; const g = igBy[postKey(u)]; if (g && typeof g.reach === 'number') reach += g.reach; }
    c.posts.push({ id: p.id, title: p.title, posted_at: p.posted_at, signatures: p.signatures, views: views || null, ig_reach: reach || null, url: (p.urls || [])[0] || null });
    c.signatures += p.signatures || 0; c.new_members += p.new_members || 0; c.views += views; c.ig_reach += reach;
    for (const [pl, v] of Object.entries(p.by_platform || {})) c.by_platform[pl] = (c.by_platform[pl] || 0) + v;
    if (!c.last || String(p.posted_at) > c.last) c.last = String(p.posted_at || '');
    if (!c.title && p.action_title) c.title = p.action_title;
  }
  return Object.values(by).map((c) => ({ ...c, per_1k: c.views ? Math.round((c.signatures / c.views) * 10000) / 10 : null, posts: c.posts.sort((a, b) => (b.signatures || 0) - (a.signatures || 0)) }))
    .sort((a, b) => b.signatures - a.signatures || b.views - a.views);
}

module.exports = { dailySeries, totals, changes, whatChanged, campaigns, postKey, pct };

// Board C, what works: from a scope's Facebook posts (top_posts rows, usually
// 90 days) with each post's views against its own Page's median (med).
// ukParts(iso) -> { weekday 0=Mon..6, hour } in UK time. topicsOf from
// lib/listen-topics.js (English posts only).
function works(rows, { med = {}, ukParts, topicsOf, langOf, fbFormat } = {}) {
  const scored = rows.filter((r) => typeof r.views_total === 'number');
  const heat = Array.from({ length: 7 }, () => Array.from({ length: 8 }, () => []));
  for (const r of scored) { const p = ukParts(r.created_time); heat[p.weekday][Math.floor(p.hour / 3)].push(r.views_total); }
  const cells = heat.map((row) => row.map((l) => (l.length >= 2 ? { posts: l.length, median_views: Math.round(sumMed(l)) } : (l.length ? { posts: l.length, median_views: null } : null))));
  const group = (keyOf) => { const g = {}; for (const r of scored) for (const k of [].concat(keyOf(r) || [])) (g[k] = g[k] || []).push(r); return g; };
  const asRows = (g, min = 3) => Object.entries(g).filter(([, l]) => l.length >= min).map(([k, l]) => ({ key: k, posts: l.length, median_views: Math.round(sumMed(l.map((r) => r.views_total))),
    median_x: sumMed(l.map((r) => (med[r.page_id] ? r.views_total / med[r.page_id] : null)).filter((x) => x !== null)) })).sort((a, b) => b.median_views - a.median_views);
  const formats = asRows(group((r) => fbFormat(r)));
  const topics = topicsOf ? asRows(group((r) => (langOf(r.message) === 'en' ? topicsOf(r.message) : [])), 3) : [];
  const words = (t) => String(t || '').trim().split(/\s+/).filter(Boolean).length;
  const firstLine = (t) => String(t || '').split('\n')[0];
  const habit = (label, yes, no, test, metric) => {
    const a = scored.filter(test), b = scored.filter((r) => !test(r));
    const val = (l) => sumMed(l.map((r) => (metric === 'rate' ? r.engagement_rate : r.views_total)));
    if (a.length < 10 || b.length < 10) return null;
    const va = val(a), vb = val(b);
    return va && vb ? { label, yes, no, metric, a: va, b: vb, ratio: Math.round((va / vb) * 10) / 10, n_yes: a.length, n_no: b.length } : null;
  };
  const habits = [
    habit('Short text', 'Under 25 words', '25 words or more', (r) => words(r.message) < 25, 'rate'),
    habit('A question in the first line', 'With a question', 'Without', (r) => /\?/.test(firstLine(r.message)), 'rate'),
    habit('Hashtags', 'With hashtags', 'Without', (r) => /#[\p{L}\p{N}_]{2,}/u.test(String(r.message || '')), 'views'),
    habit('A link in the text', 'With a link', 'Without', (r) => /https?:\/\/|\b[a-z0-9-]+\.(org|com|ac|uk)\/\S+/i.test(String(r.message || '')), 'views'),
    habit('Posted at the weekend', 'Weekend', 'Weekday', (r) => ukParts(r.created_time).weekday >= 5, 'views'),
    habit('Starts with an emoji', 'Emoji first', 'Text first', (r) => /^\p{Extended_Pictographic}/u.test(String(r.message || '').trim()), 'rate'),
  ].filter(Boolean).sort((x, y) => Math.abs(Math.log(y.ratio)) - Math.abs(Math.log(x.ratio)));
  return { posts: scored.length, heat: cells, formats, topics, habits };
}
const sumMed = (xs) => med(xs);

// Board E, every country: weekly reach per group of Pages over the last 12
// complete weeks. groups: { key: Set(page_id) }.
function weekStartOf(d) { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t.toISOString().slice(0, 10); }
function weeklyByGroup(rows, groups, { now = Date.now(), weeks: n = 12 } = {}) {
  const first = weekStartOf(new Date(now - n * 7 * 864e5).toISOString().slice(0, 10));
  const weeks = Array.from({ length: n }, (_, i) => new Date(Date.parse(`${first}T00:00:00Z`) + i * 7 * 864e5).toISOString().slice(0, 10));
  const out = {};
  for (const k of Object.keys(groups)) out[k] = weeks.map(() => null);
  for (const r of rows || []) {
    const i = weeks.indexOf(weekStartOf(String(r.metric_date).slice(0, 10)));
    if (i < 0 || typeof r.media_view_unique !== 'number') continue;
    for (const [k, ids] of Object.entries(groups)) if (ids.has(r.page_id)) out[k][i] = (out[k][i] || 0) + r.media_view_unique;
  }
  return { weeks, series: out };
}

module.exports.works = works;
module.exports.weeklyByGroup = weeklyByGroup;

// ---------------------------------------------------------------------------
// Analytics round 2 (3 Nov 2026), the boards modelled on Agorapulse's report.
// Everything below comes from figures the nightly collection already keeps:
// meta_page_growth (daily, per Page) and the posts' latest metric snapshots.
// ---------------------------------------------------------------------------

const ymdOf = (t) => new Date(t).toISOString().slice(0, 10);
// Calendar dates from..to inclusive (YYYY-MM-DD).
function datesBetween(from, to) {
  const out = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`) && out.length < 400; t += 864e5) out.push(ymdOf(t));
  return out;
}
const round1 = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 10) / 10 : null);
const ratePct = (a, b) => (typeof a === 'number' && typeof b === 'number' && b > 0 ? round1((100 * a) / b) : null);
const REACTION_KEYS = ['like', 'love', 'care', 'haha', 'wow', 'sorry', 'anger'];

// Daily per-scope series from meta_page_growth rows over the given dates.
// followers: the last known follower count of each Page carried forward, so a
// Page missing a day doesn't make the total dip.
function pageDaily(rows, pageIds, dates) {
  const idx = Object.fromEntries(dates.map((d, i) => [d, i]));
  const blank = () => dates.map(() => null);
  const s = { followers: blank(), follows: blank(), unfollows: blank(), net: blank(), views: blank(), reach: blank(), engagements: blank(), video_views: blank(), video_ms: blank() };
  const reactions = {};
  const add = (k, i, v) => { if (typeof v === 'number') s[k][i] = (s[k][i] || 0) + v; };
  const byPage = {};
  for (const r of rows || []) {
    if (!pageIds.has(r.page_id)) continue;
    const d = String(r.metric_date).slice(0, 10);
    const i = idx[d];
    if (typeof r.followers_snapshot === 'number') (byPage[r.page_id] = byPage[r.page_id] || {})[d] = r.followers_snapshot;
    if (i === undefined) continue;
    add('follows', i, r.daily_follows); add('unfollows', i, r.daily_unfollows); add('net', i, typeof r.net_follows === 'number' ? r.net_follows : (typeof r.daily_follows === 'number' || typeof r.daily_unfollows === 'number' ? (r.daily_follows || 0) - (r.daily_unfollows || 0) : null));
    add('views', i, r.media_view); add('reach', i, r.media_view_unique); add('engagements', i, r.post_engagements);
    add('video_views', i, r.video_views); add('video_ms', i, r.video_view_time_ms);
    const rx = r.post_reactions_by_type;
    if (rx && typeof rx === 'object') for (const [k, v] of Object.entries(rx)) if (typeof v === 'number') reactions[k] = (reactions[k] || 0) + v;
  }
  for (const [pid, days] of Object.entries(byPage)) {
    const known = Object.keys(days).sort();
    let j = 0, cur = null;
    dates.forEach((d, i) => {
      while (j < known.length && known[j] <= d) cur = days[known[j++]];
      if (cur !== null) s.followers[i] = (s.followers[i] || 0) + cur;
    });
  }
  return { s, reactions };
}

// Daily engagement by type from posts, counted on the day each post went out
// (a post's engagement keeps growing after; this is when we earned it).
function postDaily(rows, dates) {
  const idx = Object.fromEntries(dates.map((d, i) => [d, i]));
  const z = () => dates.map(() => 0);
  const s = { reactions: z(), comments: z(), shares: z(), clicks: z(), posts: z(), post_views: z(), post_viewers: z() };
  for (const r of rows || []) {
    const i = idx[String(r.created_time || '').slice(0, 10)];
    if (i === undefined) continue;
    s.posts[i]++;
    s.reactions[i] += r.reactions_total || 0; s.comments[i] += r.comments_total || 0;
    s.shares[i] += r.shares_total || 0; s.clicks[i] += r.clicks_total || 0;
    s.post_views[i] += r.views_total || 0; s.post_viewers[i] += r.views_unique || 0;
  }
  return s;
}

function windowTotals(pd, ps, posts) {
  const S = (xs) => sum(xs);
  const lastNum = (xs) => { for (let i = xs.length - 1; i >= 0; i--) if (typeof xs[i] === 'number') return xs[i]; return null; };
  const firstNum = (xs) => { for (const x of xs) if (typeof x === 'number') return x; return null; };
  const reactions = S(ps.reactions), comments = S(ps.comments), shares = S(ps.shares), clicks = S(ps.clicks);
  const engagements = (reactions || 0) + (comments || 0) + (shares || 0) + (clicks || 0);
  const views = S(pd.s.views), reach = S(pd.s.reach);
  const postViews = sum(posts.map((r) => r.views_total));
  const nonf = sum(posts.map((r) => r.views_from_nonfollowers));
  const vids = posts.filter((r) => typeof r.video_avg_seconds_watched === 'number');
  const scoredDays = pd.s.reach.filter((x) => typeof x === 'number').length;
  return {
    followers: lastNum(pd.s.followers), followers_start: firstNum(pd.s.followers),
    follows: S(pd.s.follows), unfollows: S(pd.s.unfollows), net_follows: S(pd.s.net),
    views, reach, viewers_per_day: scoredDays ? Math.round(reach / scoredDays) : null,
    page_engagements: S(pd.s.engagements),
    reactions, comments, shares, clicks, engagements: posts.length ? engagements : null, posts: posts.length,
    per_post: posts.length ? Math.round(engagements / posts.length) : null,
    rate_per_view: ratePct(posts.length ? engagements : null, postViews),
    rate_per_viewer: ratePct(posts.length ? engagements : null, sum(posts.map((r) => r.views_unique))),
    beyond_pct: ratePct(nonf, postViews),
    video_views: S(pd.s.video_views),
    video_avg_s: vids.length ? round1(med(vids.map((r) => r.video_avg_seconds_watched))) : null,
    video_minutes: typeof S(pd.s.video_ms) === 'number' ? Math.round(S(pd.s.video_ms) / 60000) : null,
  };
}

// The report for one window and its comparison window. growth / growthPrev:
// meta_page_growth rows; posts / postsPrev: top_posts rows (shaped feed),
// already narrowed to the scope's Pages. med: each Page's median views.
function report({ growth, growthPrev, posts, postsPrev, pageIds, from, to, cfrom, cto, med: pm = {} }) {
  const dates = datesBetween(from, to), cdates = cfrom && cto ? datesBetween(cfrom, cto) : [];
  const pd = pageDaily(growth, pageIds, dates), ps = postDaily(posts, dates);
  const pdP = pageDaily(growthPrev || [], pageIds, cdates), psP = postDaily(postsPrev || [], cdates);
  const cur = windowTotals(pd, ps, posts || []);
  const prev = cdates.length ? windowTotals(pdP, psP, postsPrev || []) : null;
  const change = {};
  if (prev) for (const k of Object.keys(cur)) change[k] = ['rate_per_view', 'rate_per_viewer', 'beyond_pct'].includes(k) ? (typeof cur[k] === 'number' && typeof prev[k] === 'number' ? round1(cur[k] - prev[k]) : null) : pct(cur[k], prev[k]);
  const rateDaily = dates.map((_, i) => { const e = ps.reactions[i] + ps.comments[i] + ps.shares[i] + ps.clicks[i]; return ratePct(ps.posts[i] ? e : null, ps.post_views[i]); });
  const rateViewerDaily = dates.map((_, i) => { const e = ps.reactions[i] + ps.comments[i] + ps.shares[i] + ps.clicks[i]; return ratePct(ps.posts[i] ? e : null, ps.post_viewers[i]); });
  const rateDailyPrev = cdates.map((_, i) => { const e = psP.reactions[i] + psP.comments[i] + psP.shares[i] + psP.clicks[i]; return ratePct(psP.posts[i] ? e : null, psP.post_views[i]); });
  const rxTotal = Object.values(pd.reactions).reduce((a, b) => a + b, 0);
  const reactionsByType = rxTotal ? REACTION_KEYS.filter((k) => pd.reactions[k]).map((k) => ({ key: k, count: pd.reactions[k], pct: round1((100 * pd.reactions[k]) / rxTotal) })) : [];
  return {
    from, to, compare_from: cfrom || null, compare_to: cto || null, dates,
    daily: { ...pd.s, ...ps, rate_per_view: rateDaily, rate_per_viewer: rateViewerDaily },
    prev_daily: cdates.length ? { views: pdP.s.views, reach: pdP.s.reach, engagements: pdP.s.engagements, net: pdP.s.net, video_views: pdP.s.video_views, rate_per_view: rateDailyPrev,
      reactions: psP.reactions, comments: psP.comments, shares: psP.shares, clicks: psP.clicks, follows: pdP.s.follows } : null,
    totals: cur, previous: prev, change, reactions_by_type: reactionsByType,
    peaks: peaks(pd.s.reach, dates, posts || [], pm),
  };
}

// The days that stood out (local peaks well above the window's median) and
// the post that most likely drove each: the best post, against its own
// Page's normal, published that day or the day before.
function peaks(series, dates, posts, pm = {}, n = 3) {
  const vals = series.map((v) => (typeof v === 'number' ? v : null));
  const m = med(vals.filter((v) => v !== null));
  if (!m) return [];
  const cand = [];
  vals.forEach((v, i) => {
    if (v === null || v < 1.5 * m) return;
    if ((i > 0 && vals[i - 1] !== null && vals[i - 1] > v) || (i < vals.length - 1 && vals[i + 1] !== null && vals[i + 1] >= v)) return;
    cand.push({ i, v });
  });
  return cand.sort((a, b) => b.v - a.v).slice(0, n).sort((a, b) => a.i - b.i).map(({ i, v }) => {
    const day = dates[i], before = i > 0 ? dates[i - 1] : null;
    const near = posts.filter((r) => typeof r.views_total === 'number' && [day, before].includes(String(r.created_time || '').slice(0, 10)));
    const best = near.sort((a, b) => b.views_total - a.views_total)[0];
    return { index: i, date: day, value: v, x_day: Math.round((v / m) * 10) / 10, post: best ? {
      page: best.page_name, text: String(best.message || '').slice(0, 140), url: best.permalink_url, created_time: best.created_time,
      views: best.views_total, x_median: pm[best.page_id] ? Math.round((best.views_total / pm[best.page_id]) * 10) / 10 : null,
      beyond_pct: best.beyond_followers_pct ?? null } : null };
  });
}

// The Conversations tab: comments and DMs coming in, answered, tone, who
// replied, the busiest posts and the hours they arrive. items: engine_inbox
// rows in the window; actions: engine_inbox_actions (done) in the window;
// toneOf(text) -> 'positive' | 'negative' | 'mixed' | 'neutral' | null.
// hourOf(iso) -> UK hour.
function conversations(items, actions, { dates, toneOf, hourOf }) {
  const idx = Object.fromEntries(dates.map((d, i) => [d, i]));
  const theirs = (items || []).filter((i) => !i.from_us);
  const z = () => dates.map(() => 0);
  const daily = { in: z(), answered: z() };
  const tones = { positive: 0, neutral: 0, negative: 0, mixed: 0, unknown: 0 };
  const hours = Array.from({ length: 24 }, () => 0);
  const threads = {};
  for (const it of theirs) {
    const i = idx[String(it.created_at).slice(0, 10)];
    if (i !== undefined) { daily.in[i]++; if (it.replied_at) daily.answered[i]++; }
    const t = toneOf ? toneOf(it.text) : null;
    tones[t && tones[t] !== undefined ? t : 'unknown']++;
    if (hourOf) hours[hourOf(it.created_at)]++;
    if (it.kind === 'comment') {
      const th = threads[it.thread_id] = threads[it.thread_id] || { text: it.post_text || '', url: it.post_url || null, comments: 0, answered: 0, negative: 0, toned: 0, ad: !!it.is_ad };
      th.comments++; if (it.replied_at) th.answered++;
      if (t && t !== 'unknown') { th.toned++; if (t === 'negative') th.negative++; }
    }
  }
  const byItem = Object.fromEntries((items || []).map((i) => [i.id, i]));
  const people = {};
  for (const a of actions || []) {
    if (!['reply', 'private_reply'].includes(a.action)) continue;
    const auto = !!(a.detail && a.detail.automation_id);
    const k = auto ? 'auto' : a.by;
    const p = people[k] = people[k] || { who: k, auto, replies: 0, private: 0, mins: [] };
    if (a.action === 'reply') p.replies++; else p.private++;
    const it = byItem[a.item_id];
    if (it && !auto) { const m = (Date.parse(a.created_at) - Date.parse(it.created_at)) / 60000; if (m >= 0) p.mins.push(m); }
  }
  const toned = tones.positive + tones.neutral + tones.negative + tones.mixed;
  return {
    daily, hours,
    tones: toned ? { positive: Math.round((100 * tones.positive) / toned), neutral: Math.round((100 * (tones.neutral + tones.mixed)) / toned), negative: Math.round((100 * tones.negative) / toned), read: toned, unread: tones.unknown } : null,
    people: Object.values(people).map((p) => ({ who: p.who, auto: p.auto, replies: p.replies, private: p.private, median_reply_minutes: p.mins.length ? Math.round(med(p.mins)) : null }))
      .sort((a, b) => (a.auto - b.auto) || (b.replies + b.private) - (a.replies + a.private)),
    busiest: Object.values(threads).sort((a, b) => b.comments - a.comments).slice(0, 8).map((t) => ({
      text: String(t.text).slice(0, 120), url: t.url, comments: t.comments, ad: t.ad,
      answered_pct: t.comments ? Math.round((100 * t.answered) / t.comments) : null, negative_pct: t.toned >= 5 ? Math.round((100 * t.negative) / t.toned) : null })),
  };
}

// Every post in the window ranked, for the Posts tab.
function ranked(rows, { med: pm = {}, fbFormat, langOf, limit = 100 } = {}) {
  return rows.filter((r) => typeof r.views_total === 'number').sort((a, b) => b.views_total - a.views_total).slice(0, limit).map((r, i) => ({
    rank: i + 1, page: r.page_name, text: String(r.message || '').slice(0, 140), url: r.permalink_url, created_time: r.created_time,
    format: fbFormat ? fbFormat(r) : null, lang: langOf ? langOf(r.message) : null,
    views: r.views_total, engagements: r.engagement_total, rate: r.engagement_rate,
    x_median: pm[r.page_id] ? Math.round((r.views_total / pm[r.page_id]) * 10) / 10 : null, beyond_pct: r.beyond_followers_pct ?? null,
  }));
}

module.exports.datesBetween = datesBetween;
module.exports.report = report;
module.exports.peaks = peaks;
module.exports.conversations = conversations;
module.exports.ranked = ranked;
