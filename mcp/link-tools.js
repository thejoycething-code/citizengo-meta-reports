'use strict';
// link_performance (15 Oct 2026): which tracked links our accounts posted and
// what each one brought - signatures, new and reactivated members - joined on
// the campaign code (utm_campaign) that Looker records for every signature.
//
// Covers every connected account (Facebook Pages, Instagram, X, spokespeople)
// through link_posts, and codes no post shows (Stories, DMs, Facebook first
// comments) through link_signatures. Same rules as the other tools: say what is
// missing, never present a partial number as a total.

const xt = require('./x-tools');

const n = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-GB'));
const clampRows = (v, dflt, max = 200) => Math.min(Math.max(Number(v) || dflt, 1), max);
const PLATFORM_SOURCE = { facebook: 'fb', instagram: 'ig', x: 'tw' };
const PLATFORM_LABEL = { facebook: 'Facebook', instagram: 'Instagram', x: 'X' };

function table(headers, rows) {
  if (!rows.length) return '_No rows._';
  return `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n` + rows.map((r) => `| ${r.join(' | ')} |`).join('\n');
}
const cell = (s, len = 70) => {
  const one = String(s || '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');
  return one.length > len ? one.slice(0, len - 1) + '…' : one;
};

// Pure aggregation, exported for the tests.
//   posts: link_posts rows; sigs: link_signatures rows (any codes).
// Returns one entry per campaign code with its posts and totals, plus counts
// of links that carry no code (they cannot be traced).
function aggregate(posts, sigs, { includeUnposted = false } = {}) {
  const byCode = new Map();
  const untraced = posts.filter((p) => !p.campaign_code);
  for (const p of posts) {
    if (!p.campaign_code) continue;
    if (!byCode.has(p.campaign_code)) byCode.set(p.campaign_code, { code: p.campaign_code, owner: p.owner, petition_id: p.petition_id, posts: [], sources: {} });
    byCode.get(p.campaign_code).posts.push(p);
  }
  for (const s of sigs) {
    if (!byCode.has(s.campaign_code)) {
      if (!includeUnposted) continue;
      byCode.set(s.campaign_code, { code: s.campaign_code, owner: s.owner, petition_id: s.petition_id, posts: [], sources: {} });
    }
    byCode.get(s.campaign_code).sources[s.source] = s;
  }
  const out = [];
  for (const e of byCode.values()) {
    const src = Object.values(e.sources);
    const sum = (k) => (src.length ? src.reduce((a, s) => a + (Number(s[k]) || 0), 0) : null);
    // "Direct": signers who arrived from the platform the link was made for
    // (fb for an FB1 code). The rest came via shares (WhatsApp, email...).
    const own = (e.code.match(/-(fb|ig|tw|tk|yt|tg)\d+$/) || [])[1];
    const direct = own && e.sources[own] ? Number(e.sources[own].signatures) || 0 : (src.length ? 0 : null);
    out.push({ ...e, signatures: sum('signatures'), new_members: sum('new_members'), reactivated_members: sum('reactivated_members'),
      direct, via_shares: e.signatures === null ? null : (sum('signatures') - (direct || 0)), matched: src.length > 0 });
  }
  out.sort((a, b) => (b.signatures || 0) - (a.signatures || 0) || String(b.code).localeCompare(a.code));
  return { codes: out, untraced };
}

// Totals per account / owner / petition. A code posted by two accounts counts
// for each of them, so the group totals can exceed the grand total (said so).
function groupBy(codes, key) {
  const g = new Map();
  for (const c of codes) {
    const keys = key === 'account'
      ? [...new Set(c.posts.map((p) => `${PLATFORM_LABEL[p.platform] || p.platform} ${p.account_label || p.account_id}`))].concat(c.posts.length ? [] : ['(not seen in a post)'])
      : [c[key] || '(none)'];
    for (const k of keys) {
      if (!g.has(k)) g.set(k, { key: k, codes: 0, posts: 0, signatures: 0, new_members: 0, reactivated_members: 0, unmatched: 0 });
      const t = g.get(k);
      t.codes++; t.posts += c.posts.length;
      if (!c.matched) t.unmatched++;
      t.signatures += c.signatures || 0; t.new_members += c.new_members || 0; t.reactivated_members += c.reactivated_members || 0;
    }
  }
  return [...g.values()].sort((a, b) => b.signatures - a.signatures);
}

