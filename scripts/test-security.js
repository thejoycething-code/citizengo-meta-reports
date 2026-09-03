#!/usr/bin/env node
'use strict';
// Regression tests for the controls added after the 30 Aug 2026 security review.
//
// Every case here maps to a finding. They exist because the suite that already
// passed had no security cases at all: it verified that the tools answered, not
// that the door was shut. All three findings fixed here were live in production
// while every test was green.

const fs = require('fs');
const http = require('http');
const path = require('path');

const PORT = 5811;
const ROOT = path.join(__dirname, '..');

// A token that satisfies the strength rule: 24+ chars, three character classes,
// plenty of distinct characters.
const STRONG = 'cgo_Kd8vQ2mXpL7nRt4wYzB6hJ3s';
// The shape that was live in production until this review: twenty characters,
// one character class, dictionary words.
const WEAK = 'cgo_team_shared_2026';

process.env.MCP_TOKENS = STRONG;
process.env.SUPABASE_URL = 'http://localhost:1';       // never reached; auth fails first
process.env.GUARD_DURABLE = 'off';                     // never touch the real failure log
process.env.SUPABASE_SERVICE_KEY = 'unused';
process.env.AUTH_FAIL_LIMIT = '5';
process.env.MCP_MAX_BATCH = '20';
process.env.OAUTH_SIGNING_SECRET = 'test-signing-secret-not-a-real-one';

const handler = require(path.join(ROOT, 'api', 'mcp.js'));
const guard = require(path.join(ROOT, 'lib', 'guard.js'));

let pass = 0; let fail = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

// Each request declares its own source, so the failure limiter can be exercised
// from "different" clients without needing real network interfaces.
// Extended 3 Sep 2026 to carry arbitrary headers and return the response's, so
// Origin handling and cache directives can be asserted.
async function call(body, token, source = '203.0.113.1', extra = {}, method = 'POST') {
  const res = await fetch(`http://localhost:${PORT}/api/mcp`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-vercel-forwarded-for': source,
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...extra,
    },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
  const headers = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  return { status: res.status, text: await res.text(), headers };
}

const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };

