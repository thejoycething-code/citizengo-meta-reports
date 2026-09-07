'use strict';
// Group posts that are THE SAME STORY told on different pages.
//
// Built 4 Sep 2026 for the breakout alerts. The problem, from real data: the
// Olivia Maurel surrogacy story ran on nine pages in five languages between 28
// Aug and 5 Sep. Announcing each copy as a discovery would be noise; the useful
// alert is "this story broke out, here is where it started, consider it".
//
// WHAT DOES NOT WORK, checked against those ten posts before writing this:
//   link_url      NULL on all ten. No shared CTA to key on.
//   full_picture  nine distinct values - each page uploads its own copy, so
//                 Facebook assigns a different id. Only an exact re-post of the
//                 identical upload shares one.
//   plain text    "Nació mediante gestación subrogada", "È nata da maternità
//                 surrogata" and "Rođena je iz surogatstva" share no words.
//
// AND WHAT THE FIRST ATTEMPT GOT WRONG, because it is instructive: rarity by
// document frequency plus union-find produced ONE cluster of 591 posts across 23
// pages. Two independent faults:
//
//   1. In a multilingual corpus dominated by Spanish, an everyday word in a
//      minority language looks rare. Croatian "nije" (is not) appeared in 4 of
//      850 posts, so it scored as a distinguishing term. It is not.
//   2. Union-find takes the transitive closure. A~B on one weak pair and B~C on
//      another puts A and C in one story even though nothing connects them.
//      Weak links chain without limit.
//
// So rarity is no longer the test. PROPER NOUNS are: tokens that appear
// Titlecased in the original text - Olivia, Maurel, Ceuta, Sánchez - which is a
// language-independent signal that survives translation, and which everyday
// words in any language do not produce. And clustering anchors on a
// representative rather than chaining: every member matched the story's FIRST
// post directly, so a single weak pair can never merge two stories.

