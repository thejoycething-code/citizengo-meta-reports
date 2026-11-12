'use strict';
// Listening › Parliament [Phase 3, chosen 2 Nov 2026]: what UK parliaments
// did on our issues, read-only from the Parliamentary Monitor. The monitor's
// own MCP server (thejoycething-code/parl-monitor, mcp_server/) answers
// query_sql with its own per-person bearer token; the desk holds one issued
// for it in PARL_MCP_URL and PARL_MCP_TOKEN (Vercel env, never logged). Only
// triaged items (score 2 or 3: worth a line or worth acting on) are read.

// The monitor's issue areas (parl-monitor src/digest.py AREA_NAMES).
const AREA_NAMES = {
  1: 'Abortion', 2: 'Assisted dying', 3: 'Gender medicine (children)', 4: 'Conversion practices', 5: 'Sex-based rights',
  6: 'Parental rights and education', 7: 'Free speech and online safety', 8: 'Freedom of religion', 9: 'Marriage and family',
  10: 'Surrogacy and embryology', 11: 'Migration', 12: 'Prostitution, trafficking and sexual exploitation', 13: 'Organ donation and transplant ethics',
};
// Which parliaments each team sees. Others: not covered yet.
const TEAM_PARLIAMENTS = { uk: ['westminster', 'holyrood'], scotland: ['holyrood', 'westminster'] };
const MIN_SCORE = 2;

const day = (d) => new Date(d).toISOString().slice(0, 10);
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

// One read-only query per parliament; dates are text (YYYY-MM-DD) there.
function feedSql(parliament, { since }) {
  if (parliament === 'westminster') {
    return `select id, title, url, item_type as kind, event_date as dated, issue_areas as areas, triage_score as score, why_it_matters as why, deadline from items where event_date >= ${lit(since)} and triage_score >= ${MIN_SCORE} order by event_date desc, triage_score desc limit 150`;
  }
  if (parliament === 'holyrood') {
    return `select id, title, null as url, kind, dated::text as dated, areas, triage_score as score, why_it_matters as why, null as deadline from sp_items where dated::text >= ${lit(since)} and triage_score >= ${MIN_SCORE} order by dated desc, triage_score desc limit 150`;
  }
  throw new Error(`Unknown parliament ${parliament}`);
}

const PLACE = { westminster: 'Westminster', holyrood: 'Scottish Parliament' };
function areasOf(v) {
  let a = v;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch (e) { a = []; } }
  return (Array.isArray(a) ? a : []).map(Number).filter((n) => AREA_NAMES[n]).map((n) => ({ n, name: AREA_NAMES[n] }));
}
const KIND = { statement: 'Ministerial statement', question: 'Written question', wq: 'Written question', motion: 'Motion', edm: 'Early day motion', bill: 'Bill', debate: 'Debate', committee: 'Committee', division: 'Vote', consultation: 'Consultation', petition: 'Petition', answer: 'Answer', event: 'In the diary' };
function shape(parliament, rows) {
  return (rows || []).map((r) => ({
    id: String(r.id), parliament, place: PLACE[parliament], title: String(r.title || '').slice(0, 300),
    kind: KIND[String(r.kind || '').toLowerCase()] || (r.kind ? String(r.kind).replace(/_/g, ' ') : null),
    url: /^https:\/\//.test(r.url || '') ? r.url : null, dated: r.dated ? String(r.dated).slice(0, 10) : null,
    areas: areasOf(r.areas), score: r.score == null ? null : Number(r.score), why: r.why ? String(r.why).slice(0, 600) : null,
    deadline: r.deadline ? String(r.deadline).slice(0, 10) : null,
  }));
}

// One query through the monitor's MCP endpoint (stateless JSON-RPC).
async function query(sql, { url = process.env.PARL_MCP_URL, token = process.env.PARL_MCP_TOKEN, fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  if (!url || !token) { const e = new Error('The Parliamentary Monitor link is not set up yet.'); e.code = 'PARL_NOT_CONFIGURED'; throw e; }
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'query_sql', arguments: { sql, max_rows: 200 } } }),
    });
    if (!r.ok) { const e = new Error(`The Parliamentary Monitor answered HTTP ${r.status}.`); e.code = 'PARL_FAILED'; throw e; }
    const j = await r.json();
    const res = j && j.result;
    const text = res && res.content && res.content[0] && res.content[0].text;
    if (!res || res.isError || !text) { const e = new Error(`The Parliamentary Monitor couldn't run the query${text ? `: ${String(text).slice(0, 200)}` : ''}.`); e.code = 'PARL_FAILED'; throw e; }
    const out = res.structuredContent && res.structuredContent.rows ? res.structuredContent : JSON.parse(text);
    return out.rows || [];
  } finally { clearTimeout(t); }
}

