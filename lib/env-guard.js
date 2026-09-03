'use strict';
// Refuses test-only environment variables in the runtimes where they would
// weaken the system.
//
// N3, second security review, 30 Aug 2026. Two variables silently reduce
// security if set, and neither would announce itself:
//
//   GRAPH_HOST     redirects every Meta API call - and the access tokens sent
//                  with them - to an arbitrary host. Exists so the suite can
//                  point at a mock. Currently set by nothing at all.
//   GUARD_DURABLE  disables the persistent brute-force counter, leaving only the
//                  per-instance one, which a recycled serverless instance
//                  resets. Set by three test scripts, all run on a laptop.
//
// Both were verified unset in CI, in committed config and in Vercel production.
// This exists so that stays true by construction rather than by inspection.
//
// Guarded per runtime rather than globally, because "production" means different
// things to different parts of this system:
//
//   GRAPH_HOST     dangerous anywhere real Meta tokens are used, which is the
//                  collector in GitHub Actions and the API on Vercel.
//   GUARD_DURABLE  only reachable by the API, which only runs on Vercel. A
//                  future CI test job is therefore not affected.
//
// Fails loudly at load rather than degrading. A misconfiguration that silently
// weakens security is exactly what this file exists to prevent, so it must not
// itself fail quietly.

const onVercelProduction = () => process.env.VERCEL_ENV === 'production';
const inGitHubActions = () => String(process.env.GITHUB_ACTIONS || '') === 'true';

function refuse(name, why) {
  const e = new Error(
    `${name} is set in a production runtime. ${why} `
    + 'It is a test-only setting; remove it from the environment. '
    + 'See lib/env-guard.js.',
  );
  e.code = 'UNSAFE_ENV';
  throw e;
}

// Called by lib/graph.js, which every path that talks to Meta goes through.
function assertGraphHostSafe() {
  if (!process.env.GRAPH_HOST) return;
  if (onVercelProduction() || inGitHubActions()) {
    refuse('GRAPH_HOST',
      'It would send Meta access tokens to a host other than graph.facebook.com.');
  }
}

// Called by lib/guard.js, which only the HTTP API loads.
function assertDurableGuardSafe() {
  if (String(process.env.GUARD_DURABLE || '').toLowerCase() !== 'off') return;
  if (onVercelProduction()) {
    refuse('GUARD_DURABLE=off',
      'It disables the brute-force counter that survives a cold start.');
  }
}

// Called by lib/google.js. Any of these redirects staff sign-in to another
// server or makes forged identities verify. Exist for the mock in the suite.
const GOOGLE_SEAMS = ['GOOGLE_AUTH_URL', 'GOOGLE_TOKEN_URL', 'GOOGLE_JWKS_URL', 'GOOGLE_ISSUERS'];
function assertGoogleEndpointsSafe() {
  if (!onVercelProduction()) return;
  for (const name of GOOGLE_SEAMS) {
    if (process.env[name]) refuse(name, 'It would point Google sign-in at a server other than Google.');
  }
}

module.exports = {
  assertGraphHostSafe, assertDurableGuardSafe, assertGoogleEndpointsSafe, onVercelProduction, inGitHubActions,
};