const strip = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
const normalise = (s) => strip(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const MIN_TOKEN = 4;

function tokensOf(text) {
  if (!text) return [];
  return [...new Set(normalise(text).split(' ').filter((t) => t.length >= MIN_TOKEN))];
}

// Titlecase words: initial capital, lowercase tail. Deliberately NOT all-caps -
// campaign copy shouts constantly ("URGENTE", "ATENCIÓN", "BREAKING") and those
// are emphasis, not names. Diacritics are folded after the case test, so
// "Sánchez" is detected as Titlecase and then compared as "sanchez".
function properNouns(text) {
  if (!text) return [];
  const out = new Set();
  for (const m of String(text).matchAll(/\p{Lu}\p{Ll}{3,}/gu)) {
    out.add(normalise(m[0]));
  }
  // A token containing a space is not a token: some letters (Croatian đ, Polish
  // ł) do not decompose under NFKD, so normalise() turns them into separators
  // and "Rođena" arrives as "ro ena". Dropped rather than kept as a fragment
  // that could coincide with another mangled word.
  return [...out].filter((t) => t.length >= MIN_TOKEN && !t.includes(' '));
}

// Sentence-initial capitals are position, not namehood. A word that shows up
// Titlecased across many DIFFERENT posts while also appearing lowercase
// elsewhere is ordinary; a real name is nearly always capitalised.
function buildIndex(posts) {
  const capitalised = new Map();
  const lower = new Map();
  for (const p of posts) {
    for (const t of properNouns(p.message)) capitalised.set(t, (capitalised.get(t) || 0) + 1);
    for (const t of tokensOf(p.message)) lower.set(t, (lower.get(t) || 0) + 1);
  }
  return { capitalised, lower, n: posts.length };
}

// A name we can key a story on: mostly seen capitalised, and not so common that
// it describes half the estate's output.
// The ceiling exists to drop words so widespread they identify nothing -
// "Citizengo", or "Sánchez" in a corpus full of Spanish politics. The absolute
// floor of 25 matters: at max(3, ...) a small corpus discarded "Olivia" for
// appearing in four posts, and the story stopped clustering. A name in 25 posts
// or fewer is still a name however small the corpus is.
function nameTokens(post, index, { maxNameFreq = 0.06, minNameCeiling = 25 } = {}) {
  const ceiling = Math.max(minNameCeiling, Math.floor(index.n * maxNameFreq));
  return properNouns(post.message).filter((t) => {
    const cap = index.capitalised.get(t) || 0;
    const low = index.lower.get(t) || 0;
    if (cap > ceiling) return false;              // too widespread to identify anything
    // Capitalised in at least 70% of the posts that use the word at all.
    return low === 0 ? true : cap / low >= 0.7;
  });
}

const jaccard = (a, b) => {
  if (!a.length || !b.length) return 0;
  const B = new Set(b);
  let shared = 0;
  for (const t of a) if (B.has(t)) shared++;
  return shared / (a.length + b.length - shared);
};

// Do these two posts tell the same story? Three independent routes, because a
// same-language copy and a translated copy look nothing alike.
function sameStory(a, b, opts = {}) {
  const { windowDays = 60, minNamesShared = 2, minJaccard = 0.5 } = opts;

  const gap = Math.abs(Date.parse(a.created_time) - Date.parse(b.created_time));
  if (!Number.isFinite(gap) || gap > windowDays * 86400000) return null;

  // 1. The identical upload. Catches a page posting the same thing twice - which
  //    the global page did on 1 Sep, a minute apart.
  if (a.full_picture && b.full_picture && a.full_picture === b.full_picture) return 'same image';

  // 2. Near-identical wording: a copy in the same language, or a light edit.
  const j = jaccard(a._tokens, b._tokens);
  if (j >= minJaccard) return `text ${(j * 100).toFixed(0)}%`;

  // 3. Shared names: the cross-language route. Two, not one - one shared name is
  //    a coincidence waiting to happen ("Ceuta" alone would bind every Ceuta
  //    post into a single story), two is a claim about the subject.
  const shared = a._names.filter((t) => b._names.includes(t));
  if (shared.length >= minNamesShared) return `names: ${shared.slice(0, 4).join(', ')}`;

  return null;
}

// Representative-anchored clustering. Posts are walked in publication order and
// each either joins the FIRST story whose representative it matches directly, or
// starts a new one. No transitive closure: every member matched the story's
// first post, so one weak pair cannot merge two unrelated stories - which is
// exactly how the first version produced a 591-post cluster.
function cluster(posts, opts = {}) {
  const rows = (posts || []).filter((p) => p && p.post_id && p.created_time);
  const index = buildIndex(rows);
  for (const p of rows) {
    p._tokens = tokensOf(p.message);
    p._names = nameTokens(p, index, opts);
  }

  const sorted = [...rows].sort((a, b) => String(a.created_time).localeCompare(String(b.created_time)));
  const windowMs = (opts.windowDays || 60) * 86400000;
  const stories = [];

  for (const p of sorted) {
    let joined = null;
    for (const s of stories) {
      // Representatives older than the window can never match again, and the
      // list is in time order, so this stays linear in practice.
      if (Date.parse(p.created_time) - Date.parse(s.first.created_time) > windowMs) continue;
      const why = sameStory(s.first, p, opts);
      if (why) { joined = { s, why }; break; }
    }
    if (joined) {
      joined.s.members.push(p);
      joined.s.reasons.push(joined.why);
    } else {
      stories.push({ story_key: p.post_id, first: p, members: [p], reasons: [] });
    }
  }

  return stories;
}

// Should this 100k post be announced, given what has already been announced?
//
// The rule, as specified 4 Sep 2026:
//   - a post is announced when it passes the view threshold
//   - a later copy of the SAME story in the SAME format is not: it is the same
//     piece of work travelling, which the channel does not need told twice
//   - but a DIFFERENT format on the same story is a different piece of work.
//     A video of Olivia and a photo of Olivia both get announced.
//   - and a copy appearing revivalDays or more after the story's FIRST post is
//     announced again: at that distance it is a deliberate revival of old
//     material, not a simultaneous translation, and that is the useful signal.
//
// Pure, so the decision can be tested without a database or a Slack webhook -
// it is the part of this feature most likely to be got wrong.
function shouldAnnounce({ post, story, prior = [], revivalDays = 35 }) {
  const mediaType = post.media_type || 'unknown';
  const matches = prior.filter((a) => a.story_key === story.story_key
    && (a.media_type || 'unknown') === mediaType);
  if (!matches.length) return { announce: true, revival: null };

  const firstAt = story.first.created_time;
  const days = Math.floor((Date.parse(post.created_time) - Date.parse(firstAt)) / 86400000);
  if (days >= revivalDays) {
    return { announce: true, revival: { first: String(firstAt).slice(0, 10), days } };
  }
  return {
    announce: false,
    reason: `same story and format already announced (first post ${String(firstAt).slice(0, 10)}) and only ${days} days after it`,
  };
}

module.exports = { cluster, sameStory, shouldAnnounce, tokensOf, properNouns, nameTokens, buildIndex, jaccard, normalise };
