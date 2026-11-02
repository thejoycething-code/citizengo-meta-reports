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
