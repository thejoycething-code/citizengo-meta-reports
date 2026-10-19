#!/usr/bin/env node
'use strict';
// inviter_report_usage and page_inviter_usage against an in-memory store.
// No database or network needed.
const { callTool } = require('../mcp/tools');

let pass = 0; let fail = 0;
const check = (name, ok, detail) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };

const table = new Map();
const store = {
  async upsertInviterUsage(rows) { for (const r of rows) table.set([r.day, r.user_email, r.device_id, r.page_id].join('|'), r); return rows.length; },
  async inviterUsage({ since }) { return [...table.values()].filter((r) => r.day >= since); },
};
const ext = { who: 'invite-to-like-extension' };
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);

(async () => {
  console.log('1. The extension reports');
  let r = await callTool(store, 'inviter_report_usage', { user_email: 'Ana@CitizenGO.net', device_id: 'abcd-1234-efgh', extension_version: '1.4', days: [
    { day: today, page_id: '154268578340', page_name: 'HazteOir.org', invites: 120 },
    { day: yesterday, page_id: '154268578340', page_name: 'HazteOir.org', invites: 300 },
    { day: today, page_id: 'profile:100064551261576', invites: 5 },
  ] }, ext);
  check('saves its rows', !r.isError && JSON.parse(r.text).saved === 3, r.text);
  check('email is lower-cased', [...table.values()].every((x) => x.user_email === 'ana@citizengo.net'));
  r = await callTool(store, 'inviter_report_usage', { user_email: 'ana@citizengo.net', device_id: 'abcd-1234-efgh', days: [{ day: today, page_id: '154268578340', invites: 150 }] }, ext);
  check('a later report replaces the day\'s total rather than adding', [...table.values()].find((x) => x.day === today && x.page_id === '154268578340').invites === 150);
  r = await callTool(store, 'inviter_report_usage', { user_email: 'ana@citizengo.net', device_id: 'other-mac-9999', days: [{ day: today, page_id: '154268578340', invites: 50 }] }, ext);
  check('a second computer is kept separately', table.size === 4);
  r = await callTool(store, 'inviter_report_usage', { user_email: 'ana@citizengo.net', device_id: 'abcd-1234-efgh', days: [
    { day: '2001-01-01', page_id: '154268578340', invites: 1 }, { day: today, page_id: 'abc', invites: 1 }, { day: today, page_id: '154268578340', invites: -3 },
  ] }, ext);
  check('old days, bad Page IDs and negative counts are skipped', JSON.parse(r.text).saved === 0 && JSON.parse(r.text).skipped === 3, r.text);
  r = await callTool(store, 'inviter_report_usage', { user_email: 'not an email', device_id: 'abcd-1234-efgh', days: [] }, ext);
  check('a bad email is refused', r.isError);
  r = await callTool(store, 'inviter_report_usage', { user_email: 'a@b.co', device_id: 'x', days: [] }, ext);
  check('a bad device ID is refused', r.isError);
  r = await callTool(store, 'inviter_report_usage', { user_email: 'a@b.co', device_id: 'abcd-1234-efgh', days: new Array(501).fill({}) }, ext);
  check('more than 500 rows is refused', r.isError);

  console.log('\n2. Reading usage');
  let refused = null;
  try { await callTool(store, 'page_inviter_usage', {}, ext); } catch (e) { refused = e; }
  check('the extension\'s own token cannot read usage', !!refused);
  r = await callTool(store, 'page_inviter_usage', { days: 7 }, { who: 'chris' });
  check('the maintainer sees totals per person', /ana@citizengo\.net \| 505 \| 2 \| 2 \|/.test(r.text), r.text.split('\n')[0]);
  check('and per Page, by name', /\| HazteOir\.org \| 500 \| 1 \|/.test(r.text));
  r = await callTool(store, 'page_inviter_usage', { user: 'nobody' }, { who: 'chris' });
  check('a filter with no match says so', /No Page Inviter usage/.test(r.text));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
