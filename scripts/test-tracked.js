#!/usr/bin/env node
'use strict';
// Tracked links in replies and DMs [gaps §6]: codes, the Copilot call, the
// long-link fallback, the cache, initials, and the Copilot token refresh.
const T = require('../lib/tracked');
const C = require('../lib/copilot');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`          expected ${JSON.stringify(want)}\n          got      ${JSON.stringify(got)}`);
}

function fakeStore(extra = {}) {
  const db = { links: {}, saved: [], auth: null, ...extra };
  return {
    db,
    async engineTrackedLink(code) { return db.links[code] || null; },
    async engineSaveTrackedLink(row) { db.links[row.code] = row; db.saved.push(row); },
    async enginePeople() { return db.people || []; },
    async enginePosts() { return db.posts || []; },
    async engineCopilotAuth() { return db.auth; },
    async engineSaveCopilotAuth(fields, { ifRefresh } = {}) { if (ifRefresh && db.auth.refresh_token !== ifRefresh) return; db.auth = { ...db.auth, ...fields }; },
  };
}
const NOW = Date.parse('2026-11-01T12:00:00Z');
const MARIA = 'https://citizengo.org/en-gb/fr/19439-she-was-abducted-at-----uk-aid-to-pakistan-must-protect-christian-girls-like-maria-';

