#!/usr/bin/env node
'use strict';
// Turn a short-lived Meta user token into a long-lived one (~60 days).
//
//   node scripts/exchange-token.js [outfile]
//
// WHY THIS EXISTS. The app login flow and the Graph API Explorer both hand you
// a SHORT-LIVED user token, valid for a couple of hours. Pasted straight into
// META_TOKENS it works when you test it and dies overnight, and the symptom in
// the logs is `Session has expired` - which reads like a Meta outage rather
// than the wrong kind of token. The exchange below is the missing step.
//
// A personal user token reaches every Page the PERSON has a role on, across all
// portfolios, which is why one of Ignacio's covers all 36 while a System User
// only ever sees its own portfolio's assets. The trade is expiry: a user token
// caps at ~60 days and a System User token can be set to never expire.
//
// Nothing is echoed and nothing is passed on the command line, so no secret
// reaches your shell history. The token is written to a 0600 file for
// `gh secret set` to read, and never printed.

const fs = require('fs');
const readline = require('readline');

const OUT = process.argv[2] || '/tmp/meta-tokens.txt';
const VERSION = process.env.GRAPH_VERSION || 'v23.0';

// Reads one line WITHOUT ever echoing it. The first version let readline echo
// each keystroke and then painted asterisks over the line - so a paste showed
// in clear text first, and stayed in the terminal's scrollback (found 5 Oct
// 2026, when an App ID appeared in full). Raw mode means nothing is echoed at
// all; we print one asterisk per character ourselves.
function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      // Piped input: no terminal to echo to, so plain readline is safe.
      const rl = readline.createInterface({ input: stdin });
      rl.once('line', (l) => { rl.close(); resolve(l.trim()); });
      return;
    }
    // Mute first, prompt second: anything typed the instant the prompt shows
    // must already be unechoed.
    stdin.setRawMode(true);
    let value = '';
    process.stdout.write(prompt);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = () => { stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData); };
    function onData(raw) {
      // A paste arrives wrapped in ESC[200~ ... ESC[201~ (bracketed paste), and
      // arrow keys as ESC[A etc. Strip whole sequences: dropping only the ESC
      // byte would leave "[200~" inside the secret.
      const chunk = String(raw).replace(/\x1b\[[0-9;]*[A-Za-z~]/g, '');
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') { done(); process.stdout.write('\n'); resolve(value.trim()); return; }
        if (ch === '\u0003') { done(); process.stdout.write('\n'); reject(new Error('cancelled')); return; }
        if (ch === '\u007f' || ch === '\b') {
          if (value.length) { value = value.slice(0, -1); process.stdout.write('\b \b'); }
          continue;
        }
        if (ch < ' ') continue;   // other control characters, incl. bracketed-paste markers
        value += ch;
        process.stdout.write('*');
      }
    }
    stdin.on('data', onData);
  });
}

