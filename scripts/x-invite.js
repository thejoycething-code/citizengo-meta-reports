#!/usr/bin/env node
'use strict';
// Mint an authorisation invite for one X account.
//
//   npm run x:invite -- "CitizenGO UK" --country GB
//   npm run x:invite -- "Sebastian Lukomski" --kind spokesperson --days 14
//
// Prints a link to send to whoever holds the account. The link says which
// label and kind the account will be enrolled under, is signed, and expires
// (7 days by default). Needs X_INVITE_SECRET - the same value the Vercel
// deployment has - and X_PUBLIC_URL for the host (defaults to the production
// connector).

const { loadEnv } = require('../lib/graph');
const xauth = require('../lib/xauth');

loadEnv();

const args = process.argv.slice(2);
const label = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--kind'
  && args[args.indexOf(a) - 1] !== '--country' && args[args.indexOf(a) - 1] !== '--days');
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i !== -1 && args[i + 1] ? args[i + 1] : dflt; };

if (!label) {
  console.error('Usage: node scripts/x-invite.js "<label>" [--kind organisation|spokesperson] [--country GB] [--days 7]');
  process.exit(2);
}
const secret = process.env.X_INVITE_SECRET;
if (!secret || secret.length < 24) {
  console.error('X_INVITE_SECRET is not set (or is under 24 characters). It must match the Vercel deployment.');
  process.exit(2);
}
const kind = opt('kind', 'organisation');
if (!['organisation', 'spokesperson'].includes(kind)) { console.error('--kind must be organisation or spokesperson'); process.exit(2); }

const token = xauth.signInvite(secret, {
  label, kind, country: opt('country', null), days: Number(opt('days', 7)),
  by: process.env.X_INVITE_BY || process.env.USER || null,
});
const base = (process.env.X_PUBLIC_URL || 'https://meta-organic-reporting.vercel.app').replace(/\/+$/, '');
console.log(`\nInvite for "${label}" (${kind}${opt('country') ? ', ' + opt('country') : ''}), valid ${opt('days', 7)} day(s):\n`);
console.log(`  ${base}/api/x/authorize?t=${token}\n`);
console.log('Send it to the person who holds the X account. They must be signed into THAT account when they click Continue.');
