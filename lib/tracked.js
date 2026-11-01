'use strict';
// Tracked links in replies and private messages [gaps §6, 1 Nov 2026].
//
// Each petition link in a reply or DM is swapped, when it is queued, for a
// Campaign Copilot short link whose utm_campaign says where it was sent and
// by whom. Copilot builds the code in the CitizenGO standard
//   LIST-DATE-TITLE-OWNER-CTA_TYPE-SCOPE-TOPIC-ASSETID-SERIES
// and cuts TITLE to 40 characters, so the marker goes at the front of TITLE:
//   EN_GB-2026_11_01-DM_TBS_She_Was_Abducted_At_12_UK_Aid-CJO-AA_NA-LO-FR-19439-FB1
//   MARK  DM  private message typed on the desk    RE  public reply typed on the desk
//         ADM private message sent by an automation  ARE public reply sent by an automation
//         (post-level links keep a plain title; FC, BIO and ST are kept for the
//         first comment, link in bio and Stories)
//   WHO   the sender's 2-3 letter initials (Team and access); an automation's
//         are its maker's. Someone with none yet uses the post's own owner.
//   OWNER whoever the engine's Copilot sign-in belongs to (Copilot sets it).
//   SERIES FB1 or IG1: where it was sent.
// In Looker, utm_campaign ~ '^[^-]+-[^-]+-(dm|re|adm|are)_([a-z]{2,3})_' picks
// them out (Looker lowercases it). If Copilot can't be reached, the same code
// goes out as a long citizengo.org link with exactly the parameters Copilot
// would have used, so signatures are attributed the same way.

const L = require('./links');
const copilot = require('./copilot');

