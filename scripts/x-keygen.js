#!/usr/bin/env node
'use strict';
// One-time key material for the X source. Prints, never stores:
//
//   X_TOKEN_PRIVATE_KEY  -> GitHub Actions secret ONLY (the collector opens tokens)
//   X_TOKEN_PUBLIC_KEY   -> Vercel environment      (the callback seals tokens)
//   X_INVITE_SECRET      -> BOTH (mints and verifies invite links)
//
// The split is the point: the deployment that faces the internet can write
// credentials it cannot read. Run once; a second run makes every stored
// credential unreadable until each account re-authorises.

const crypto = require('crypto');
const xauth = require('../lib/xauth');

const kp = xauth.generateKeyPair();
const invite = crypto.randomBytes(32).toString('base64url');
const oneLine = (pem) => pem.trim().replace(/\n/g, '\\n');

console.log('\n# GitHub Actions secret (repository > Settings > Secrets and variables > Actions):');
console.log('X_TOKEN_PRIVATE_KEY=' + oneLine(kp.privateKey));
console.log('\n# Vercel environment variable (Production):');
console.log('X_TOKEN_PUBLIC_KEY=' + oneLine(kp.publicKey));
console.log('\n# Both GitHub Actions and Vercel, and your local .env for npm run x:invite:');
console.log('X_INVITE_SECRET=' + invite);
console.log('\nKeys are printed with literal \\n; the code turns them back into PEM. Paste each value once and close this terminal.');
