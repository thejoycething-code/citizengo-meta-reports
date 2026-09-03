#!/usr/bin/env node
'use strict';
// Issue, revoke and list per-person access tokens for the MCP connector.
//
//   npm run tokens -- add <name> [--note "Candela García"]   mint, store the hash, print the token ONCE (valid 90 days)
//   npm run tokens -- revoke <name>                          next call from that token is 401
//   npm run tokens -- rotate <name>                          revoke + add
//   npm run tokens -- list                                   who has one, when it was last used
//
// Runs on the operator's machine with SUPABASE_SERVICE_KEY from .env. Nothing
// here redeploys anything: the connector reads the table live (30s cache).
// The token is printed exactly once and never stored; lose it and you rotate.

const crypto = require('crypto');
const os = require('os');
const { loadEnv } = require('../lib/graph');
loadEnv();
const guard = require('../lib/guard');
const { hash, live } = require('../lib/tokens');

// 90 days. Long enough not to be a nuisance, short enough that a token nobody
// re-confirms stops working on its own.
const TTL_DAYS = Number(process.env.TOKEN_TTL_DAYS || 90);

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) { console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required (see .env)'); process.exit(2); }
const base = url.trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
const H = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const T = `${base}/rest/v1/meta_access_tokens`;

const slug = (s) => String(s || '').trim().toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);

async function rest(path, init = {}) {
  const res = await fetch(`${T}${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function active(name) {
  const rows = await rest(`?select=name,expires_at&name=eq.${encodeURIComponent(name)}&revoked_at=is.null`);
  return rows.some(live);
}

async function add(rawName, note) {
  const name = slug(rawName);
  if (!name) throw new Error('a name is required, e.g. add candela');
  if (await active(name)) throw new Error(`"${name}" already has an active token. Use: rotate ${name}`);
  const expiresAt = new Date(Date.now() + TTL_DAYS * 86400_000);
  // No leading '_' after the prefix: base64url allows it, but a token that
  // reads as "cgo__..." invites a mangled copy-paste.
  let token;
  do { token = 'cgo_' + crypto.randomBytes(24).toString('base64url'); } while (token.startsWith('cgo__'));
  const weak = guard.tokenWeakness(token);
  if (weak) throw new Error(`generated token judged weak (${weak}) - this should not happen`);
  await rest('', {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify([{ name, token_hash: hash(token), note: note || null, created_by: os.userInfo().username, expires_at: expiresAt.toISOString() }]),
  });
  console.log(`\nToken for ${name}${note ? ` (${note})` : ''} - shown ONCE, not stored anywhere:\n`);
  console.log(`  ${token}\n`);
  console.log(`Valid for ${TTL_DAYS} days — expires ${expiresAt.toISOString().slice(0, 10)}.`);
  console.log('Send it to them privately. They paste it once on the consent page when connecting.');
  console.log(`To withdraw it: npm run tokens -- revoke ${name}\n`);
}

async function revoke(rawName) {
  const name = slug(rawName);
  const rows = await rest(`?name=eq.${encodeURIComponent(name)}&revoked_at=is.null`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ revoked_at: new Date().toISOString() }),
  });
  if (!rows.length) { console.log(`No active token for "${name}".`); return; }
  console.log(`Revoked ${rows.length} token${rows.length === 1 ? '' : 's'} for ${name}. Takes effect within 30 seconds.`);
}

async function list() {
  const rows = await rest('?select=name,note,created_at,created_by,last_used_at,revoked_at,expires_at&order=revoked_at.nullsfirst,created_at.asc');
  if (!rows.length) { console.log('No tokens issued yet.'); return; }
  const d = (t) => (t ? String(t).slice(0, 10) : '—');
  const w = Math.max(4, ...rows.map((r) => r.name.length));
  const days = (t) => Math.round((Date.parse(t) - Date.now()) / 86400_000);
  const state = (r) => {
    if (r.revoked_at) return 'revoked';
    if (!live(r)) return 'EXPIRED';
    const left = r.expires_at ? days(r.expires_at) : null;
    if (left === null) return 'active';
    return left <= 14 ? `${left}d LEFT` : `${left}d`;
  };
  console.log(`\n${'name'.padEnd(w)}  ${'issued'.padEnd(10)}  ${'last used'.padEnd(10)}  ${'expires'.padEnd(10)}  ${'state'.padEnd(9)}  note`);
  for (const r of rows) {
    console.log(`${r.name.padEnd(w)}  ${d(r.created_at).padEnd(10)}  ${d(r.last_used_at).padEnd(10)}  ${d(r.expires_at).padEnd(10)}  ${state(r).padEnd(9)}  ${r.note || ''}`);
  }
  const usable = rows.filter((r) => !r.revoked_at && live(r));
  const expired = rows.filter((r) => !r.revoked_at && !live(r));
  console.log(`\n${usable.length} usable, ${expired.length} expired, ${rows.filter((r) => r.revoked_at).length} revoked.`);
  const soon = usable.filter((r) => r.expires_at && days(r.expires_at) <= 14);
  if (soon.length) console.log(`\nExpiring within 14 days: ${soon.map((r) => `${r.name} (${days(r.expires_at)}d)`).join(', ')} — rotate to renew.`);
  console.log('');
}

(async () => {
  const [cmd, name, ...rest_] = process.argv.slice(2);
  const noteIdx = rest_.indexOf('--note');
  const note = noteIdx >= 0 ? rest_[noteIdx + 1] : undefined;
  try {
    if (cmd === 'add') await add(name, note);
    else if (cmd === 'revoke') await revoke(name);
    else if (cmd === 'rotate') { await revoke(name); await add(name, note); }
    else if (cmd === 'list') await list();
    else { console.log('usage: npm run tokens -- add <name> [--note "..."] | revoke <name> | rotate <name> | list'); process.exit(cmd ? 2 : 0); }
  } catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
})();