const MARKS = { DM: 'private message (desk)', RE: 'public reply (desk)', ADM: 'private message (automation)', ARE: 'public reply (automation)', FC: 'first comment', BIO: 'link in bio', ST: 'Story' };
const SOURCE = { facebook: 'fb', instagram: 'ig' };
const SERIES = { facebook: 'FB1', instagram: 'IG1' };
const DEFAULT_SCOPE = 'LO';
const TITLE_MAX = 60; // Copilot refuses a longer campaignTitle
const CODE_TITLE_MAX = 40; // and keeps this much of it in the code
const PETITION_PATH = /^\/([a-z]{2}-[a-z]{2})\/([a-z]{2,3})\/(\d+)(?:-([^/?#]*))?/i;

function markFor(action, automated) { return (automated ? 'A' : '') + (action === 'private_reply' ? 'DM' : 'RE'); }

// Plain ASCII words, each starting with a capital (as make_links.py does).
function cleanTitle(t, max = TITLE_MAX) {
  const words = String(t || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\x00-\x7f]/g, '').replace(/['’]/g, '')
    .split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1));
  let out = '';
  for (const w of words) { const nxt = out ? `${out} ${w}` : w; if (nxt.length > max) break; out = nxt; }
  return out.replace(/( (And|Or|The|To|Of|A|An|For|In|On|With))+$/, '') || 'NA';
}
function codeTitle(campaignTitle) { return String(campaignTitle).replace(/ +/g, '_').slice(0, CODE_TITLE_MAX).replace(/_+$/, ''); }
function stamp(now) { return new Date(now).toISOString().slice(0, 10).replace(/-/g, '_'); }

function petitionOf(url) {
  try {
    const u = new URL(url);
    if (!['citizengo.org'].includes(L.hostOf(url))) return null;
    const m = u.pathname.match(PETITION_PATH);
    return m ? { locale: m[1].toLowerCase(), cat: m[2].toLowerCase(), id: m[3], slug: m[4] || '' } : null;
  } catch (e) { return null; }
}

// Everything Copilot is asked for, and the code it will make from it.
function plan({ petition, info = {}, platform, mark, who, owner, now = Date.now() }) {
  const title = cleanTitle(`${mark} ${who} ${cleanTitle(info.title || petition.slug.replace(/-/g, ' '))}`);
  const scope = String(info.scope || DEFAULT_SCOPE).toUpperCase();
  const args = {
    channel: 'social', assetType: 'petition', petitionId: Number(petition.id), trafficType: 'organic', ctaFamilyCode: 'AA',
    platformCode: SOURCE[platform], seriesFlow: SERIES[platform], listCode: petition.locale.toUpperCase().replace(/-/g, '_'),
    topicCode: petition.cat.toUpperCase(), scopeCode: scope, campaignTitle: title,
  };
  const code = [args.listCode, stamp(now), codeTitle(title), owner, 'AA_NA', scope, args.topicCode, petition.id, args.seriesFlow].join('-');
  const long = `https://citizengo.org/${petition.locale}/${petition.cat}/${petition.id}?` + new URLSearchParams({ campaign: code, utm_source: SOURCE[platform], utm_medium: 'social', utm_campaign: code, utm_content: 'link_1' });
  return { args, code, long };
}

// One link in, its tracked version out: {from, to, code, via} or null to
// leave it as it is (not a petition, or a platform with no series).
async function trackLink({ store, url, platform, mark, who, petitions = {}, owner, now = Date.now(), fetchImpl = fetch, call = copilot.call }) {
  if (!SOURCE[platform]) return null;
  let full = url;
  const short = L.shortCodeOf(url);
  if (short) {
    const r = await L.resolveShortCode(short, { fetchImpl, timeoutMs: 5000 });
    if (!r.full_url) return null;
    full = r.full_url;
  }
  const petition = petitionOf(full);
  if (!petition) return null;
  const info = petitions[petition.id] || {};
  const p = plan({ petition, info, platform, mark, who: who || info.owner || owner, owner, now });
  const cached = await store.engineTrackedLink(p.code).catch(() => null);
  if (cached && cached.via === 'copilot' && cached.short_url) return { from: url, to: cached.short_url, code: p.code, via: 'copilot' };
  try {
    const r = await call(store, 'generate_social_url', p.args, { fetchImpl });
    if (!r || !r.shortUrl) throw new Error('Copilot gave no short link');
    const code = r.campaignName || p.code;
    await store.engineSaveTrackedLink({ code, short_url: r.shortUrl, long_url: r.fullUrl || p.long, via: 'copilot', petition_id: petition.id, mark, who, link_id: r.linkId ? String(r.linkId) : null }).catch(() => {});
    return { from: url, to: r.shortUrl, code, via: 'copilot' };
  } catch (e) {
    await store.engineSaveTrackedLink({ code: p.code, short_url: null, long_url: p.long, via: 'long', petition_id: petition.id, mark, who }).catch(() => {});
    return { from: url, to: p.long, code: p.code, via: 'long', error: e.message };
  }
}

// Every CitizenGO petition link in a reply or DM, tracked. Returns the new
// text and what changed; text with no petition links comes back untouched.
async function trackText(text, opts) {
  const links = [];
  let out = String(text || '');
  for (const m of [...new Set(String(text || '').match(/(?:https?:\/\/)?(?:www\.)?(?:citizengo\.org|cgo\.ac)\/[^\s<>"'()\[\]{}]*/gi) || [])]) {
    const url = m.replace(/[.,;:!?»”’…]+$/, '');
    const r = await trackLink({ ...opts, url: /^https?:\/\//i.test(url) ? url : 'https://' + url });
    if (r) { links.push({ ...r, from: url }); out = out.split(url).join(r.to); }
  }
  return { text: out, links };
}

// Petition titles, scopes and owners from the team's engine posts.
function petitionsFrom(posts) {
  const out = {};
  for (const p of posts || []) {
    const a = (p.doc && p.doc.action) || {};
    if (!a.petitionId || out[a.petitionId]) continue;
    const link = Object.values((p.doc && p.doc.links) || {}).find((l) => l && l.campaign);
    out[a.petitionId] = { title: a.title || p.title, scope: a.scope, owner: link ? String(L.parseCode(link.campaign).owner || '').toUpperCase() || null : null };
  }
  return out;
}

// A reply or DM about to be queued for one inbox item: the sender's initials,
// the team's petitions and the Copilot owner are looked up here. Never throws:
// if anything fails the text goes out as typed, with the error noted.
async function trackForItem(store, item, text, { action, who, automated = false, memo, now, fetchImpl, call } = {}) {
  if (!text || !SOURCE[item.platform] || !/citizengo\.org|cgo\.ac/i.test(text)) return { text, links: [] };
  try {
    const [people, posts, auth] = await Promise.all([store.enginePeople(), store.enginePosts({ team_ids: [item.team_id], limit: 500 }), store.engineCopilotAuth().catch(() => null)]);
    const initials = ((people || []).find((p) => p.who === who) || {}).initials || null;
    const mark = item.kind === 'message' ? (automated ? 'ADM' : 'DM') : markFor(action, automated);
    const key = `${item.platform}|${mark}|${initials}|${text}`;
    if (memo && memo.has(key)) return memo.get(key);
    const out = await trackText(text, { store, platform: item.platform, mark, who: initials, petitions: petitionsFrom(posts), owner: (auth && auth.owner) || 'CJO', now, fetchImpl, call });
    if (memo) memo.set(key, out);
    return out;
  } catch (e) { return { text, links: [], error: e.message }; }
}

module.exports = { trackForItem, MARKS, SOURCE, SERIES, markFor, cleanTitle, codeTitle, petitionOf, plan, trackLink, trackText, petitionsFrom };
