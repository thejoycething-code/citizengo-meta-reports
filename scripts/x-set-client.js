#!/usr/bin/env node
'use strict';
// Put the X app's OAuth 2.0 Client ID and Client Secret everywhere they are
// needed, without either value touching the chat, the screen or shell history.
//
//   npm run x:set-client
//
// Asks for both with echo off, then writes them to:
//   * local .env (chmod 600)                 - for x:invite and local runs
//   * GitHub Actions secrets                 - the nightly collector refreshes tokens
//   * Vercel production env (sensitive)      - the enrolment callback exchanges codes
//
// Take them from developer.x.com > your app > Keys and tokens >
// "OAuth 2.0 Client ID and Client Secret". NOT the "API Key and Secret" (that is
// OAuth 1.0a) and NOT the Bearer Token (app-only, cannot read private metrics).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ENV = path.join(ROOT, '.env');
const REPO = 'thejoycething-code/citizengo-meta-reports';
const SCOPE = 'team_rpnwoDBcJ5Wz1K5P8UCTGY2k';

function askHidden(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData);
          process.stdout.write('\n');
          return resolve(value.trim());
        }
        if (c === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') { value = value.slice(0, -1); continue; }
        value += c;
      }
    };
    stdin.on('data', onData);
  });
}

function run(cmd, args, input) {
  const r = spawnSync(cmd, args, { cwd: ROOT, input, encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}` };
}

function setEnvFile(key, value) {
  let s = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  s = re.test(s) ? s.replace(re, line) : s.replace(/\n?$/, '\n') + line + '\n';
  fs.writeFileSync(ENV, s, { mode: 0o600 });
  fs.chmodSync(ENV, 0o600);
}

async function main() {
  if (!process.stdin.isTTY) { console.error('Run this in a terminal, so the values can be typed with echo off.'); process.exit(2); }
  console.log('\nX app credentials. Paste each value and press Enter; nothing will show as you paste.\n');
  const id = await askHidden('  OAuth 2.0 Client ID:     ');
  const secret = await askHidden('  OAuth 2.0 Client Secret: ');

  // Shape checks, so an API Key or Bearer Token pasted by mistake is caught
  // here rather than as a failed token exchange later.
  if (!id || id.length < 20 || /\s/.test(id)) { console.error('\nThat Client ID looks wrong (too short, or contains spaces). Nothing was saved.'); process.exit(1); }
  if (!secret || secret.length < 30 || /\s/.test(secret)) { console.error('\nThat Client Secret looks wrong. Nothing was saved.'); process.exit(1); }
  if (/^AAAA/.test(secret)) { console.error('\nThat looks like a Bearer Token, not the OAuth 2.0 Client Secret. Nothing was saved.'); process.exit(1); }
  // Pasting into a prompt that shows nothing invites pasting again. Caught on
  // 30 Sep 2026: the Client ID arrived three times over, 102 characters.
  for (const [name, v] of [['Client ID', id], ['Client Secret', secret]]) {
    for (let n = 2; n <= 4; n++) {
      if (v.length % n === 0 && v.slice(0, v.length / n).repeat(n) === v) {
        console.error(`\nThe ${name} is the same text pasted ${n} times. Paste it once. Nothing was saved.`); process.exit(1);
      }
    }
  }
  if (id === secret) { console.error('\nThe two values are identical. Nothing was saved.'); process.exit(1); }

  console.log(`\n  Client ID ${id.length} chars, Client Secret ${secret.length} chars.\n`);
  const results = [];

  setEnvFile('X_CLIENT_ID', id);
  setEnvFile('X_CLIENT_SECRET', secret);
  results.push(['local .env', true]);

  for (const [k, v] of [['X_CLIENT_ID', id], ['X_CLIENT_SECRET', secret]]) {
    const g = run('gh', ['secret', 'set', k, '-R', REPO], v);
    results.push([`GitHub secret ${k}`, g.ok, g.out]);
  }

  for (const [k, v] of [['X_CLIENT_ID', id], ['X_CLIENT_SECRET', secret]]) {
    // Replace, not add: `vercel env add` refuses a name that already exists.
    run('vercel', ['env', 'rm', k, 'production', '--yes', '--scope', SCOPE]);
    const a = run('vercel', ['env', 'add', k, 'production', '--sensitive', '--scope', SCOPE], v);
    results.push([`Vercel env ${k}`, a.ok, a.out]);
  }

  let failed = 0;
  for (const [label, ok, out] of results) {
    console.log(`  ${ok ? 'SAVED ' : 'FAILED'}  ${label}`);
    if (!ok) { failed++; console.log(`          ${String(out || '').trim().split('\n').slice(-2).join(' | ')}`); }
  }
  console.log(failed ? '\nSome steps failed; the ones marked SAVED are done. Re-run to retry.' : '\nAll saved. Go back to the chat and say done.');
  process.exit(failed ? 1 : 0);
}

main();
