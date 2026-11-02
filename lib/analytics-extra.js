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