(async () => {
  // The code titles Copilot actually made on 21 and 27 Oct.
  eq('titles cut like Copilot cuts them', [
    T.codeTitle(T.cleanTitle('Stop the UN from turning your beliefs into a Crime Against Humanity')),
    T.codeTitle(T.cleanTitle('She was abducted at 12. UK aid to Pakistan must protect Christian girls like Maria.')),
  ], ['Stop_The_UN_From_Turning_Your_Beliefs_In', 'She_Was_Abducted_At_12_UK_Aid_To_Pakista']);

  const p = T.plan({ petition: T.petitionOf(MARIA), info: { title: 'She was abducted at 12. UK aid to Pakistan must protect Christian girls like Maria.' }, platform: 'facebook', mark: 'DM', who: 'TBS', owner: 'CJO', now: NOW });
  eq('the code: marker and initials at the front of the title; series = where it was sent', p.code, 'EN_GB-2026_11_01-DM_TBS_She_Was_Abducted_At_12_UK_Aid_To-CJO-AA_NA-LO-FR-19439-FB1');
  eq('the long link carries exactly what Copilot would', p.long,
    'https://citizengo.org/en-gb/fr/19439?campaign=EN_GB-2026_11_01-DM_TBS_She_Was_Abducted_At_12_UK_Aid_To-CJO-AA_NA-LO-FR-19439-FB1&utm_source=fb&utm_medium=social&utm_campaign=EN_GB-2026_11_01-DM_TBS_She_Was_Abducted_At_12_UK_Aid_To-CJO-AA_NA-LO-FR-19439-FB1&utm_content=link_1');
  eq('Copilot args', [p.args.campaignTitle, p.args.seriesFlow, p.args.platformCode, p.args.listCode, p.args.topicCode, p.args.petitionId], ['DM TBS She Was Abducted At 12 UK Aid To Pakistan Must', 'FB1', 'fb', 'EN_GB', 'FR', 19439]);

  // Copilot up: swapped for its short link, saved, and reused without a second call.
  const s1 = fakeStore();
  let calls = 0;
  const up = async (store, name, args) => { calls++; return { shortUrl: 'https://cgo.ac/scNEW1', fullUrl: 'https://citizengo.org/x', campaignName: T.plan({ petition: T.petitionOf(MARIA), info: {}, platform: 'instagram', mark: 'ADM', who: 'CJO', owner: 'CJO', now: NOW }).code, linkId: 7 }; };
  const o = { store: s1, platform: 'instagram', mark: 'ADM', who: 'CJO', owner: 'CJO', now: NOW, call: up };
  const r1 = await T.trackText(`Thank you! Sign here: ${MARIA}.`, o);
  const r2 = await T.trackText(`Again: ${MARIA}`, o);
  eq('Copilot up: short link in the text, saved once, reused', [r1.text, r1.links[0].via, r2.text, calls, s1.db.saved.length], ['Thank you! Sign here: https://cgo.ac/scNEW1.', 'copilot', 'Again: https://cgo.ac/scNEW1', 1, 1]);

  // Copilot down: the long link with the same code.
  const s2 = fakeStore();
  const down = async () => { throw new Error('ECONNREFUSED'); };
  const r3 = await T.trackText(`Sign: ${MARIA}`, { store: s2, platform: 'facebook', mark: 'RE', who: 'TBS', owner: 'CJO', now: NOW, call: down });
  eq('Copilot down: the long link, same code, noted', [r3.links[0].via, r3.text.includes('utm_campaign=EN_GB-2026_11_01-RE_TBS_'), s2.db.saved[0].via], ['long', true, 'long']);

  // A cgo.ac link is followed to its petition first; other links are left alone.
  const fetchImpl = async (url) => ({ status: 302, headers: { get: () => url.endsWith('scOLD') ? 'https://citizengo.org/en-gb/fm/19829?utm_campaign=x' : null } });
  const r4 = await T.trackText('Old: cgo.ac/scOLD and https://citizengo.org/en-gb/about and https://example.com', { store: fakeStore(), platform: 'facebook', mark: 'DM', who: 'CJO', owner: 'CJO', now: NOW, call: up, fetchImpl });
  eq('cgo.ac links re-tracked; non-petition links untouched', [r4.links.length, r4.text.startsWith('Old: https://cgo.ac/scNEW1 and https://citizengo.org/en-gb/about and https://example.com')], [1, true]);

  // Initials from Team and access; with none, the post's own owner.
  const posts = [{ id: 'uk-1', doc: { action: { petitionId: 19439, title: 'Maria', scope: 'IN' }, links: { facebook: { campaign: 'EN_GB-2026_10_21-Maria-RDA-AA_NA-IN-FR-19439-FB1' } } } }];
  const item = { team_id: 'uk', platform: 'facebook', kind: 'comment' };
  const got = [];
  const spy = async (store, name, args) => { got.push(args.campaignTitle + '|' + args.scopeCode); throw new Error('down'); };
  await T.trackForItem(fakeStore({ posts, people: [{ who: 'tobias', initials: 'TBS' }] }), item, MARIA, { action: 'private_reply', who: 'tobias', now: NOW, call: spy });
  await T.trackForItem(fakeStore({ posts, people: [] }), item, MARIA, { action: 'reply', who: 'sam', automated: true, now: NOW, call: spy });
  await T.trackForItem(fakeStore({ posts }), { ...item, kind: 'message' }, MARIA, { action: 'reply', who: 'sam', now: NOW, call: spy });
  eq('initials, the post owner as fallback, scope from the post; a Messenger reply is a DM', got, ['DM TBS Maria|IN', 'ARE RDA Maria|IN', 'DM RDA Maria|IN']);
  eq('text with no petition link is not touched', await T.trackForItem(fakeStore(), item, 'Thank you 🙏', { action: 'reply', who: 'x' }), { text: 'Thank you 🙏', links: [] });

  // Token refresh: saves only if nobody else refreshed first.
  const s3 = fakeStore({ auth: { client_id: 'c', access_token: 'old', refresh_token: 'r1', expires_at: new Date(Date.now() - 1000).toISOString() } });
  const tokFetch = async () => ({ ok: true, json: async () => ({ access_token: 'new', refresh_token: 'r2', expires_in: 3600 }) });
  eq('token refresh rotates and saves', [await C.accessToken(s3, { fetchImpl: tokFetch }), s3.db.auth.refresh_token], ['new', 'r2']);
  const s4 = fakeStore({ auth: null });
  eq('signed out is a clear error', await C.accessToken(s4).catch((e) => e.code), 'COPILOT_SIGNED_OUT');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
