#!/usr/bin/env node
'use strict';
// "How your MPs voted" drafts (E2, Chris 22 Nov 2026): after a division on our
// issues, a draft in Review for the UK team (and Scotland where the bill
// reaches Scotland) with the result, the count and the link, for review.
//
// The Parliamentary Monitor's division watch runs on the same Mac Mini and
// writes a small JSON beside each division brief (parl-monitor
// data/briefs/division-<c|l><id>.json). This reads the ones from the last two
// days and adds one draft per division and team, once: the post id is
// parl-vote-<c|l><id>-<team>, so a second run (the hourly stories job) skips
// what exists. No meaning is attached to the vote here: the draft gives the
// count and says how to see your MP's vote; whether it is good news is for the
// reviewer, who reads the question first.
//
//   node scripts/parl-vote-drafts.js [--dir ~/runner/parl-monitor/data/briefs] [--dry-run]

const fs = require('fs');
const os = require('os');
const path = require('path');

const DAYS = 2;
const DEFAULT_DIR = path.join(os.homedir(), 'runner', 'parl-monitor', 'data', 'briefs');

const plural = (n, one, many) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;

// One brief JSON -> [{ id, team, doc }] (pure; tested in scripts/test-parl.js).
function draftsFor(b, { teams = ['uk', 'scotland'] } = {}) {
  if (!b || !b.id || !b.title || b.ayes == null || b.noes == null || !/^https:\/\//.test(b.url || '')) return [];
  const lords = b.house === 'Lords';
  const who = lords ? 'Peers' : 'MPs';
  const ayes = Number(b.ayes), noes = Number(b.noes);
  const passed = ayes > noes;
  const subject = b.bill || String(b.title).split(':')[0].trim();
  const [yes, no] = lords ? ['Contents', 'Not contents'] : ['Ayes', 'Noes'];
  const line = `${who} voted on the ${subject}: ${ayes.toLocaleString('en-GB')} ${yes} to ${noes.toLocaleString('en-GB')} ${no}, so it ${passed ? 'passed' : 'was rejected'} by ${plural(Math.abs(ayes - noes), 'vote', 'votes')}.`;
  const ask = lords ? 'See how each peer voted' : 'See how your MP voted';
  const fb = `${line}\n\n${ask}: ${b.url}`;
  const x = [`${line} ${ask}: ${b.url}`.slice(0, 280)];
  const parties = (b.parties || []).slice(0, 4).map(([p, a, n]) => `${p} ${a}-${n}`).join(', ');
  const doc = {
    title: `How your ${who} voted: ${subject}`.slice(0, 140),
    platforms: { facebook: fb, x },
    source: { kind: 'parliament', ref: `division:${b.house === 'Lords' ? 'l' : 'c'}${b.id}`, title: b.title, url: b.url, dated: b.date || null, place: lords ? 'House of Lords' : 'House of Commons' },
    notes: [`From the Parliamentary Monitor's division watch (${b.date || 'today'}).`, parties ? `By party (${yes}-${no}): ${parties}.` : null,
      'Check what the question was before posting: an Aye can mean for or against our side.'].filter(Boolean).join(' '),
  };
  const out = [{ team: 'uk', doc }];
  if (b.scotland && teams.includes('scotland')) out.push({ team: 'scotland', doc });
  const key = `${b.house === 'Lords' ? 'l' : 'c'}${b.id}`;
  return out.filter((d) => teams.includes(d.team)).map((d) => ({ id: `parl-vote-${key}-${d.team}`, team: d.team, doc: d.doc }));
}

function recentBriefs(dir, { now = Date.now(), days = DAYS } = {}) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^division-[cl]\d+\.json$/.test(n)); } catch (e) { return []; }
  const out = [];
  for (const n of names) {
    const p = path.join(dir, n);
    try {
      if (now - fs.statSync(p).mtimeMs > days * 864e5) continue;
      out.push(JSON.parse(fs.readFileSync(p, 'utf8')));
    } catch (e) { /* a half-written file: next run */ }
  }
  return out;
}

async function run({ dir = DEFAULT_DIR, store, dryRun = false, log = console.log, now = Date.now() } = {}) {
  const E = require('../lib/engine');
  let made = 0;
  for (const b of recentBriefs(dir, { now })) {
    for (const d of draftsFor(b)) {
      if (dryRun) { log(`would draft ${d.id}: ${d.doc.title}`); continue; }
      if (await store.enginePost(d.id)) continue;
      await store.engineInsertPost({ id: d.id, team_id: d.team, status: 'review', title: d.doc.title, post_at: E.postAt(d.doc), doc: d.doc,
        created_by: 'parliamentary-monitor', updated_by: 'parliamentary-monitor' });
      await store.engineEvent({ post_id: d.id, team_id: d.team, who: 'parliamentary-monitor', action: 'create', detail: { from: 'division watch' } });
      log(`drafted ${d.id}: ${d.doc.title}`);
      made += 1;
    }
  }
  return made;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const dir = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : DEFAULT_DIR;
  const dryRun = args.includes('--dry-run');
  (async () => {
    let store = null;
    if (!dryRun) {
      require('../lib/graph').loadEnv();
      store = require('../lib/store').requireSupabaseStore();
    }
    const n = await run({ dir, store, dryRun });
    console.log(`parl-vote-drafts: ${n} draft(s) added`);
  })().catch((e) => { console.error(`parl-vote-drafts: ${e.message}`); process.exit(1); });
}

module.exports = { draftsFor, recentBriefs, run };
