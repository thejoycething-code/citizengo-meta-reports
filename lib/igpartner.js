'use strict';
// Instagram accounts shared with CitizenGO's Business Manager as a PARTNER
// (16 Oct 2026). The holder - a spokesperson such as Rocío D'Angelo - opens Meta
// Business Suite -> Settings -> Partners, adds CitizenGO's Business Manager and
// grants view-only Insights on her Instagram account. CitizenGO then assigns
// that shared account to its System User, and the System User token (one per
// Business Manager in META_TOKENS) reads it like any account of ours. No app
// review and no role on our app: access is between two businesses, and she
// can remove it in one click.
//
// Reached on graph.facebook.com (the Facebook-login flavour of the Instagram
// Graph API), not graph.instagram.com, and addressed by IG user id, not "me".

const VERSION = process.env.GRAPH_VERSION || 'v23.0';
const HOST = () => (process.env.GRAPH_HOST || 'https://graph.facebook.com').replace(/\/+$/, '');

const USER_FIELDS = 'id,username,name,followers_count,media_count';

function api(token, { fetchImpl = fetch } = {}) {
  return {
    async get(path, params = {}) {
      require('./env-guard').assertGraphHostSafe();
      const u = new URL(`${HOST()}/${VERSION}/${String(path).replace(/^\/+/, '')}`);
      for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
      const res = await fetchImpl(u.toString(), { headers: { Authorization: `Bearer ${token}` } });
      let body; try { body = await res.json(); } catch (e) { body = null; }
      return { ok: res.ok && !(body && body.error), status: res.status, body };
    },
  };
}

// Where a Business lists Instagram accounts it can use. Meta has moved these
// around between versions, so each is tried; a missing edge simply fails.
const BUSINESS_EDGES = ['instagram_business_accounts', 'owned_instagram_accounts', 'client_instagram_assets', 'client_instagram_accounts', 'instagram_accounts'];

// Which Business Managers a token belongs to. meta_pages.business_id is empty
// in production, so ask the token: a System User reports its business, and a
// user token lists the businesses it can manage. Both are tried.
async function businessesOf(g) {
  const ids = new Set();
  const me = await g.get('me', { fields: 'id,name,business{id,name}' });
  if (me.ok && me.body && me.body.business && me.body.business.id) ids.add(String(me.body.business.id));
  const list = await g.get('me/businesses', { fields: 'id,name', limit: 100 });
  if (list.ok && list.body && Array.isArray(list.body.data)) for (const b of list.body.data) ids.add(String(b.id));
  return [...ids];
}

// Find a shared account by username across our tokens and businesses.
// Returns { igUserId, username, tokenIndex, businessId, edge } or null, plus
// a log of what was tried (for the enrolment output; no tokens in it).
// businessIds: fixed list, or null to ask each token (businessesOf).
async function findShared({ tokens, businessIds, username, makeApi = api }) {
  const want = String(username || '').replace(/^@/, '').toLowerCase();
  const tried = [];
  for (let t = 0; t < tokens.length; t++) {
    const g = makeApi(tokens[t]);
    const bizList = businessIds && businessIds.length ? businessIds : await businessesOf(g);
    if (!bizList.length) tried.push({ token: t, business: null, edge: '(no business found for this token)', ok: false, count: null });
    for (const biz of bizList) {
      for (const edge of BUSINESS_EDGES) {
        const r = await g.get(`${biz}/${edge}`, { fields: 'id,username', limit: 200 });
        tried.push({ token: t, business: biz, edge, ok: r.ok, count: r.ok && r.body && Array.isArray(r.body.data) ? r.body.data.length : null });
        if (!r.ok || !r.body || !Array.isArray(r.body.data)) continue;
        const hit = r.body.data.find((a) => String(a.username || '').toLowerCase() === want);
        if (hit) return { found: { igUserId: String(hit.id), username: hit.username, tokenIndex: t, businessId: String(biz), edge }, tried };
      }
    }
  }
  return { found: null, tried };
}

// Can this token read the account AND its insights? Both are needed: profile
// access without Insights means the partner share left Insights unticked.
async function checkAccess(g, igUserId) {
  const user = await g.get(igUserId, { fields: USER_FIELDS });
  if (!user.ok) return { ok: false, why: `cannot read the account (${(user.body && user.body.error && user.body.error.message) || 'HTTP ' + user.status})` };
  const media = await g.get(`${igUserId}/media`, { fields: 'id,timestamp', limit: 1 });
  const first = media.ok && media.body && Array.isArray(media.body.data) ? media.body.data[0] : null;
  if (!first) return { ok: true, user: user.body, insights: null, note: 'no posts to test insights on' };
  const ins = await g.get(`${first.id}/insights`, { metric: 'reach' });
  if (!ins.ok) return { ok: false, user: user.body, why: `can read posts but not insights (${(ins.body && ins.body.error && ins.body.error.message) || 'HTTP ' + ins.status}) - the partner share needs Insights access` };
  return { ok: true, user: user.body, insights: true };
}

module.exports = { api, findShared, checkAccess, businessesOf, USER_FIELDS, BUSINESS_EDGES, VERSION };
