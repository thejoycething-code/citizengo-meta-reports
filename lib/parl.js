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

// Listening D2 (Chris, 22 Nov 2026): open e-petitions on our issues climbing,
// from the monitor's petition watch (petitions + weekly petition_snapshots).
// The week's gain is the count now against the snapshot before the latest.
const AREA_TOPIC = { 1: 'abortion', 2: 'assisted-dying', 3: 'gender', 5: 'gender', 6: 'sex-education', 7: 'free-speech', 8: 'free-speech', 9: 'family', 10: 'family' };
function petitionsSql({ since }) {
  return `with s as (select petition_id, captured_at::text as at, signatures, row_number() over (partition by petition_id order by captured_at desc) as rn from petition_snapshots where captured_at::text >= ${lit(since)}) `
    + `select p.id, p.action as title, p.url, p.signatures, p.areas, p.closing_date::text as closes, p.response_reached::text as response, p.debate_reached::text as debate, s1.signatures as now_count, s1.at as now_at, s2.signatures as prev_count, s2.at as prev_at `
    + `from petitions p left join s s1 on s1.petition_id = p.id and s1.rn = 1 left join s s2 on s2.petition_id = p.id and s2.rn = 2 where p.state = 'open' order by p.signatures desc limit 120`;
}
function shapePetitions(rows, now = Date.now()) {
  return (rows || []).map((r) => {
    const sig = Math.max(Number(r.signatures) || 0, Number(r.now_count) || 0);
    const prev = r.prev_count == null ? null : Number(r.prev_count);
    const span = r.prev_at ? Math.max(1, Math.round((now - Date.parse(r.prev_at)) / 864e5)) : null;
    const gain = prev == null ? null : Math.max(0, sig - prev);
    const areas = areasOf(r.areas);
    return { id: String(r.id), title: String(r.title || '').slice(0, 300), url: /^https:\/\//.test(r.url || '') ? r.url : `https://petition.parliament.uk/petitions/${r.id}`,
      signatures: sig, gain, days: span, per_day: gain != null && span ? Math.round(gain / span) : null, closes: r.closes ? String(r.closes).slice(0, 10) : null,
      response: !!r.response, debate: !!r.debate, areas, topics: [...new Set(areas.map((a) => AREA_TOPIC[a.n]).filter(Boolean))] };
  }).filter((p) => p.areas.length).sort((a, b) => (b.per_day || 0) - (a.per_day || 0) || b.signatures - a.signatures);
}
async function petitionsClimbing({ now = Date.now(), ...opts } = {}) {
  const rows = await query(petitionsSql({ since: day(now - 35 * 864e5) }), opts);
  return shapePetitions(rows, now);
}
// Listening D3: what the campaigns on the other side publish themselves (the
// monitor's opposition watch, config/opposition.yaml there), newest first.
function oppNewsSql({ since }) {
  return `select url, org, title, published::text as published, left(summary, 400) as summary, areas, first_seen::text as first_seen from opposition_items where coalesce(published::text, first_seen::text) >= ${lit(since)} order by coalesce(published::text, first_seen::text) desc limit 80`;
}
function shapeOppNews(rows) {
  return (rows || []).filter((r) => /^https:\/\//.test(r.url || '') && r.title).map((r) => {
    const areas = areasOf(r.areas);
    return { url: r.url, org: String(r.org || ''), title: String(r.title).replace(/\s+/g, ' ').slice(0, 240), at: String(r.published || r.first_seen || '').slice(0, 10) || null,
      summary: r.summary ? String(r.summary).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) : null, areas, topics: [...new Set(areas.map((a) => AREA_TOPIC[a.n]).filter(Boolean))] };
  });
}
async function opponentNews({ days = 14, now = Date.now(), ...opts } = {}) {
  return shapeOppNews(await query(oppNewsSql({ since: day(now - days * 864e5) }), opts));
}

module.exports = { AREA_NAMES, TEAM_PARLIAMENTS, MIN_SCORE, feedSql, shape, areasOf, query, feed, speechSql, shapeSpeeches, speeches, AREA_TOPIC, petitionsSql, shapePetitions, petitionsClimbing, oppNewsSql, shapeOppNews, opponentNews };
