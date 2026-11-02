#!/usr/bin/env node
'use strict';
// Link in bio [2 Nov 2026]: loads each petition's Bluebook total and its
// Asana campaign state into petition_status (lib/bio.js reads it).
//
//   node scripts/load-petition-status.js <totals.jsonl> [<asana.jsonl>] [--dry-run]
//
// Both inputs are Claude Code stream-json transcripts from the nightly pull
// on the Mini (scripts/link-signatures-mini.sh):
//  - totals.jsonl: two Looker queries on the Bluebook
//    (petitions_signatures_3_0), signatures per petition id: all time, then
//    the last 14 days. The petition id field is found by its name.
//  - asana.jsonl: Claude's final reply, a JSON array of the campaign
//    projects ({name, completed, archived, evaluated, status_updated}),
//    read-only through the Asana connector. A project is named
//    "EN_GB - <petition title> - MM/YYYY"; it is matched to the petitions our
//    posts linked to by its list and the words of the title.
//
// Rows are upserted; a petition missing from a pull keeps its last values.
// A pull that fails (no rows, unreadable) changes nothing.

const fs = require('fs');
const { parseRows } = require('./load-link-signatures');

// Each query's rows, in the order Claude made them.
function queriesFromStream(text, { tool = /Looker__query$/, readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const ids = [], results = {};
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
    const content = ev && ev.message && Array.isArray(ev.message.content) ? ev.message.content : [];
    for (const c of content) {
      if (c.type === 'tool_use' && tool.test(c.name || '')) ids.push(c.id);
      if (c.type === 'tool_result' && ids.includes(c.tool_use_id)) {
        let body = Array.isArray(c.content) ? c.content.map((x) => x.text || '').join('') : String(c.content || '');
        const saved = body.match(/saved to:?\s*(\/\S+?\.(?:txt|json))/i);
        if (saved) body = readFile(saved[1]);
        try { results[c.tool_use_id] = parseRows(body); } catch (e) { results[c.tool_use_id] = null; }
      }
    }
  }
  return ids.map((id) => results[id]).filter((r) => Array.isArray(r));
}

// Claude's last text reply in a transcript.
function finalText(text) {
  let out = '';
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
    if (ev.type === 'result' && typeof ev.result === 'string') out = ev.result;
    else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      const t = ev.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
      if (t.trim()) out = t;
    }
  }
  return out;
}

const keyLike = (row, re) => Object.keys(row || {}).find((k) => re.test(k));

// {petition_id: {total, last14}} from the two Bluebook queries.
function totalsFrom(queries) {
  const [all, recent] = queries;
  if (!all || !all.length) return {};
  const pk = keyLike(all[0], /petition[^.]*_?id$|petition\.id$/i), sk = keyLike(all[0], /sum_signatures$|signatures$/i);
  if (!pk || !sk) throw new Error(`can't find the petition id and signatures fields in ${Object.keys(all[0]).join(', ')}`);
  const out = {};
  for (const r of all) { const id = String(r[pk] || '').replace(/\D/g, ''); if (id) out[id] = { total: Number(r[sk]) || 0, last14: recent ? 0 : null }; }
  if (recent && recent.length) {
    const pk2 = keyLike(recent[0], /petition[^.]*_?id$|petition\.id$/i), sk2 = keyLike(recent[0], /sum_signatures$|signatures$/i);
    for (const r of recent) { const id = String(r[pk2] || '').replace(/\D/g, ''); if (id) out[id] = { ...(out[id] || { total: null }), last14: Number(r[sk2]) || 0 }; }
  }
  return out;
}

// The projects from Claude's reply (the first JSON array in it).
function projectsFrom(text) {
  const m = String(text || '').match(/\[[\s\S]*\]/);
  if (!m) return [];
  try { const v = JSON.parse(m[0]); return Array.isArray(v) ? v.filter((p) => p && typeof p.name === 'string') : []; } catch (e) { return []; }
}

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'for', 'and', 'in', 'on', 'at', 'by', 'with', 'your', 'our', 'is', 'be', 'not']);
const words = (s) => new Set(String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)));

// "EN_GB - Stop the banning of church outreach in Colchester - 04/2026" → { list: 'en_gb', title }
function parseProject(name) {
  const m = String(name || '').match(/^\s*([A-Za-z]{2}_[A-Za-z]{2})\s+-\s+(.+?)(?:\s+-\s+\d{1,2}\/\d{4})?\s*$/);
  return m ? { list: m[1].toLowerCase(), title: m[2] } : null;
}

