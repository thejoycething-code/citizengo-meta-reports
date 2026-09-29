#!/usr/bin/env node
'use strict';
// Tests for the subscription fact check (lib/claude-fact-check.js), against a
// fake Claude Code process, so they spend nothing.
//
// The ones that matter most are the billing guards: an API key never reaches
// the child, --bare is never passed, and a run that reports an API key is
// killed rather than allowed to bill the API.

const { EventEmitter } = require('events');
const { claudeFactCheck, renderClaims, childEnv, ARGS } = require('../lib/claude-fact-check');

let pass = 0; let fail = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const REAL = 'https://www.london.gov.uk/example';
const init = (source = 'none') => ({ type: 'system', subtype: 'init', apiKeySource: source });
const toolUse = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebSearch', input: { query: 'x' } }] } };
const toolResult = { type: 'user', message: { content: [{ type: 'tool_result', content: `Links: [{"title":"t","url":"${REAL}"}]` }] } };
const result = (claims, extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify({ claims }), ...extra });

// A fake child process that emits the given stream-json events.
function fakeSpawn(events, seen = {}) {
  return (bin, args, opts) => {
    seen.args = args; seen.env = opts.env; seen.killed = false;
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => { seen.killed = true; };
    setImmediate(() => {
      for (const e of events) child.stdout.emit('data', JSON.stringify(e) + '\n');
      child.emit('close', 0);
    });
    return child;
  };
}
const ENV = { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test', ANTHROPIC_API_KEY: 'sk-ant-api-SHOULD-NOT-PASS', PATH: '/usr/bin' };
const POST = { message: 'Almost 60,000 voices presented to Mayor Sadiq Khan.', pageName: 'Citizen GO UK', published: '2026-09-26' };

(async () => {
  console.log('\nBilling guards\n');
  {
    const env = childEnv(ENV);
    check('the API key is stripped from the child', !('ANTHROPIC_API_KEY' in env));
    check('the OAuth token is kept', env.CLAUDE_CODE_OAUTH_TOKEN === 'sk-ant-oat-test');
    check('--bare is never passed (it forces API billing)', !ARGS.includes('--bare'));
    check('only WebSearch and WebFetch are available', ARGS[ARGS.indexOf('--tools') + 1] === 'WebSearch,WebFetch');

    const seen = {};
    await claudeFactCheck(POST, { env: ENV, spawn: fakeSpawn([init(), result([])], seen) });
    check('the spawned child never sees the API key', !('ANTHROPIC_API_KEY' in seen.env));

    const seen2 = {};
    const r = await claudeFactCheck(POST, { env: ENV, spawn: fakeSpawn([init('ANTHROPIC_API_KEY'), result([])], seen2) });
    check('a run that picked an API key is refused', !r.ok && /API key/.test(r.error), JSON.stringify(r));
    check('and killed', seen2.killed);

    const r2 = await claudeFactCheck(POST, { env: { PATH: '/usr/bin' }, spawn: fakeSpawn([]) });
    check('no subscription token means no run', !r2.ok && /CLAUDE_CODE_OAUTH_TOKEN/.test(r2.error));
  }

  console.log('\nResults\n');
  {
    const r = await claudeFactCheck(POST, { env: ENV, spawn: fakeSpawn([init(), toolUse, toolResult, result([
      { claim: 'Petition had almost 60,000 signatures', verdict: 'verified', url: REAL },
      { claim: 'Presented by Susan Hall', verdict: 'verified', url: 'https://invented.example/story' },
    ])]) });
    check('parses the verdicts', r.ok && r.claims.length === 2, JSON.stringify(r));
    check('a link from the tool results is kept', r.claims[0].url === REAL);
    check('an invented link is dropped', r.claims[1].url === null);
    check('"verified" without a showable source becomes unverified', r.claims[1].verdict === 'unverified');

    const notLoggedIn = await claudeFactCheck(POST, { env: ENV, spawn: fakeSpawn([init(), { type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' }]) });
    check('"not logged in" (probed: reports apiKeySource none) is a failure', !notLoggedIn.ok && /Not logged in/.test(notLoggedIn.error), JSON.stringify(notLoggedIn));

    const limit = await claudeFactCheck(POST, { env: ENV, spawn: fakeSpawn([init(), { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'usage limit reached' }]) });
    check('a subscription limit is a failure, not a throw', !limit.ok);

    const noResult = await claudeFactCheck(POST, { env: ENV, spawn: fakeSpawn([init()]) });
    check('exiting without a result is a failure', !noResult.ok && /without a result/.test(noResult.error));

    const noJson = await claudeFactCheck(POST, { env: ENV, spawn: fakeSpawn([init(), { type: 'result', subtype: 'success', is_error: false, result: 'I could not do that.' }]) });
    check('a reply with no JSON is a failure', !noJson.ok);

    const missing = await claudeFactCheck(POST, { env: ENV, bin: '/nonexistent/claude' });
    check('a missing CLI is a failure, not a throw', !missing.ok && /could not start/.test(missing.error), JSON.stringify(missing));
  }

  console.log('\nThe block\n');
  {
    const warn = renderClaims([{ claim: 'P', verdict: 'wrong', note: 'Reported as 40,000', url: REAL }], { mediaType: 'video' });
    check('a wrong claim is a warning at the top', warn.where === 'top' && warn.text.includes('Check before reusing'));
    check('a video notes only the caption was checked', warn.text.includes('video or image itself was not'));
    const clean = renderClaims([{ claim: 'P', verdict: 'verified', note: '', url: REAL }], { mediaType: 'link' });
    check('all verified goes at the end, with sources', clean.where === 'bottom' && clean.text.includes(`<${REAL}|source>`));
    const none = renderClaims([], {});
    check('no claims says so', none.where === 'bottom' && none.text.includes('no factual claims'));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
