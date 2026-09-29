#!/usr/bin/env node
'use strict';
// Tests for the breakout fact check (lib/fact-check.js), against a stubbed
// Messages API, so they cost nothing and need no key.
//
// The ones that matter most: a link the model wrote but no tool returned is
// dropped, a "verified" resting on that link is downgraded, and a check that
// fails still produces a visible warning rather than a clean-looking alert.

const { factCheck, renderFactCheck, withFactCheck, sanitise } = require('../lib/fact-check');

let pass = 0; let fail = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const REAL = 'https://www.london.gov.uk/petitions/example';
const searchBlock = { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: REAL, title: 't' }] };
const reply = (claims, extra = {}) => ({
  stop_reason: 'end_turn',
  content: [searchBlock, { type: 'text', text: JSON.stringify({ claims }) }],
  ...extra,
});
const stub = (...responses) => {
  const calls = [];
  const f = async (url, init) => {
    calls.push(JSON.parse(init.body));
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return { ok: r.status ? false : true, status: r.status || 200, json: async () => r, text: async () => r.body || '' };
  };
  f.calls = calls;
  return f;
};
const ALERT = '_Automated alert from the Meta reporting connector._\n\n🚀 *135,701 views* — Citizen GO UK\n\n> quote';

(async () => {
  console.log('\nLinks are only kept if a tool returned them\n');
  {
    const out = sanitise([
      { claim: 'A', verdict: 'verified', url: REAL },
      { claim: 'B', verdict: 'verified', url: 'https://made-up.example/story' },
      { claim: 'C', verdict: 'nonsense', url: null },
    ], new Set([REAL]));
    check('a returned link is kept', out[0].url === REAL);
    check('an invented link is dropped', out[1].url === null);
    check('"verified" with no showable source becomes unverified', out[1].verdict === 'unverified');
    check('an unknown verdict becomes unverified', out[2].verdict === 'unverified');
  }

  console.log('\nThe API call\n');
  {
    const f = stub(reply([{ claim: 'Petition had 60,000 signatures', verdict: 'wrong', note: 'Reported as 40,000 at delivery', url: REAL }]));
    const r = await factCheck({ message: 'Almost 60,000 voices…' }, { apiKey: 'k', fetch: f });
    check('parses the verdicts', r.ok && r.claims[0].verdict === 'wrong', JSON.stringify(r));
    const body = f.calls[0];
    check('uses the current web tools', body.tools.map((t) => t.type).join() === 'web_search_20260209,web_fetch_20260209');
    check('does not force a tool (the model rejects it)', !('tool_choice' in body));
  }
  {
    const paused = { stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: {} }] };
    const f = stub(paused, reply([{ claim: 'X', verdict: 'verified', url: REAL }]));
    const r = await factCheck({ message: 'x' }, { apiKey: 'k', fetch: f });
    check('resumes after pause_turn', r.ok && f.calls.length === 2);
    check('resumes with no extra user message', f.calls[1].messages.map((m) => m.role).join() === 'user,assistant');
  }
  {
    const r = await factCheck({ message: 'x' }, { apiKey: '', fetch: stub() });
    const saved = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
    const r2 = await factCheck({ message: 'x' }, { fetch: stub() });
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    check('no key is a failure, not a throw', !r2.ok && /ANTHROPIC_API_KEY/.test(r2.error), JSON.stringify(r || r2));
  }
  {
    const r = await factCheck({ message: 'x' }, { apiKey: 'k', fetch: stub({ status: 529, body: 'overloaded' }) });
    check('an API error is a failure, not a throw', !r.ok && /529/.test(r.error));
    const r2 = await factCheck({ message: 'x' }, { apiKey: 'k', fetch: stub({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Sorry, no.' }] }) });
    check('a reply with no JSON is a failure', !r2.ok);
    const r3 = await factCheck({ message: 'x' }, { apiKey: 'k', fetch: stub({ stop_reason: 'refusal', content: [] }) });
    check('a refusal is a failure', !r3.ok);
    const r4 = await factCheck({ message: '' }, { apiKey: 'k', fetch: stub() });
    check('an empty caption has nothing to check', r4.ok && r4.claims.length === 0);
  }

  console.log('\nWhere the block goes\n');
  {
    const warn = renderFactCheck({ ok: true, claims: [{ claim: 'P', verdict: 'wrong', note: 'n', url: REAL }] }, { mediaType: 'video' });
    const out = withFactCheck(ALERT, warn);
    const lines = out.split('\n');
    check('a warning sits directly under the first line', lines[0].startsWith('_Automated') && lines[2].includes('Check before reusing'), out);
    check('the rest of the alert is unchanged', out.endsWith(ALERT.slice(ALERT.indexOf('\n'))));
    check('a video notes only the caption was checked', out.includes('video or image itself was not'));

    const clean = renderFactCheck({ ok: true, claims: [{ claim: 'P', verdict: 'verified', note: '', url: REAL }] }, { mediaType: 'link' });
    const out2 = withFactCheck(ALERT, clean);
    check('a clean result goes at the end', out2.startsWith(ALERT) && out2.includes('✅ Fact check'));
    check('a link post carries no caption-only note', !out2.includes('itself was not'));

    const failed = withFactCheck(ALERT, renderFactCheck({ ok: false, error: 'x' }, { mediaType: 'photo' }));
    check('a failed check still warns, at the top', failed.split('\n')[2].includes('could not be run'));

    const md = renderFactCheck({ ok: true, claims: [{ claim: 'P', verdict: 'verified', url: REAL }] }, { flavour: 'markdown' });
    const mrk = renderFactCheck({ ok: true, claims: [{ claim: 'P', verdict: 'verified', url: REAL }] });
    check('mrkdwn links for the webhook', mrk.text.includes(`<${REAL}|source>`));
    check('Markdown links for the connector', md.text.includes(`[source](${REAL})`));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