async function feed(team, { days = 21, now = Date.now(), ...opts } = {}) {
  const parls = TEAM_PARLIAMENTS[team] || [];
  const since = day(now - Math.min(60, Math.max(1, Number(days) || 21)) * 864e5);
  const parts = await Promise.all(parls.map(async (p) => {
    try { return { p, items: shape(p, await query(feedSql(p, { since }), opts)) }; }
    catch (e) { if (e.code === 'PARL_NOT_CONFIGURED') throw e; return { p, items: [], error: e.message }; }
  }));
  const today = day(now);
  const all = [].concat(...parts.map((x) => x.items));
  // Past and today: the feed, newest first. Later dates (the diary) and open
  // deadlines: coming up, soonest first.
  const items = all.filter((i) => !i.dated || i.dated <= today).sort((a, b) => String(b.dated).localeCompare(String(a.dated)) || (b.score || 0) - (a.score || 0));
  const upcoming = all.filter((i) => (i.dated && i.dated > today) || (i.deadline && i.deadline >= today))
    .map((i) => ({ ...i, when: i.dated && i.dated > today ? i.dated : i.deadline })).sort((a, b) => a.when.localeCompare(b.when)).slice(0, 10);
  return { team, covered: parls.map((p) => PLACE[p]), since, items, upcoming, errors: parts.filter((x) => x.error).map((x) => `${PLACE[x.p]}: ${x.error}`) };
}

// Speeches on our issues (B2, Chris 12 Nov): what MPs, peers and MSPs said,
// with the words, for the morning run to turn into a post and a video. Only
// speeches the monitor matched to an issue area, newest first.
function speechSql(parliament, { since }) {
  if (parliament === 'westminster') {
    return `select e.ref, e.date::text as dated, e.line as title, e.areas, left(e.excerpt, 600) as quote, m.name as who, m.party from mp_events e left join members m on m.id = e.member_id where e.kind = 'debate' and e.date::text >= ${lit(since)} and e.excerpt is not null and e.areas is not null and e.areas::text not in ('[]', '') order by e.date desc limit 80`;
  }
  if (parliament === 'holyrood') {
    return `select e.key as ref, e.dated::text as dated, e.heading as title, e.areas, left(e.excerpt, 600) as quote, m.name as who, m.party from sp_events e left join sp_members m on m.person_id::text = e.person_id::text where e.dated::text >= ${lit(since)} and e.excerpt is not null and e.areas is not null and e.areas::text not in ('[]', '') order by e.dated desc limit 80`;
  }
  throw new Error(`Unknown parliament ${parliament}`);
}
const tidyName = (n) => { const s = String(n || '').trim(); const m = s.match(/^([^,]+),\s*(.+)$/); return m ? `${m[2]} ${m[1]}` : s; };
function shapeSpeeches(parliament, rows) {
  return (rows || []).map((r) => ({
    ref: String(r.ref || ''), parliament, place: PLACE[parliament], dated: r.dated ? String(r.dated).slice(0, 10) : null,
    title: String(r.title || '').replace(/^Spoke:\s*/, '').slice(0, 200), who: tidyName(r.who) || null, party: r.party || null,
    quote: String(r.quote || '').replace(/\s+/g, ' ').trim(), areas: areasOf(r.areas),
  })).filter((r) => r.ref && r.quote.length >= 60 && r.areas.length);
}
async function speeches(team, { days = 3, now = Date.now(), ...opts } = {}) {
  const parls = TEAM_PARLIAMENTS[team] || [];
  const since = day(now - Math.min(14, Math.max(1, Number(days) || 3)) * 864e5);
  const parts = await Promise.all(parls.map(async (p) => {
    try { return { p, items: shapeSpeeches(p, await query(speechSql(p, { since }), opts)) }; }
    catch (e) { if (e.code === 'PARL_NOT_CONFIGURED') throw e; return { p, items: [], error: e.message }; }
  }));
  return { since, items: [].concat(...parts.map((x) => x.items)).sort((a, b) => String(b.dated).localeCompare(String(a.dated))), errors: parts.filter((x) => x.error).map((x) => `${PLACE[x.p]}: ${x.error}`) };
}

module.exports = { AREA_NAMES, TEAM_PARLIAMENTS, MIN_SCORE, feedSql, shape, areasOf, query, feed, speechSql, shapeSpeeches, speeches };
