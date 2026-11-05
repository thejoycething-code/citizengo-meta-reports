'use strict';
// Petition sign-ups traced back to each post (5 Nov 2026).
//
// link_signatures holds sign-ups per tracked link (campaign code) for all
// time, so a link posted twice - on two Pages, or again a week later - could
// only be reported per link. link_signature_days holds the same figures per
// DAY (Looker, signers arriving from Facebook, Instagram and X), which lets
// each day's sign-ups go to the post that was live then:
//
//   each day's signers from a platform go to the most recent post of that
//   link on that platform posted on or before that day; posts made on the
//   same day share that day equally. Signers before the first post are the
//   link's other uses (an ad, a bio, a DM), credited to no post.
//
// Looker dates are CitizenGO's own (Madrid) days, so posts are dated the same
// way. Pure, exported for the tests.

const PLATFORM_SOURCE = { facebook: 'fb', instagram: 'ig', x: 'tw' };
const TZ = 'Europe/Madrid';

function localDay(iso, tz = TZ) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// posts: link_posts rows (platform, post_id, posted_at, campaign_code, ...).
// days: link_signature_days rows (campaign_code, source, day, signatures,
// new_members, reactivated_members).
// Returns { posts: [...one row per post, with credited figures], unposted }.
function attribute(posts, days, { firstDays = 7 } = {}) {
  // One entry per post, even when a post carries the same link twice.
  const byPost = new Map();
  for (const p of posts) {
    if (!p.campaign_code || !PLATFORM_SOURCE[p.platform]) continue;
    const key = `${p.platform}|${p.post_id}|${p.campaign_code}`;
    if (byPost.has(key)) continue;
    byPost.set(key, { ...p, day: localDay(p.posted_at), signatures: 0, new_members: 0, reactivated_members: 0,
      first_days: 0, last_signup: null, shared_with: 0 });
  }
  // Posts per link and platform, oldest first.
  const groups = new Map();
  for (const e of byPost.values()) {
    const g = `${e.campaign_code}|${PLATFORM_SOURCE[e.platform]}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(e);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => String(a.day).localeCompare(String(b.day)));
    for (const e of list) e.shared_with = list.length - 1;
  }
  const unposted = { signatures: 0, new_members: 0, reactivated_members: 0 };
  for (const r of days) {
    const list = groups.get(`${r.campaign_code}|${r.source}`);
    const sig = Number(r.signatures) || 0; const nm = Number(r.new_members) || 0; const ra = Number(r.reactivated_members) || 0;
    if (!list) continue; // a link none of these posts carries
    const live = list.filter((e) => e.day && e.day <= r.day);
    if (!live.length) { unposted.signatures += sig; unposted.new_members += nm; unposted.reactivated_members += ra; continue; }
    const latest = live[live.length - 1].day;
    const takers = live.filter((e) => e.day === latest);
    for (const e of takers) {
      e.signatures += sig / takers.length;
      e.new_members += nm / takers.length;
      e.reactivated_members += ra / takers.length;
      if (r.day < addDays(e.day, firstDays)) e.first_days += sig / takers.length;
      if (sig > 0 && (!e.last_signup || r.day > e.last_signup)) e.last_signup = r.day;
    }
  }
  const round = (v) => Math.round(v);
  const out = [...byPost.values()].map((e) => ({ ...e,
    signatures: round(e.signatures), new_members: round(e.new_members), reactivated_members: round(e.reactivated_members), first_days: round(e.first_days) }));
  out.sort((a, b) => b.signatures - a.signatures || String(b.posted_at).localeCompare(String(a.posted_at)));
  return { posts: out, unposted };
}

module.exports = { attribute, localDay, addDays, PLATFORM_SOURCE };
