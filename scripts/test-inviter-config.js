#!/usr/bin/env node
'use strict';
// inviter_config and update_inviter_config, against an in-memory store, plus
// the Page Inviter extension's origin. No database or network needed.
//
// The write tool is the only write on the MCP request path, so the refusals
// are tested as carefully as the successes: who may write, what may be written,
// and that a refused or previewed change leaves the table untouched.

const path = require('path');
const fs = require('fs');
const { callTool, TOOLS } = require('../mcp/tools');
const { problems } = require('../mcp/inviter-tools');
const { originAllowed } = require('../lib/origin');

let pass = 0; let fail = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

// The seed the extension ships with, so the validator is proven against the
// real thing rather than a fixture that could drift from it.
function seedConfig() {
  const file = path.join(__dirname, '..', '..', 'citizengo-page-inviter', 'config.default.js');
  if (fs.existsSync(file)) {
    const vm = require('vm');
    const ctx = vm.createContext({});
    vm.runInContext(fs.readFileSync(file, 'utf8') + '\nthis.D = CGO_DEFAULT_CONFIG;', ctx);
    return JSON.parse(JSON.stringify(ctx.D));
  }
  return {
    configVersion: 1, minExtensionVersion: '2.3.0', killSwitch: false, notice: '',
    inviteWords: ['invite'], closeWords: ['close'], supportedLangs: ['en'],
    limitPatterns: ['try again later'], pageLimitPatterns: ['no more invitations to like this page'],
    reactSummaryPatterns: ['see who reacted'],
    postLinkPattern: '/(posts|reel)\\b',
    reactions: { 1635855486666999: 'rLike' },
    selectors: {
      row: 'div', toolbar: '[role="toolbar"]', tab: '[role="tab"]', dialog: '[role="dialog"]',
      alerts: '[role="dialog"]', limitLink: 'a', reactionIcon: '/reaction/image/(\\d+)', pageIdInHtml: '"delegate_page_id":"(\\d+)"',
    },
    newRowsMargin: 10,
    routes: {
      feed_grid: { url: 'https://business.facebook.com/latest/posts/feed_and_grid?asset_id={pageId}', match: 'feed_and_grid' },
      prodash: { url: 'https://www.facebook.com/professional_dashboard/content/content_library/', match: 'content_library' },
      notifications: { url: 'https://www.facebook.com/notifications', match: 'notifications' },
    },
  };
}

function memoryStore(initial) {
  const rows = [{ id: 1, config: initial, note: 'seed', updated_at: '2026-10-06T08:00:00Z' }];
  let inserts = 0;
  return {
    rows,
    get inserts() { return inserts; },
    // Stale on purpose: proves the banner never reaches the extension's JSON.
    async freshness() { return { latest: '2026-09-01', recentFailures: 0 }; },
    async inviterConfigs(limit = 1) { return rows.slice().sort((a, b) => b.id - a.id).slice(0, limit); },
    async inviterConfigById(id) { return rows.find((r) => r.id === Number(id)) || null; },
    async insertInviterConfig({ config, note }) {
      inserts++;
      const row = { id: rows.length + 1, config, note, updated_at: new Date().toISOString() };
      rows.push(row);
      return row;
    },
  };
}

