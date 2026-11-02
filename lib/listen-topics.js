'use strict';
// Listening › Topics: posts from the accounts we watch (allies, opponents) and
// CitizenGO Pages, sorted into campaign topics by keyword (no paid AI), with
// each topic's last 14 days against the 14 before, who is talking (share of
// voice), what is being said, its top posts and any gap our side hasn't
// answered. Also the terms rising across every post, topic or not.
// English keywords, so it reads English posts; other languages stay out.

const TOPICS = [
  { key: 'assisted-dying', name: 'Assisted suicide', re: /assisted (suicide|dying)|euthanasia|end[- ]of[- ]life|terminally[- ]ill|dignity in dying|killthebill|right to die|leadbeater/i },
  { key: 'abortion', name: 'Abortion and buffer zones', re: /abortion|pro-?life|unborn|buffer zone|safe access zone|pregnan|\bbpas\b|womb|\bfoetus|\bfetus|termination of pregnancy|prolife/i },
  { key: 'gender', name: 'Gender and puberty blockers', re: /gender|transgender|\btrans\b|puberty blocker|cass review|biological sex|single-sex|sex-based|detransition|conversion therapy/i },
  { key: 'sex-education', name: 'Relationships and sex education', re: /sex education|\brse\b|relationships education|\bpshe\b|parents'? rights?|what (my|our) children? (are|is) taught/i },
  { key: 'hospices', name: 'Hospices and palliative care', re: /hospice|palliative/i },
  { key: 'free-speech', name: 'Free speech and faith', re: /free speech|freedom of (speech|expression|religion|belief|conscience)|silent(ly)? pray|arrested for pray|censorship|blasphemy|secular|christian(s)? (persecut|arrest)/i },
  { key: 'family', name: 'Marriage and family', re: /\bmarriage\b|surrogacy|\bivf\b|fatherhood|motherhood|family values|two-child|childcare/i },
];
const STOP = new Set(('about after again against also among another because been before being between both could does doing during each every from further have having here into just more most must only other over same should some such than that their them then there these they this those through under until very were what when where which while will with would your yours ours today people please everyone thank thanks join sign petition share watch read week year years time first last make made said says like know need want come going really still today tomorrow yesterday everything something nothing anyone someone government minister ministers').split(' '));

function topicsOf(text) { return TOPICS.filter((t) => t.re.test(String(text || ''))).map((t) => t.key); }

// Words and hashtags inside a topic's posts, by how many accounts used them,
// leaving out the words that put the post in the topic.
const plain = (text) => String(text || '').replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, ' ');
function wordSet(text) {
  return new Set(plain(text).toLowerCase().split(/[^\p{L}'-]+/u).filter((w) => w.length >= 5 && !STOP.has(w) && !/^'|'$|^-|-$/.test(w)));
}
// share: how often each word turns up across all posts (0-1), so words that
// are everywhere ("children", "support") don't crowd out what's particular.
function wordsOf(posts, topic, share = null) {
  const by = {};
  const kw = new Set(topic.re.source.toLowerCase().match(/[a-z]{4,}/g) || []);
  for (const p of posts) {
    const seen = new Set();
    const text = plain(p.text);
    for (const h of text.match(/#[\p{L}\p{N}_]{3,}/gu) || []) seen.add(h.toLowerCase());
    for (const w of wordSet(text)) if (!kw.has(w) && !seen.has('#' + w) && !topic.re.test(w)) seen.add(w);
    for (const w of seen) { const o = by[w] = by[w] || { w, accounts: new Set(), sides: { citizengo: 0, allies: 0, opponents: 0 } }; o.accounts.add(p.who); o.sides[p.src]++; }
  }
  const n = posts.length || 1;
  const lift = (o) => (share && share[o.w] ? (Object.values(o.sides).reduce((a, b) => a + b, 0) / n) / share[o.w] : 1);
  return Object.values(by).filter((o) => o.accounts.size >= 2 && (!share || o.w.startsWith('#') || lift(o) >= 2)).sort((a, b) => b.accounts.size - a.accounts.size || a.w.localeCompare(b.w)).slice(0, 8)
    .map((o) => ({ w: o.w, accounts: o.accounts.size, side: Object.entries(o.sides).sort((a, b) => b[1] - a[1])[0][0] }));
}

// posts: { src: citizengo|allies|opponents, who, text, url, created_time, x }
function overview(posts, { now = Date.now(), days = 14, storyKeys } = {}) {
  const W = days * 864e5;
  const day0 = Math.floor((now - W) / 864e5);
  const cur = [], prev = [];
  for (const p of posts) {
    const t = Date.parse(p.created_time || 0);
    if (!(t <= now)) continue;
    if (now - t <= W) cur.push(p); else if (now - t <= 2 * W) prev.push(p);
  }
  const tag = (list) => list.map((p) => ({ ...p, topics: topicsOf(p.text) }));
  const C = tag(cur), P = tag(prev);
  const wordShare = {};
  for (const p of C) for (const w of wordSet(p.text)) wordShare[w] = (wordShare[w] || 0) + 1 / C.length;
  const topics = TOPICS.map((t) => {
    const mine = C.filter((p) => p.topics.includes(t.key));
    const before = P.filter((p) => p.topics.includes(t.key)).length;
    const by = { citizengo: 0, allies: 0, opponents: 0 };
    for (const p of mine) by[p.src]++;
    const total = mine.length;
    const share = Object.fromEntries(Object.entries(by).map(([k, v]) => [k, total ? Math.round((v / total) * 100) : 0]));
    const daily = Array.from({ length: days }, () => 0);
    for (const p of mine) { const i = Math.floor(Date.parse(p.created_time) / 864e5) - day0 - 1; if (i >= 0 && i < days) daily[i]++; else if (i === days) daily[days - 1]++; }
    let gap = null;
    const accts = new Set(mine.map((p) => p.who)).size;
    if (accts < 3) { /* too few voices to call a gap */ } else if (total >= 4 && share.opponents >= 50) gap = { kind: 'opponents', text: `Opponents hold ${share.opponents}% of the conversation` };
    else if (total >= 4 && share.citizengo <= 10 && share.allies >= 40) gap = { kind: 'alone', text: 'Allies are carrying this without us' };
    const best = (src) => mine.filter((p) => p.src === src && p.x != null).sort((a, b) => b.x - a.x)[0] || null;
    const top = ['citizengo', 'allies', 'opponents'].map(best).filter(Boolean)
      .map((p) => ({ src: p.src, who: p.who, x: p.x, url: p.url, text: String(p.text || '').slice(0, 160), created_time: p.created_time }));
    const list = mine.slice().sort((a, b) => (b.x || 0) - (a.x || 0)).slice(0, 40)
      .map((p) => ({ src: p.src, who: p.who, x: p.x, url: p.url, text: String(p.text || '').slice(0, 300), created_time: p.created_time, likes: p.likes, comments: p.comments, views: p.views }));
    return { key: t.key, name: t.name, posts: total, before, change_pct: before ? Math.round(((total - before) / before) * 100) : null,
      daily, by, share, accounts: new Set(mine.map((p) => p.who)).size, words: wordsOf(mine, t, C.length >= 20 ? wordShare : null), top, gap, list };
  }).filter((t) => t.posts || t.before)
    .sort((a, b) => Math.abs(b.posts - b.before) - Math.abs(a.posts - a.before) || b.posts - a.posts);
  // Trending: any hashtag, link or name used by 3+ accounts in the last 7
  // days, rising against the 7 before. Topic or not.
  const trending = [];
  if (storyKeys) {
    const wk = 7 * 864e5, by = {};
    for (const p of posts) {
      const age = now - Date.parse(p.created_time || 0);
      if (!(age >= 0) || age > 2 * wk) continue;
      for (const k of storyKeys(p.text)) {
        const o = by[k] = by[k] || { now: new Set(), before: new Set(), posts: [], sides: { citizengo: 0, allies: 0, opponents: 0 } };
        if (age <= wk) { o.now.add(p.who); o.posts.push(p); o.sides[p.src]++; } else o.before.add(p.who);
      }
    }
    for (const [k, o] of Object.entries(by)) {
      if (o.now.size < 3 || o.now.size <= o.before.size) continue;
      trending.push({ key: k.replace(/^link:/, ''), kind: k.startsWith('#') ? 'hashtag' : k.startsWith('link:') ? 'link' : 'story', accounts: o.now.size, before: o.before.size,
        topics: [...new Set(o.posts.flatMap((p) => topicsOf(p.text)))], sides: o.sides,
        posts: o.posts.slice(0, 4).map((p) => ({ src: p.src, who: p.who, url: p.url })) });
    }
    trending.sort((a, b) => (b.accounts - b.before) - (a.accounts - a.before) || b.accounts - a.accounts);
  }
  return { days, topics, trending: trending.slice(0, 12) };
}

module.exports = { TOPICS, topicsOf, wordsOf, overview };