// petitions: [{petition_id, list ('en_gb'), title}] → {petition_id: project}
// A project matches when most of its title's words are in the petition's.
function matchProjects(projects, petitions) {
  const out = {};
  for (const p of projects) {
    const pp = parseProject(p.name);
    if (!pp) continue;
    const pw = words(pp.title);
    if (pw.size < 2) continue;
    let best = null, bestScore = 0;
    for (const pet of petitions) {
      if (pet.list && pet.list !== pp.list) continue;
      const tw = words(pet.title);
      let hit = 0; for (const w of pw) if (tw.has(w)) hit++;
      const score = hit / Math.max(pw.size, Math.min(tw.size, pw.size + 2));
      if (score > bestScore) { bestScore = score; best = pet; }
    }
    if (best && bestScore >= 0.7) {
      const prev = out[best.petition_id];
      // Several projects for one petition (a relaunch): the open one wins.
      const closed = !!(p.completed || p.archived || p.evaluated);
      if (!prev || (prev.closed && !closed)) out[best.petition_id] = { name: p.name, closed, victory: !!p.status_updated };
    }
  }
  return out;
}

// The petitions our posts linked to: id, list and title (from the link's words).
function petitionsFrom(rows) {
  const B = require('../lib/bio');
  const out = new Map();
  for (const r of rows || []) {
    const url = r.full_url || r.url, id = String(r.petition_id || '');
    if (!id || out.has(id)) continue;
    const m = String(url || '').match(/citizengo\.org\/([a-z]{2})-([a-z]{2})\//i);
    const title = B.titleFromUrl(url);
    if (title) out.set(id, { petition_id: id, list: m ? `${m[1]}_${m[2]}`.toLowerCase() : null, title });
  }
  return [...out.values()];
}

async function main() {
  const { loadEnv } = require('../lib/graph');
  loadEnv();
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const dry = process.argv.includes('--dry-run');
  if (!args[0]) { console.error('Usage: node scripts/load-petition-status.js <totals.jsonl> [<asana.jsonl>] [--dry-run]'); process.exit(2); }
  const base = process.env.SUPABASE_URL.trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  const H = { apikey: key, Authorization: 'Bearer ' + key };
  const now = new Date().toISOString();
  const rows = {};
  try {
    const totals = totalsFrom(queriesFromStream(fs.readFileSync(args[0], 'utf8')));
    for (const [id, t] of Object.entries(totals)) rows[id] = { petition_id: id, total: t.total, last14: t.last14, bb_pulled_at: now };
    console.log(`${now} Bluebook: ${Object.keys(totals).length} petitions`);
  } catch (e) { console.log(`${now} Bluebook totals skipped: ${e.message}`); }
  if (args[1] && fs.existsSync(args[1])) {
    const projects = projectsFrom(finalText(fs.readFileSync(args[1], 'utf8')));
    if (projects.length) {
      const since = new Date(Date.now() - 180 * 864e5).toISOString();
      const r = await fetch(`${base}/rest/v1/link_posts?select=petition_id,url,full_url,posted_at&petition_id=not.is.null&posted_at=gte.${encodeURIComponent(since)}&order=posted_at.desc&limit=5000`, { headers: H });
      if (!r.ok) throw new Error(`reading link_posts failed: HTTP ${r.status}`);
      const matched = matchProjects(projects, petitionsFrom(await r.json()));
      for (const [id, m] of Object.entries(matched)) rows[id] = { ...(rows[id] || { petition_id: id }), asana_project: m.name.slice(0, 200), asana_closed: m.closed, asana_victory: m.victory, asana_checked_at: now };
      console.log(`${now} Asana: ${projects.length} campaign projects, ${Object.keys(matched).length} matched to petitions`);
    } else console.log(`${now} Asana skipped: no project list in the reply (is the Asana connector on?)`);
  }
  const list = Object.values(rows);
  if (!list.length) { console.log('nothing to load; existing rows kept'); return; }
  if (dry) { console.log(JSON.stringify(list.slice(0, 5), null, 2)); return; }
  // Rows carry different columns (totals only, Asana only, both): one
  // request per shape, so PostgREST doesn't null the missing ones.
  const shapes = {};
  for (const r of list) (shapes[Object.keys(r).sort().join(',')] = shapes[Object.keys(r).sort().join(',')] || []).push(r);
  for (const batch of Object.values(shapes)) {
    for (let i = 0; i < batch.length; i += 500) {
      const r = await fetch(`${base}/rest/v1/petition_status?on_conflict=petition_id`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(batch.slice(i, i + 500)) });
      if (!r.ok) throw new Error(`writing petition_status failed: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    }
  }
  console.log(`loaded ${list.length} petitions`);
}

module.exports = { queriesFromStream, finalText, totalsFrom, projectsFrom, parseProject, matchProjects, petitionsFrom };
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