async function main() {
  const seed = seedConfig();

  console.log('\n1. The seed config');
  check('the extension\'s built-in config passes validation', problems(seed).length === 0, problems(seed).join(' '));
  check('both tools are registered', ['inviter_config', 'update_inviter_config'].every((n) => TOOLS.some((t) => t.name === n)));

  console.log('\n2. Reading (inviter_config)');
  const store = memoryStore(seed);
  const r = await callTool(store, 'inviter_config', {}, { who: 'campaigner' });
  let parsed = null; try { parsed = JSON.parse(r.text); } catch (e) { /* checked below */ }
  check('the text is bare JSON the extension can parse, even when data is stale', parsed && parsed.configVersion === seed.configVersion);
  check('the config is also returned as structured content', r.structured && r.structured.config && r.structured.row === 1);
  const h = await callTool(store, 'inviter_config', { history: true }, { who: 'campaigner' });
  check('history lists versions with their notes', /\| 1 \(live\) \|/.test(h.text) && /seed/.test(h.text));

  console.log('\n3. Who may write');
  delete process.env.INVITER_CONFIG_ADMINS;
  let u = await callTool(store, 'update_inviter_config', { note: 'x', set: { notice: 'hi' } }, { who: 'Chris' });
  check('nobody may write while INVITER_CONFIG_ADMINS is unset', u.isError && store.inserts === 0, u.text);
  process.env.INVITER_CONFIG_ADMINS = 'Chris, cjoyce@citizengo.net';
  u = await callTool(store, 'update_inviter_config', { note: 'x', set: { notice: 'hi' } }, { who: 'invite-to-like-extension' });
  check('the extension\'s own token cannot write', u.isError && store.inserts === 0);
  u = await callTool(store, 'update_inviter_config', { note: 'x', set: { notice: 'hi' } }, {});
  check('an unnamed caller cannot write', u.isError && store.inserts === 0);

  console.log('\n4. What may be written');
  u = await callTool(store, 'update_inviter_config', { set: { notice: 'hi' } }, { who: 'chris' });
  check('a note is required', u.isError && store.inserts === 0);
  u = await callTool(store, 'update_inviter_config', { note: 'x', set: { limitPatterns: ['(unclosed'] } }, { who: 'chris' });
  check('a pattern that does not compile is refused', u.isError && /not a valid pattern/.test(u.text) && store.inserts === 0);
  u = await callTool(store, 'update_inviter_config', { note: 'x', set: { bogus: 1 } }, { who: 'chris' });
  check('an unknown setting is refused', u.isError && store.inserts === 0);
  u = await callTool(store, 'update_inviter_config', { note: 'x', set: { routes: { feed_grid: { url: 'https://evil.example/{pageId}' } } } }, { who: 'chris' });
  check('a route off facebook.com is refused', u.isError && /facebook\.com/.test(u.text) && store.inserts === 0);
  u = await callTool(store, 'update_inviter_config', { note: 'x', set: { selectors: { reactionIcon: '/reaction/image/' } } }, { who: 'chris' });
  check('a selector pattern without its capture group is refused', u.isError && store.inserts === 0);
  u = await callTool(store, 'update_inviter_config', { note: 'x', set: { killSwitch: 'yes' } }, { who: 'chris' });
  check('a wrongly-typed switch is refused', u.isError && store.inserts === 0);
  u = await callTool(store, 'update_inviter_config', { note: 'x', set: { configVersion: 99 } }, { who: 'chris' });
  check('configVersion cannot be set by hand', u.isError && store.inserts === 0);

  console.log('\n5. Changes that are allowed');
  u = await callTool(store, 'update_inviter_config', { note: 'Polish button renamed', add: { inviteWords: ['Zaproś do polubienia'] }, dry_run: true }, { who: 'Chris' });
  check('a dry run previews without saving', !u.isError && /Preview/.test(u.text) && store.inserts === 0, u.text.split('\n')[0]);
  u = await callTool(store, 'update_inviter_config', { note: 'Polish button renamed', add: { inviteWords: ['Zaproś do polubienia', 'INVITE'] } }, { who: 'Chris' });
  const live = (await store.inviterConfigs(1))[0];
  check('adding a word saves a new version', !u.isError && store.inserts === 1 && live.config.inviteWords.includes('Zaproś do polubienia'), u.text.split('\n')[0]);
  check('a word already present (any case) is not duplicated', live.config.inviteWords.filter((w) => w.toLowerCase() === 'invite').length === 1);
  check('configVersion goes up by one', live.config.configVersion === seed.configVersion + 1);
  check('the note records who made the change', /— Chris$/.test(live.note), live.note);
  check('earlier versions are kept', store.rows.length === 2 && store.rows[0].config.inviteWords.length === seed.inviteWords.length);
  u = await callTool(store, 'update_inviter_config', { note: 'Pause', set: { killSwitch: true, notice: 'Facebook is limiting invites this week' } }, { who: 'cjoyce@citizengo.net' });
  check('a Google sign-in on the list can pause everyone', !u.isError && (await store.inviterConfigs(1))[0].config.killSwitch === true);
  u = await callTool(store, 'update_inviter_config', { note: 'again', set: { killSwitch: true } }, { who: 'chris' });
  check('a change that changes nothing is not saved', !u.isError && store.inserts === 2);
  u = await callTool(store, 'update_inviter_config', { note: 'Undo', revert_to: 1 }, { who: 'chris' });
  const reverted = (await store.inviterConfigs(1))[0].config;
  check('revert_to brings back an earlier version as a new row', !u.isError && reverted.killSwitch === false && reverted.configVersion === seed.configVersion + 3 && store.inserts === 3);

  console.log('\n6. The extension\'s origin');
  check('the Page Inviter extension is allowed', originAllowed('chrome-extension://gndfogfkkcpphoddibbooeoclgkgmcef', { headers: {} }));
  check('any other extension is refused', !originAllowed('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', { headers: {} }));
  check('a lookalike with a path is refused', !originAllowed('chrome-extension://gndfogfkkcpphoddibbooeoclgkgmcef/x', { headers: {} }));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