(async () => {
  const server = http.createServer((req, res) => {
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    res.send = (t) => res.end(t);
    handler(req, res);
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  console.log('\nCredential strength (F1)\n');

  check('a 20-char single-class token is judged weak',
    guard.tokenWeakness(WEAK) !== null, guard.tokenWeakness(WEAK) || 'accepted');
  check('a random 24+ char token is judged strong',
    guard.tokenWeakness(STRONG) === null, guard.tokenWeakness(STRONG));
  check('the token that was live in production would no longer authenticate',
    !guard.matchesAny(WEAK, guard.usableTokens(WEAK)));
  check('a strong token authenticates',
    guard.matchesAny(STRONG, guard.usableTokens(STRONG)));
  check('a weak token is dropped even when configured alongside a strong one',
    guard.usableTokens(`${WEAK},${STRONG}`).length === 1);

  console.log('\nPer-person identity\n');

  check('a bare token is identified by its fingerprint',
    guard.identify(STRONG, guard.usableTokens(STRONG)) === guard.fingerprint(STRONG));
  check('a name:token entry is identified by name',
    guard.identify(STRONG, guard.usableTokens(`alice:${STRONG}`)) === 'alice');
  {
    const two = guard.usableTokens(`alice:${STRONG},bob:cgo_Zm5Wq8tRx2NpKv6yLd4H`);
    check('two people can hold different tokens', two.length === 2, `${two.length} usable`);
    check('each is told apart',
      guard.identify(STRONG, two) === 'alice'
      && guard.identify('cgo_Zm5Wq8tRx2NpKv6yLd4H', two) === 'bob');
    check('removing one entry revokes only that person',
      guard.identify(STRONG, guard.usableTokens('bob:cgo_Zm5Wq8tRx2NpKv6yLd4H')) === null);
  }
  check('a weak token is still rejected when it carries a name',
    guard.usableTokens(`carol:${WEAK}`).length === 0);
  check('a token containing a colon survives the name split',
    guard.identify('cgo_Ab3:Cd9Xq7RmT2vLp5Wz', guard.usableTokens('dave:cgo_Ab3:Cd9Xq7RmT2vLp5Wz')) === 'dave');

  console.log('\nRedirect allowlist (who may receive a code)\n');

  {
    const { redirectUriAllowed } = require(path.join(ROOT, 'lib', 'oauth.js'));
    const allow = [
      'https://claude.ai/api/mcp/auth_callback',
      'https://chatgpt.com/connector_platform_oauth_redirect',
      // ChatGPT generates a callback per connection, so the path varies.
      'https://chatgpt.com/connector/abc123/callback',
      'https://chat.openai.com/aip/oauth/callback',
      'http://localhost:8123/callback',
    ];
    const deny = [
      'https://claude.ai/evil',                    // right origin, wrong path
      'https://chatgpt.com.attacker.example/x',    // origin-prefix lookalike
      'https://evil.example/callback',
      'https://notchatgpt.com/x',
      'http://chatgpt.com/x',                      // http, not https
      'javascript:alert(1)',
      '',
    ];
    check('every assistant callback we support is allowed',
      allow.every(redirectUriAllowed),
      allow.filter((u) => !redirectUriAllowed(u)).join(' '));
    check('lookalike and off-allowlist destinations are refused',
      deny.every((u) => !redirectUriAllowed(u)),
      deny.filter(redirectUriAllowed).join(' '));
  }

  console.log('\nOAuth sessions are attributable, revocable and audience-bound\n');

  {
    const { sign } = require(path.join(ROOT, 'lib', 'oauth.js'));
    process.env.MCP_TOKENS = `alice:${STRONG}`;
    // What this test server is, as originOf(req) derives it from the Host header.
    const EXPECT = { iss: `http://localhost:${PORT}`, aud: `http://localhost:${PORT}/api/mcp` };
    const mint = (extra) => sign({ typ: 'access', scope: 'mcp', who: 'alice', ...EXPECT, ...extra }, 3600);

    const aliceOauth = mint();
    check('an OAuth token issued to alice is accepted',
      (await call(ping, aliceOauth, '198.51.100.30')).status === 200);

    // The point of the whole exercise: deleting the entry ends the session on
    // the NEXT request, not when the refresh token happens to expire.
    process.env.MCP_TOKENS = 'bob:cgo_Zm5Wq8tRx2NpKv6yLd4H';
    check('removing alice from MCP_TOKENS revokes her OAuth session immediately',
      (await call(ping, aliceOauth, '198.51.100.31')).status === 401);

    process.env.MCP_TOKENS = `alice:${STRONG}`;
    check('restoring the entry restores the session',
      (await call(ping, aliceOauth, '198.51.100.32')).status === 200);

    // Carlo Manuali, 3 Sep 2026: issuer, audience, expiry and scope must all be
    // validated. Until then signature and expiry were, and nothing else.
    check('a token naming another deployment as issuer is refused',
      (await call(ping, mint({ iss: 'https://preview-abc.vercel.app' }), '198.51.100.35')).status === 401);
    check('a token for another audience is refused',
      (await call(ping, mint({ aud: 'https://other.example/api/mcp' }), '198.51.100.36')).status === 401);
    check('a token without the mcp scope is refused',
      (await call(ping, mint({ scope: 'email' }), '198.51.100.37')).status === 401);
    check('an expired token is refused',
      (await call(ping, sign({ typ: 'access', scope: 'mcp', who: 'alice', ...EXPECT }, -5), '198.51.100.38')).status === 401);

    const legacy = sign({ typ: 'access', scope: 'mcp', who: 'alice' }, 3600);
    check('a token minted before audience binding is refused, so everyone re-consents once',
      (await call(ping, legacy, '198.51.100.33')).status === 401);

    const forged = mint({ who: 'mallory' });
    check('a signed token naming somebody not in MCP_TOKENS is refused',
      (await call(ping, forged, '198.51.100.34')).status === 401);

    process.env.MCP_TOKENS = STRONG;
  }

  console.log('\nDurable failure store (survives cold starts)\n');

  check('an unreachable database does not break authentication',
    (await call(ping, STRONG, '192.0.2.5')).status === 200,
    'SUPABASE_URL points at a dead port in this test');
  check('failureLimited is async, so it can consult the database',
    guard.failureLimited('192.0.2.6') instanceof Promise);

  console.log('\nBrute force (F1)\n');

  {
    const r = await call(ping, STRONG, '198.51.100.9');
    check('valid token still works', r.status === 200, `HTTP ${r.status}`);
  }
  {
    // Five distinct wrong tokens: the old limiter was keyed on the credential,
    // so each of these opened its own bucket and none of them ever counted.
    const src = '198.51.100.20';
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await call(ping, `wrong-guess-${i}`, src)).status);
    const sixth = await call(ping, 'wrong-guess-6', src);
    check('five failures from one source are 401', codes.every((c) => c === 401), codes.join(','));
    check('the sixth is refused with 429 despite a different token each time',
      sixth.status === 429, `HTTP ${sixth.status}`);
  }
  {
    const other = await call(ping, STRONG, '198.51.100.77');
    check('a different source is unaffected by another source being throttled',
      other.status === 200, `HTTP ${other.status}`);
  }
  {
    // The limiter must be checked before the credential, so a throttled source
    // cannot use response codes to tell a right guess from a wrong one.
    const r = await call(ping, STRONG, '198.51.100.20');
    check('a throttled source is refused even when it finally sends the right token',
      r.status === 429, `HTTP ${r.status}`);
  }

  console.log('\nBatch amplification (F2)\n');

  {
    const big = Array.from({ length: 21 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' }));
    const r = await call(big, STRONG, '203.0.113.50');
    check('a batch over the cap is rejected', r.status === 400, `HTTP ${r.status}`);
    check('the rejection says what the cap is', /maximum 20/.test(r.text), r.text.slice(0, 80));
  }
  {
    const ok = Array.from({ length: 5 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' }));
    const r = await call(ok, STRONG, '203.0.113.51');
    check('a batch within the cap still works', r.status === 200, `HTTP ${r.status}`);
  }
  {
    // 60 calls/minute: thirteen five-message batches is 65 messages. Under the
    // old per-request accounting this was thirteen requests and well within
    // quota, which is exactly how a batch bought unlimited work.
    const src = '203.0.113.60';
    const batch = Array.from({ length: 5 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' }));
    let throttled = false;
    for (let i = 0; i < 13 && !throttled; i++) {
      if ((await call(batch, STRONG, src)).status === 429) throttled = true;
    }
    check('the quota is charged per message, so batching cannot buy extra work', throttled);
  }

  console.log('\nOpen access is opted into, never inherited\n');

  {
    const saved = process.env.MCP_TOKENS;

    // THE CASE THAT MATTERS. Losing MCP_TOKENS - a bad Vercel edit, a secret
    // that does not copy to a new environment - must keep refusing. Open access
    // is a decision somebody made, not the absence of one.
    process.env.MCP_TOKENS = '';
    delete process.env.MCP_PUBLIC;
    check('no tokens and no flag still refuses everything',
      (await call(ping, null, '203.0.113.120')).status === 401,
      'a missing secret must never publish the data');

    process.env.MCP_PUBLIC = 'true';
    check('with MCP_PUBLIC=true an unauthenticated request is served',
      (await call(ping, null, '203.0.113.121')).status === 200);

    // A DIFFERENT token, deliberately. The quota is keyed on the credential, and
    // the batch test above spends STRONG's whole minute on purpose - reusing it
    // here measured that exhausted bucket rather than the thing being tested.
    const SECOND = 'cgo_Tn4Bv8kQx2WmZ6rLd9Hy';
    process.env.MCP_TOKENS = `${STRONG},${SECOND}`;
    check('a configured token still works while public, so nothing reconnects on a flip',
      (await call(ping, SECOND, '203.0.113.122')).status === 200);

    // Anonymous callers must not share one bucket, or they throttle each other.
    let selfThrottled = false;
    for (let i = 0; i < 8 && !selfThrottled; i++) {
      if ((await call(ping, null, '203.0.113.130')).status === 429) selfThrottled = true;
    }
    check('one anonymous source does not throttle another',
      (await call(ping, null, '203.0.113.131')).status === 200);

    process.env.MCP_PUBLIC = 'false';
    check('setting the flag to false closes it again',
      (await call(ping, null, '203.0.113.140')).status === 401);

    delete process.env.MCP_PUBLIC;
    process.env.MCP_TOKENS = saved;
  }

  console.log('\nOrigin validation and response caching (Carlo Manuali, 3 Sep)\n');

  {
    // A token of its own: the batch test above spends STRONG's minute on purpose.
    const THIRD = 'cgo_Pq7Lm3Xw9Rt2Vb5Nz8Kd';
    const savedTokens = process.env.MCP_TOKENS;
    process.env.MCP_TOKENS = `${STRONG},${THIRD}`;
    const src = (n) => `203.0.113.${n}`;
    const hostile = { Origin: 'https://attacker.example' };

    const r1 = await call(ping, THIRD, src(150), hostile);
    check('a POST from an untrusted origin is refused with 403', r1.status === 403, `HTTP ${r1.status}`);
    check('the refusal grants no CORS access', !r1.headers['access-control-allow-origin']);
    const r2 = await call(ping, null, src(151), { ...hostile, 'Access-Control-Request-Method': 'POST' }, 'OPTIONS');
    check('a preflight from an untrusted origin is refused with 403', r2.status === 403, `HTTP ${r2.status}`);

    const r3 = await call(ping, THIRD, src(152), { Origin: 'https://claude.ai' });
    check('claude.ai is allowed', r3.status === 200, `HTTP ${r3.status}`);
    check('the grant names that origin exactly, never *',
      r3.headers['access-control-allow-origin'] === 'https://claude.ai', r3.headers['access-control-allow-origin']);
    check('and tells caches the answer varies by origin', /\borigin\b/i.test(r3.headers.vary || ''), r3.headers.vary);

    const r4 = await call(ping, THIRD, src(153));
    check('a request with no Origin - every real MCP client - is served', r4.status === 200, `HTTP ${r4.status}`);
    check('and receives no CORS grant, because none was asked for', !r4.headers['access-control-allow-origin']);
    check('a local MCP client on a loopback origin is allowed',
      (await call(ping, THIRD, src(154), { Origin: 'http://localhost:6274' })).status === 200);
    check('an opaque "null" origin is refused',
      (await call(ping, THIRD, src(155), { Origin: 'null' })).status === 403);
    check('an origin-prefix lookalike is refused',
      (await call(ping, THIRD, src(156), { Origin: 'https://claude.ai.attacker.example' })).status === 403);
    process.env.MCP_ALLOWED_ORIGINS = 'https://inspector.example';
    check('MCP_ALLOWED_ORIGINS adds an exact origin without a redeploy',
      (await call(ping, THIRD, src(157), { Origin: 'https://inspector.example' })).status === 200);
    delete process.env.MCP_ALLOWED_ORIGINS;

    check('a served response is private and not stored',
      r4.headers['cache-control'] === 'private, no-store', r4.headers['cache-control']);
    const r5 = await call(ping, null, src(158));
    check('so is a refusal',
      r5.status === 401 && r5.headers['cache-control'] === 'private, no-store', r5.headers['cache-control']);
    check('responses are marked nosniff', r4.headers['x-content-type-options'] === 'nosniff');
    check('a 401 with no credential carries the bare challenge',
      /^Bearer resource_metadata=/.test(r5.headers['www-authenticate'] || '')
      && !/error=/.test(r5.headers['www-authenticate'] || ''), r5.headers['www-authenticate']);
    const r6 = await call(ping, 'not.a.real.token', src(159));
    check('a 401 for a wrong credential says invalid_token',
      r6.status === 401 && /error="invalid_token"/.test(r6.headers['www-authenticate'] || ''), r6.headers['www-authenticate']);

    process.env.MCP_TOKENS = savedTokens;
  }

  console.log('\nOpen access cannot be enabled in production\n');

  {
    process.env.MCP_PUBLIC = 'true';
    // An explicitly wrong credential is refused even while the flag is on: a
    // revoked person must find out, not be silently downgraded to anonymous.
    const wrong = await call(ping, 'this.is.garbage', '203.0.113.160');
    check('an invalid bearer is refused even under open access', wrong.status === 401, `HTTP ${wrong.status}`);
    check('while a request with no credential is still served off production',
      (await call(ping, null, '203.0.113.161')).status === 200);
    process.env.VERCEL_ENV = 'production';
    check('but on Vercel production the flag is ignored', handler.publicAccess() === false);
    delete process.env.VERCEL_ENV;
    check('and honoured again off production', handler.publicAccess() === true);
    delete process.env.MCP_PUBLIC;
  }

  console.log('\nAudit-log hygiene (second review, N1/N2)\n');

  {
    const { supabaseStore, fileStore } = require(path.join(ROOT, 'lib', 'store.js'));
    const supa = supabaseStore({ url: 'http://localhost:1', serviceKey: 'k' });
    check('the store exposes retention, so it can actually be called',
      typeof supa.pruneAuthFailures === 'function');
    check('the file backend does not pretend to offer it',
      typeof fileStore({ dir: './data' }).pruneAuthFailures === 'undefined');

    // N1: the schema must not define a function in the public schema, because
    // PostgREST publishes those as RPC endpoints executable by PUBLIC.
    const schema = fs.readFileSync(path.join(ROOT, 'sql', 'schema.sql'), 'utf8');
    check('no function is defined in the public schema',
      !/create (or replace )?function public\./i.test(schema),
      'a public function becomes a callable REST endpoint');

    // N2: retention has to be invoked by something. A cleanup nothing calls is
    // exactly the failure this replaced.
    const watchdog = fs.readFileSync(path.join(ROOT, 'scripts', 'check-freshness.js'), 'utf8');
    check('the daily watchdog invokes retention',
      /pruneAuthFailures\(/.test(watchdog));
  }

  console.log('\nTest seams refused in production (N3)\n');

  {
    const guardPath = path.join(ROOT, 'lib', 'env-guard.js');
    // Each case reloads the module so it reads the environment fresh.
    const under = (env, fn) => {
      const saved = { ...process.env };
      Object.assign(process.env, env);
      delete require.cache[require.resolve(guardPath)];
      let refused = false;
      try { require(guardPath)[fn](); } catch (e) { refused = e.code === 'UNSAFE_ENV'; }
      for (const k of Object.keys(env)) delete process.env[k];
      Object.assign(process.env, saved);
      return refused;
    };

    check('GRAPH_HOST is refused in GitHub Actions, where the collector runs',
      under({ GRAPH_HOST: 'http://attacker.example', GITHUB_ACTIONS: 'true' }, 'assertGraphHostSafe'));
    check('GRAPH_HOST is refused on Vercel production',
      under({ GRAPH_HOST: 'http://attacker.example', VERCEL_ENV: 'production' }, 'assertGraphHostSafe'));
    check('GRAPH_HOST is allowed locally, so the mock still works',
      !under({ GRAPH_HOST: 'http://localhost:9' }, 'assertGraphHostSafe'));
    check('an unset GRAPH_HOST does not trip the guard in production',
      !under({ VERCEL_ENV: 'production' }, 'assertGraphHostSafe'));

    check('GUARD_DURABLE=off is refused on Vercel production',
      under({ GUARD_DURABLE: 'off', VERCEL_ENV: 'production' }, 'assertDurableGuardSafe'));
    check('GUARD_DURABLE=off is allowed locally, so these tests can run',
      !under({ GUARD_DURABLE: 'off' }, 'assertDurableGuardSafe'));
    // Scoped deliberately: the API only runs on Vercel, so a CI test job that
    // needs the seam is not production for this code and must not be blocked.
    check('GUARD_DURABLE=off is allowed in CI, so a future test job still runs',
      !under({ GUARD_DURABLE: 'off', GITHUB_ACTIONS: 'true' }, 'assertDurableGuardSafe'));
  }

  console.log('\nConsent page cannot be framed\n');

  {
    const authorize = require(path.join(ROOT, 'api', 'oauth', 'authorize.js'));
    // Minimal response double: records what the handler set.
    const headersOn = async (query) => {
      const set = {};
      const res = {
        setHeader: (k, v) => { set[k.toLowerCase()] = v; },
        status: () => res, send: () => res, json: () => res, end: () => res,
        writeHead: () => res,
      };
      await authorize({ method: 'GET', query, headers: {} }, res);
      return set;
    };

    const good = await headersOn({
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_challenge: 'abc', code_challenge_method: 'S256',
    });
    check('the rendered consent page refuses to be framed',
      good['x-frame-options'] === 'DENY', JSON.stringify(good['x-frame-options']));
    check('its policy also blocks framing and pins form submission',
      /frame-ancestors 'none'/.test(good['content-security-policy'] || '')
      && /form-action 'self'/.test(good['content-security-policy'] || ''),
      good['content-security-policy']);
    check('it is not cached', good['cache-control'] === 'no-store');
    // A referrer policy of no-referrer makes the browser send Origin: null on
    // this page's own form POST, which the Origin check refuses. Learned live.
    check('its referrer policy lets the form POST carry a real Origin',
      good['referrer-policy'] === 'same-origin', good['referrer-policy']);

    // A header set only on the happy path protects only the requests that were
    // never at risk, so the rejection paths are checked too.
    const bad = await headersOn({ redirect_uri: 'https://evil.example/x' });
    check('the rejection path carries the same headers',
      bad['x-frame-options'] === 'DENY' && !!bad['content-security-policy']);
  }

  console.log('\nFail closed (F1)\n');

  {
    const saved = process.env.MCP_TOKENS;
    process.env.MCP_TOKENS = '';
    const r = await call(ping, STRONG, '203.0.113.90');
    process.env.MCP_TOKENS = saved;
    check('with no tokens configured every request is refused',
      r.status === 401, `HTTP ${r.status}`);
  }

  server.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