async function linkPerformance(store, args = {}) {
  const { account, owner, petition, campaign, platform, group_by = 'link', limit = 50, offset = 0 } = args;
  const w = xt.windowFor({ month: args.month, from: args.from, to: args.to, days: args.days }, 90);
  if (w.error) return { text: w.error };
  const own = owner ? String(owner).trim().toLowerCase() : undefined;
  const pet = petition ? String(petition).replace(/\D/g, '') || undefined : undefined;
  const includeUnposted = args.include_unposted !== undefined ? Boolean(args.include_unposted) : Boolean((own || pet) && !account && !platform);

  const posts = await store.linkPosts({ account, owner: own, petition_id: pet, campaign, platform, since: w.since, until: w.until });
  const codes = [...new Set(posts.map((p) => p.campaign_code).filter(Boolean))];
  let sigs = codes.length ? await store.linkSignatures({ codes }) : [];
  if (includeUnposted) {
    const extra = await store.linkSignatures({ owner: own, petition_id: pet, from: w.since, to: w.until });
    const seen = new Set(sigs.map((s) => `${s.campaign_code}|${s.source}`));
    sigs = sigs.concat(extra.filter((s) => !seen.has(`${s.campaign_code}|${s.source}`) && (!campaign || s.campaign_code.includes(String(campaign).toLowerCase()))));
  }
  const fresh = await store.linkFreshness();
  const { codes: rows, untraced } = aggregate(posts, sigs, { includeUnposted });

  const who = [account && `account "${account}"`, own && `links made by ${own.toUpperCase()}`, pet && `petition ${pet}`, campaign && `codes containing "${campaign}"`, platform && PLATFORM_LABEL[platform]].filter(Boolean).join(', ');
  const title = `**Link performance${who ? ` · ${who}` : ''}, ${w.label}**`;
  if (!rows.length && !untraced.length) {
    return { text: `${title}\n\nNo tracked CitizenGO links found.${fresh.registryAt ? '' : ' The link registry has not been built yet.'}` };
  }
  const total = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const notes = [];
  notes.push(`Signatures, new and reactivated members come from Looker (Bluebook signatures by utm_campaign), all time for each code${fresh.pulledAt ? `, pulled ${String(fresh.pulledAt).slice(0, 16).replace('T', ' ')} UTC` : ' — **not pulled yet, so every figure is blank**'}. "Direct" is signers who arrived from the platform the link was made for; the rest arrived after it was shared on (mostly WhatsApp).`);
  const unmatched = rows.filter((r) => !r.matched).length;
  if (unmatched) notes.push(`${n(unmatched)} code(s) have no signatures recorded in Looker yet (shown as —): too new, no signers, or the code was changed after the link was made.`);
  if (untraced.length) notes.push(`${n(untraced.length)} post link(s) carried no campaign code (a plain petition link or an unresolved short link), so their signatures cannot be traced. Make links in Campaign Copilot.`);
  notes.push('Posts are what the connector collects: Facebook first comments, Stories and DMs are not posts here; with include_unposted their codes still count.');

  let body;
  if (group_by !== 'link') {
    const key = group_by === 'owner' ? 'owner' : group_by === 'petition' ? 'petition_id' : 'account';
    const g = groupBy(rows, key);
    body = table([key === 'account' ? 'Account' : key === 'owner' ? 'Made by' : 'Petition', 'Codes', 'Posts', 'Signatures', 'New members', 'Reactivated'],
      g.map((t) => [cell(key === 'owner' ? String(t.key).toUpperCase() : t.key, 50), n(t.codes), n(t.posts), n(t.signatures), n(t.new_members), n(t.reactivated_members)]));
    if (key === 'account') notes.push('A code posted by more than one account counts for each, so account rows can add up to more than the total.');
  } else {
    const off = Math.max(Number(offset) || 0, 0);
    const page = rows.slice(off, off + clampRows(limit, 50));
    body = table(['Campaign code', 'Posted', 'Signatures', 'Direct', 'Via shares', 'New', 'Reactivated'], page.map((r) => {
      const where = r.posts.length
        ? r.posts.slice(0, 3).map((p) => `${p.permalink_url ? `[${cell(`${PLATFORM_LABEL[p.platform]} ${p.account_label || ''} ${String(p.posted_at).slice(0, 10)}`, 40)}](${p.permalink_url})` : cell(`${PLATFORM_LABEL[p.platform]} ${p.account_label || ''}`, 40)}`).join('<br>') + (r.posts.length > 3 ? `<br>+${r.posts.length - 3} more` : '')
        : '_not in a post_';
      return [cell(r.code, 80), where, n(r.signatures), n(r.direct), n(r.via_shares), n(r.new_members), n(r.reactivated_members)];
    })) + xt.pageNote(off, page.length, rows.length, 'Codes').replace('x_period_summary', 'group_by');
  }
  const head = `${title}\n\n${n(rows.length)} campaign codes · ${n(total('signatures'))} signatures · ${n(total('new_members'))} new members · ${n(total('reactivated_members'))} reactivated\n\n`;
  return { text: head + body + '\n\n' + notes.map((x) => `_${x}_`).join('\n\n'), rows, untraced: untraced.length };
}