async function main() {
  console.log('Exchanging a short-lived Meta user token for a long-lived one.\n');
  console.log('App ID and secret: developers.facebook.com/apps → Settings → Basic');
  console.log('Short-lived token: the one the login flow or Graph API Explorer just gave you\n');

  const appId = await askHidden('App ID:            ');
  const secret = await askHidden('App secret:        ');
  const short = await askHidden('Short-lived token: ');

  if (!appId || !secret || !short) { console.error('\nAll three are required.'); process.exit(2); }

  const url = new URL(`https://graph.facebook.com/${VERSION}/oauth/access_token`);
  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', appId);
  url.searchParams.set('client_secret', secret);
  url.searchParams.set('fb_exchange_token', short);

  const res = await fetch(url);
  const body = await res.json();

  if (!res.ok || body.error) {
    // Meta's message is the useful part; the token never appears in it.
    console.error(`\nExchange failed: ${(body.error && body.error.message) || `HTTP ${res.status}`}`);
    if (body.error && body.error.code === 190) {
      console.error('Code 190 usually means the short-lived token has already expired — get a fresh one and retry.');
    }
    process.exit(1);
  }

  const days = body.expires_in ? Math.round(body.expires_in / 86400) : null;
  const token = body.access_token;
  fs.writeFileSync(OUT, token + '\n', { mode: 0o600 });

  console.log(`\nExchanged. Written to ${OUT} (mode 600).`);
  console.log(days ? `Expires in ~${days} days.` : 'No expiry reported — check it in the token debugger.');

  // WHAT THIS TOKEN ACTUALLY REACHES, before it goes anywhere near the secret.
  //
  // Two tokens in a row came back holding the right SCOPES and reaching one
  // page, because the Business Login consent screen asks which assets to grant
  // and defaults to a subset. Scopes granted and assets granted are different
  // questions, and only the second one decides whether collection covers 36
  // pages or 1. Both cost a round trip through CI to discover. Not any more.
  const get = async (path, params = {}) => {
    const u = new URL(`https://graph.facebook.com/${VERSION}${path}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set('access_token', token);
    const r = await fetch(u);
    return { ok: r.ok, body: await r.json() };
  };
  // Pages paginate at 25 by default; follow the cursors or you will report 25.
  const countAll = async (path) => {
    let url = null; let total = 0; let guard = 0;
    let res = await get(path, { fields: 'id', limit: 100 });
    for (;;) {
      if (!res.ok) return null;
      total += ((res.body && res.body.data) || []).length;
      url = res.body && res.body.paging && res.body.paging.next;
      if (!url || ++guard > 20) break;
      const r = await fetch(url);
      res = { ok: r.ok, body: await r.json() };
    }
    return total;
  };

  console.log('\nWhat this token reaches:');
  const me = await get('/me', { fields: 'id,name' });
  console.log(`  identity     ${me.ok ? `${me.body.name} (${me.body.id})` : 'could not read /me'}`);

  const perms = await get('/me/permissions');
  if (perms.ok) {
    const granted = (perms.body.data || []).filter((r) => r.status === 'granted').map((r) => r.permission);
    for (const need of ['ads_read', 'leads_retrieval', 'pages_show_list', 'read_insights',
      'instagram_basic', 'instagram_manage_insights', 'pages_read_engagement', 'pages_read_user_content']) {
      console.log(`  ${granted.includes(need) ? 'yes ' : 'NO  '} ${need}`);
    }
    const write = granted.filter((g) => /_manage_(comments|messages)|content_publish|ads_management|business_management/.test(g));
    if (write.length) console.log(`  !    write-capable scopes present: ${write.join(', ')}`);
  }

  const pages = await countAll('/me/accounts');
  const accounts = await countAll('/me/adaccounts');
  console.log(`  pages        ${pages === null ? 'refused' : pages}`);
  console.log(`  ad accounts  ${accounts === null ? 'refused (needs ads_read)' : accounts}`);

  // /me/accounts is NOT the whole reach. Ignacio's token lists 14 pages here and
  // has done for every token since September; the collector then recovers the
  // other 22 by asking for each previously collected page directly (they sit in
  // Business Portfolios, which /me/accounts does not enumerate). This used to
  // print "well short of the 36 - re-run the Explorer step", which sent a
  // perfectly good token back round the consent screen on 5 Oct 2026. The real
  // floor is the 14 that /me/accounts has always returned; below that, Pages
  // genuinely were left unticked.
  const LISTED_BEFORE = 14;
  if (pages !== null && pages < LISTED_BEFORE) {
    console.log(`\n  *** ${pages} pages listed, fewer than the ${LISTED_BEFORE} every previous token listed. The`);
    console.log('      consent screen grants Pages separately from permissions - re-run the');
    console.log('      Explorer step and tick every Page, or collection will drop the rest. ***');
  } else if (pages !== null) {
    console.log(`\n  ${pages} pages listed directly. That is normal: the collector reaches the rest`);
    console.log('  (36 in all) through the portfolios, and its log says "36 page(s) reachable".');
  }

  console.log('\nAdd any other tokens as further lines, then:');
  console.log(`  gh secret set META_TOKENS --repo thejoycething-code/citizengo-meta-reports < ${OUT}`);
  console.log(`  rm -P ${OUT}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
