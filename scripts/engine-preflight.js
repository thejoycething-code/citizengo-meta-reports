#!/usr/bin/env node
'use strict';
// Content Engine go-live preflight: reads the engine, the connect page and (on
// the Mini) the job settings, then says what is ready and what isn't. Changes
// nothing, and never prints a token or key. Rules in lib/preflight.js.
//
//   node scripts/engine-preflight.js     # needs SUPABASE_URL and SUPABASE_SERVICE_KEY

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadEnv } = require('../lib/graph');
const { supabaseStore } = require('../lib/store');
const F = require('../lib/preflight');

const ORIGIN = process.env.PUBLIC_ORIGIN || 'https://meta-organic-reporting.vercel.app';

(async () => {
  loadEnv();
  const store = supabaseStore({ url: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_KEY });
  const connectStatus = await fetch(`${ORIGIN}/api/fb/authorize`, { redirect: 'manual' }).then((r) => r.status).catch(() => 0);
  const teams = await store.engineTeams();
  const ids = teams.map((t) => t.id);
  const [rights, tokens, scheduled, pauses, automations, queued] = await Promise.all([
    store.engineAllRights(), store.engineConnectedTokens(), store.enginePosts({ statuses: ['scheduled'], limit: 500 }),
    store.enginePauses(), store.engineAutomations({ team_ids: ids }), store.engineInboxActions({ team_ids: ids, statuses: ['queued'], limit: 1000 }),
  ]);
  // On the Mini: the job settings decide dry run or live.
  const agents = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const plist = (n) => { try { return fs.readFileSync(path.join(agents, `net.citizengo.${n}.plist`), 'utf8'); } catch (e) { return null; } };
  const plists = { publisher: plist('content-publisher'), inbox: plist('content-inbox-actions') };
  const onMini = !!(plists.publisher || plists.inbox);
  const env = onMini ? { ENGINE_PUBLISH_LIVE: process.env.ENGINE_PUBLISH_LIVE, ENGINE_INBOX_LIVE: process.env.ENGINE_INBOX_LIVE, ENGINE_TOKEN_PRIVATE_KEY: !!process.env.ENGINE_TOKEN_PRIVATE_KEY } : null;
  console.log(F.render(F.check({ connectStatus, teams, rights, tokens: tokens.map((t) => ({ who: t.who, account_key: t.account_key })), scheduled, pauses, automations, queued, env, plists })));
  if (!onMini) console.log('\n(Run on the Mini to also check the publisher and Inbox sender modes.)');
})().catch((e) => { console.error(e.message); process.exit(1); });
