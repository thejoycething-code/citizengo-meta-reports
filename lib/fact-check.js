'use strict';
// Fact-check a breakout post's caption before it is announced, for the webhook
// route (scripts/breakout-alerts.js --post). The scheduled Claude task does the
// same check itself, by the rules in skills/breakout-alerts/SKILL.md; this is
// the same rule set for the route that has no Claude session attached.
//
// THE RULES, as Christopher set them on 29 Sept 2026:
//   - factual claims only: figures, dates, quotes, named people, laws, votes,
//     events. Stance and framing are campaign positions and are never judged.
//   - a wrong, unverified or outdated claim does NOT stop the alert. It puts a
//     "Check before reusing" warning directly under the first line.
//   - a check that cannot run posts anyway, with a warning saying so. A failed
//     check must never block an alert, and never let one look checked.
//
// LINKS ARE NOT TRUSTED FROM THE MODEL. Every URL it cites is compared with the
// URLs its own web_search and web_fetch calls actually returned in this
// request; anything else is dropped. The briefing shipped four fabricated URLs
// in one Slack post on 31 Aug, and a fact check citing a made-up source is
// worse than none. A "verified" claim whose only link was dropped becomes
// "unverified", because the verdict rested on a source that cannot be shown.
//
// Zero dependencies, like the rest of the project: raw fetch to the Messages
// API rather than the SDK, because the workflow never runs npm install.

const API = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.FACT_CHECK_MODEL || 'claude-opus-5-5';
// Server tools run a sampling loop that pauses after 10 iterations; each
// continuation resends the paused turn. Five is far more than one caption needs.
const MAX_CONTINUATIONS = 5;

const VERDICTS = ['verified', 'wrong', 'unverified', 'outdated'];

const SYSTEM = `You fact-check social media posts for CitizenGO, an advocacy organisation, before a post is recommended to other country teams for reuse.

Check FACTUAL CLAIMS ONLY: figures, dates, named people and what they said or did, laws and court rulings, votes, and events. Ignore opinion, calls to action, moral judgements and framing. Those are campaign positions, and you never comment on them, soften them or rule on them.

Most posts have one to four checkable claims. Some have none, such as a slogan or a prayer.

Search in the post's own language and in English. Prefer primary sources: the court judgment, the official vote record, the government or parliament page, the statistics office. Otherwise use reputable news reporting.

Give each claim one verdict:
- verified: a source supports it as stated.
- wrong: a source contradicts it (wrong figure, wrong date, misattributed quote, a law that has not passed).
- unverified: you could not find support either way. An unverified claim is not a wrong one.
- outdated: it was true but has since changed.

Every url you give must be a page returned by your own searches or fetches in this conversation. Never write a URL from memory. If you have no source, use null.

Finish with ONLY a JSON object, no prose before or after it, in this shape:
{"claims": [{"claim": "<the claim in a few words, in English>", "verdict": "verified|wrong|unverified|outdated", "note": "<for wrong or outdated: what the source says instead, in one short sentence; otherwise empty>", "url": "<source url or null>"}]}
An empty "claims" array means the caption has no checkable factual claims.`;

// Every URL the server tools returned in the conversation, from the blocks
// themselves rather than from anything the model wrote.
function sourceUrls(content) {
  const out = new Set();
  for (const b of content) {
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      for (const r of b.content) if (r && r.url) out.add(r.url);
    }
    if (b.type === 'web_fetch_tool_result' && b.content && !b.content.error_code) {
      if (b.content.url) out.add(b.content.url);
    }
  }
  return out;
}

// The final JSON object in the model's last text. Structured outputs are not
// used because they are incompatible with the citations web search produces.
function parseClaims(text) {
  const start = text.indexOf('{'); const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON in the fact-check reply');
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!parsed || !Array.isArray(parsed.claims)) throw new Error('fact-check reply has no claims array');
  return parsed.claims;
}

// Keep only what the rules allow: a known verdict, and a URL the tools returned.
function sanitise(claims, allowed) {
  return claims
    .filter((c) => c && typeof c.claim === 'string' && c.claim.trim())
    .map((c) => {
      let verdict = VERDICTS.includes(c.verdict) ? c.verdict : 'unverified';
      const url = (typeof c.url === 'string' && allowed.has(c.url)) ? c.url : null;
      if (verdict === 'verified' && !url) verdict = 'unverified';
      return { claim: c.claim.trim(), verdict, note: String(c.note || '').trim(), url };
    });
}

