'use strict';
// Tracked CitizenGO links: finding them in post text, resolving cgo.ac short
// links, and reading the campaign code (15 Oct 2026). Shared by the link
// registry (collector/links.js), the Looker loader
// (scripts/load-link-signatures.js) and the link_performance tool.
//
// The campaign code follows the CitizenGO UTM standard ("UTM Parameters
// convention management [TECHNOLOGY]" in Drive):
//   LIST-DATE-TITLE-OWNER-CTA_TYPE-SCOPE-TOPIC-ASSETID[-SERIES]
//   EN_ROW-2026_10_14-Tedros_Wants_His_Win-RDA-AA_NA-GL-FR-19538-TW1
// OWNER is the initials of whoever made the link in Campaign Copilot; SERIES
// is the platform and post number (FB1, IG2). Looker stores utm_campaign in
// lowercase, so every code here is lowercased before it is stored or joined.

const OUR_HOSTS = ['citizengo.org', 'hazteoir.org', 'cgo.ac', 'derechoavivir.org'];
const SHORT_HOST = 'cgo.ac';
// The shortener answers on the API host; cgo.ac only redirects there.
const SHORTENER_EXPAND = 'https://api-prod.citizengo.org/';

// Links in free text. Captions often carry a bare "cgo.ac/scXXXX" with no
// scheme, so the scheme is optional; trailing punctuation is not part of a URL.
const LINK_RE = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:citizengo\.org|hazteoir\.org|cgo\.ac|derechoavivir\.org)(?:\/[^\s<>"'()\[\]{}]*)?/gi;

function extractLinks(text) {
  if (!text) return [];
  const out = [];
  for (const m of String(text).matchAll(LINK_RE)) {
    let u = m[0].replace(/[.,;:!?»”’…]+$/, '');
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    // A bare domain ("citizengo.org") is a mention, not a tracked link.
    try { if (new URL(u).pathname.replace(/\/+$/, '') === '') continue; } catch (e) { continue; }
    out.push(u);
  }
  return [...new Set(out)];
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { return null; }
}

function shortCodeOf(url) {
  if (hostOf(url) !== SHORT_HOST) return null;
  const code = new URL(url).pathname.replace(/^\/+|\/+$/g, '');
  return /^[A-Za-z0-9]{4,20}$/.test(code) ? code : null;
}

// Copilot codes. LIST is usually xx_yy but can be a fundraising id ("550");
// the title may itself contain hyphens in older codes, so it is matched lazily
// and everything after it is anchored on the fixed segments.
const CODE_RE = /^([a-z0-9_]+)-(\d{4}_\d{2}_\d{2})-(.+)-([a-z]{2,5})-([a-z]+_[a-z]+)-(lo|in|gl)-([a-z]{2})-(\d+)(?:-([a-z]{1,3}\d{1,2}))?(?:-|$)/;

function parseCode(code) {
  const c = String(code || '').trim().toLowerCase();
  const m = c.match(CODE_RE);
  if (!m) return { campaign_code: c || null, owner: null, petition_id: null, series: null, code_date: null };
  return {
    campaign_code: c,
    owner: m[4],
    petition_id: m[8],
    series: m[9] || null,
    code_date: m[2].replace(/_/g, '-'),
  };
}

// Petition or form id from the URL itself, for links with no campaign code.
function petitionIdOf(url) {
  try {
    const u = new URL(url);
    const f = u.searchParams.get('fundraising_id');
    if (f) return f;
    const m = u.pathname.match(/\/(\d{3,})(?:[-/]|$)/);
    return m ? m[1] : null;
  } catch (e) { return null; }
}

// Everything the registry stores about one resolved link.
function parseTracked(fullUrl) {
  const out = { campaign_code: null, utm_source: null, utm_medium: null, petition_id: null, owner: null, series: null };
  if (!fullUrl) return out;
  let u;
  try { u = new URL(fullUrl); } catch (e) { return out; }
  const code = u.searchParams.get('utm_campaign') || u.searchParams.get('campaign');
  const parsed = parseCode(code);
  out.campaign_code = parsed.campaign_code;
  out.owner = parsed.owner;
  out.series = parsed.series;
  out.petition_id = parsed.petition_id || petitionIdOf(fullUrl);
  out.utm_source = (u.searchParams.get('utm_source') || '').toLowerCase() || null;
  out.utm_medium = (u.searchParams.get('utm_medium') || '').toLowerCase() || null;
  return out;
}

// cgo.ac/<code> -> api host -> the full URL. Two hops, read from the Location
// headers without loading the page. Returns {full_url, http_status}.
async function resolveShortCode(code, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(SHORTENER_EXPAND + '/' + encodeURIComponent(code), { redirect: 'manual', signal: ctl.signal });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) return { full_url: loc, http_status: res.status };
    return { full_url: null, http_status: res.status };
  } catch (e) {
    return { full_url: null, http_status: null };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { OUR_HOSTS, extractLinks, shortCodeOf, parseCode, parseTracked, petitionIdOf, resolveShortCode, hostOf };
