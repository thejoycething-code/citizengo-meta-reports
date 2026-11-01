'use strict';
// Nightly re-check of Connect Facebook rights (slice 2, Nov 2026). Each
// person's sealed Page token is opened on the Mini and shown to Facebook: a
// token Facebook no longer accepts means the person lost their role on the
// Page (or removed the app, or changed their password), so the right goes and
// they connect again from the desk. Run by collector/rights-check.js.
//
// Limit: a person moved to a lesser Page role keeps a working token, so that
// case still shows up only when the publisher's post is refused.

const VERSION = process.env.GRAPH_VERSION || 'v23.0';

// Facebook error → what it means for the right. Only errors that say the
// token or the permission is gone count as lost; anything else (rate limits,
// outages, a network blip) is "unsure" and the right stays until next night.
function verdict(error) {
  if (!error) return 'ok';
  const code = Number(error.code);
  const sub = Number(error.error_subcode);
  if (code === 190 || code === 102) return 'lost';          // token invalid or expired
  if (code === 10 || (code >= 200 && code < 300)) return 'lost'; // permission gone
  if (code === 100 && sub === 33) return 'lost';            // the Page or account isn't reachable with it
  return 'unsure';
}

function platformOf(teams, key) {
  for (const t of teams || []) for (const a of t.accounts || []) if (a.key === key) return a.platform;
  return null;
}

// tokens: engine_page_tokens rows; rights: engine_publish_rights rows with
// source 'meta'. Maintainer-seeded rights are never touched here.
function plan(tokens, rights, teams) {
  const has = new Set(tokens.map((t) => `${t.who.toLowerCase()}|${t.account_key}`));
  const checks = tokens.map((t) => ({ who: t.who, account_key: t.account_key, platform: platformOf(teams, t.account_key), tok: t }));
  const orphans = rights.filter((r) => !has.has(`${r.who.toLowerCase()}|${r.account_key}`)).map((r) => ({ who: r.who, account_key: r.account_key }));
  return { checks, orphans };
}

async function check(item, token, fetchImpl = fetch) {
  const { platform, tok } = item;
  const path = platform === 'instagram' ? tok.ig_id : 'me';
  if (!path) return { result: 'lost', why: 'no Instagram account is linked to this Page any more' };
  let json;
  try {
    const r = await fetchImpl(`https://graph.facebook.com/${VERSION}/${encodeURIComponent(path)}?${new URLSearchParams({ fields: 'id', access_token: token })}`);
    json = await r.json().catch(() => ({}));
  } catch (e) {
    return { result: 'unsure', why: 'Facebook could not be reached' };
  }
  if (json && json.error) {
    const v = verdict(json.error);
    return { result: v, why: v === 'lost' ? `Facebook no longer accepts it (code ${json.error.code})` : `Facebook answered code ${json.error.code}` };
  }
  if (platform === 'facebook' && String(json.id) !== String(tok.page_id)) return { result: 'lost', why: 'the token is not for this Page any more' };
  if (platform === 'instagram' && String(json.id) !== String(tok.ig_id)) return { result: 'lost', why: 'the token can no longer see this Instagram account' };
  return { result: 'ok' };
}

// Every token lost at once looks like a problem with the app (secret reset,
// app switched off), not with the people: hold back and say so.
function looksAppWide(results) {
  const lost = results.filter((r) => r.result === 'lost').length;
  return results.length >= 3 && lost === results.length;
}

module.exports = { verdict, platformOf, plan, check, looksAppWide };