// Returns { ok: true, claims } or { ok: false, error }. Never throws: the caller
// posts either way, and a failure has to reach the alert as a warning.
async function factCheck(post, opts = {}) {
  const key = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, error: 'ANTHROPIC_API_KEY is not set' };
  const text = String(post.message || '').trim();
  if (!text) return { ok: true, claims: [] };
  const doFetch = opts.fetch || fetch;

  const user = `Page: ${post.pageName || 'unknown'}\nPublished: ${post.published || 'unknown'}\nToday: ${new Date().toISOString().slice(0, 10)}\n\nCaption:\n${text}`;
  const messages = [{ role: 'user', content: user }];
  const seen = [];
  try {
    for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
      const res = await doFetch(API, {
        method: 'POST',
        headers: {
          'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json',
          // Server-side fallback: if the model declines (a caption about abuse
          // or violence can trip a safety classifier), the API re-runs the
          // request on a fallback model inside the same call.
          'anthropic-beta': 'server-side-fallback-2026-07-01',
        },
        body: JSON.stringify({
          model: MODEL, max_tokens: 16000, system: SYSTEM, messages,
          output_config: { effort: 'medium' },
          fallbacks: 'default',
          tools: [
            { type: 'web_search_20260209', name: 'web_search', max_uses: 8 },
            { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 6 },
          ],
        }),
      });
      if (!res.ok) return { ok: false, error: `API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
      const msg = await res.json();
      seen.push(...(msg.content || []));
      if (msg.stop_reason === 'pause_turn') {
        // Resend with the paused turn appended, and no extra user message: the
        // API sees the trailing server_tool_use and resumes by itself.
        messages.push({ role: 'assistant', content: msg.content });
        continue;
      }
      if (msg.stop_reason === 'refusal') return { ok: false, error: 'the model declined to check this post' };
      if (msg.stop_reason === 'max_tokens') return { ok: false, error: 'the reply was cut off' };
      const last = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      return { ok: true, claims: sanitise(parseClaims(last), sourceUrls(seen)) };
    }
    return { ok: false, error: `still searching after ${MAX_CONTINUATIONS} continuations` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// The block, in the same two flavours as the alert itself (see render() in
// scripts/breakout-alerts.js). Returns where it goes: 'top' for a warning, which
// must be seen before anyone reuses the post, and 'bottom' for a clean result.
function renderFactCheck(result, { mediaType, flavour = 'mrkdwn' } = {}) {
  const md = flavour === 'markdown';
  const b = (t) => (md ? `**${t}**` : `*${t}*`);
  const link = (url, label) => (md ? `[${label}](${url})` : `<${url}|${label}>`);
  // The media types in meta_posts that carry pictures or sound the check cannot
  // see (a link post's preview is the linked page, which the check can read).
  const captionOnly = ['video', 'photo', 'album', 'music'].includes(mediaType)
    ? '_The caption was checked; the video or image itself was not._' : null;
  const withNote = (lines) => (captionOnly ? [...lines, captionOnly] : lines);

  if (!result.ok) {
    return { where: 'top', text: b('⚠️ Fact check could not be run today. Verify before reusing.') };
  }
  const claims = result.claims;
  if (!claims.length) {
    return { where: 'bottom', text: withNote([`${b('Fact check:')} no factual claims in the caption to check.`]).join('\n') };
  }
  const src = (c) => (c.url ? ` (${link(c.url, 'source')})` : '');
  const problems = claims.filter((c) => c.verdict !== 'verified');
  if (!problems.length) {
    return {
      where: 'bottom',
      text: withNote([`${b('✅ Fact check:')} the claims check out.`, ...claims.map((c) => `• ${c.claim}${src(c)}`)]).join('\n'),
    };
  }
  const icon = { wrong: '❌ Wrong', unverified: '❓ Unverified', outdated: '🕓 Outdated', verified: '✅ Verified' };
  const order = { wrong: 0, outdated: 1, unverified: 2, verified: 3 };
  const lines = [...claims].sort((x, y) => order[x.verdict] - order[y.verdict]).map((c) => {
    const detail = c.verdict === 'unverified' && !c.note ? ': no source found' : (c.note ? `: ${c.note}` : '');
    return `• ${icon[c.verdict]}: ${c.claim}${detail}${src(c)}`;
  });
  const worst = problems.some((c) => c.verdict === 'wrong') ? 'a claim here is contradicted by a source'
    : problems.some((c) => c.verdict === 'outdated') ? 'a claim here is out of date'
      : 'a claim here could not be verified';
  return { where: 'top', text: withNote([`${b('⚠️ Check before reusing:')} ${worst}.`, ...lines]).join('\n') };
}

// Insert the block into an alert: a warning goes directly under the first line
// (the "Automated alert" line), a clean result at the end.
function withFactCheck(body, block) {
  if (block.where === 'bottom') return `${body}\n\n${block.text}`;
  const nl = body.indexOf('\n');
  if (nl === -1) return `${body}\n\n${block.text}`;
  return `${body.slice(0, nl)}\n\n${block.text}\n${body.slice(nl)}`;
}

module.exports = { factCheck, renderFactCheck, withFactCheck, sanitise, sourceUrls, parseClaims };
