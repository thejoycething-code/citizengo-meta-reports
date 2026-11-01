#!/usr/bin/env node
'use strict';
// One-time key pair for Content Engine publishing (slice 2). Run ON THE MINI:
//
//   node scripts/engine-keygen.js ~/runner/meta-reports/.env
//
// ENGINE_TOKEN_PRIVATE_KEY is written into that env file (mode 600) and never
// printed: only the publisher on the Mini can open sealed Page tokens.
// ENGINE_TOKEN_PUBLIC_KEY is printed for the Vercel environment, where Connect
// Facebook seals each token with it. Refuses to run twice: a new pair would
// make every stored Page token unreadable until each person reconnects.

const fs = require('fs');
const xauth = require('../lib/xauth');

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/engine-keygen.js <env file on the Mini>'); process.exit(2); }
const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const oneLine = (pem) => pem.trim().replace(/\n/g, '\\n');
const have = existing.match(/^ENGINE_TOKEN_PRIVATE_KEY=(.+)$/m);
if (have) {
  // Already set up: print the matching public key again, change nothing.
  const pub = xauth.publicKeyOf(have[1].replace(/\\n/g, '\n'));
  console.log(`ENGINE_TOKEN_PRIVATE_KEY is already in ${file}; nothing changed.`);
  console.log('ENGINE_TOKEN_PUBLIC_KEY=' + oneLine(pub));
  process.exit(0);
}
const kp = xauth.generateKeyPair();
fs.appendFileSync(file, `${existing && !existing.endsWith('\n') ? '\n' : ''}ENGINE_TOKEN_PRIVATE_KEY=${oneLine(kp.privateKey)}\n`, { mode: 0o600 });
fs.chmodSync(file, 0o600);
console.log(`ENGINE_TOKEN_PRIVATE_KEY written to ${file} (mode 600).`);
console.log('ENGINE_TOKEN_PUBLIC_KEY=' + oneLine(kp.publicKey));