const LINK_TOOLS = [
  {
    name: 'link_performance',
    description: 'Signatures, new members and reactivated members brought by the tracked CitizenGO links our accounts posted, joined on the campaign code (utm_campaign). Covers every connected account: Facebook Pages, Instagram, X and spokespeople such as Rocío D\'Angelo. Filter by account, by who made the link (owner initials in the code, e.g. RDA, CJO), petition or campaign text; group_by account/owner/petition for totals. Use for "how many signatures did Rocío bring this month", "which of our posts brought the most new members", "signatures per account for petition 19615". Signature figures come from Looker, all time per code.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'An account: X handle (@rociodangelo6), Instagram @username, Facebook Page name or id. Partial names match.' },
        owner: { type: 'string', description: 'Initials of whoever made the link in Campaign Copilot, as in the code (RDA, CJO, MMA).' },
        petition: { type: 'string', description: 'Petition or donation form id, e.g. 19615.' },
        campaign: { type: 'string', description: 'Text the campaign code contains, e.g. "tedros" or "19538-tw1".' },
        platform: { type: 'string', enum: ['facebook', 'instagram', 'x'], description: 'Only posts on this platform.' },
        days: { type: 'number', description: 'Posts from the last N days (default 90, 0 for all).' },
        month: { type: 'string', description: 'A month, e.g. "2026-09" or "September 2026", instead of days.' },
        from: { type: 'string', description: 'Start date (YYYY-MM-DD).' },
        to: { type: 'string', description: 'End date inclusive (YYYY-MM-DD).' },
        group_by: { type: 'string', enum: ['link', 'account', 'owner', 'petition'], description: 'link (default): one row per campaign code. account/owner/petition: totals.' },
        include_unposted: { type: 'boolean', description: 'Also count codes with signatures that no collected post shows (Stories, DMs, Facebook first comments). Defaults to true when filtering by owner or petition alone.' },
        limit: { type: 'number', description: 'Codes per page (default 50, max 200).' },
        offset: { type: 'number', description: 'Where the page starts (0 = first).' },
      },
      additionalProperties: false,
    },
    handler: linkPerformance,
  },
];

module.exports = { LINK_TOOLS, aggregate, groupBy, linkPerformance };
