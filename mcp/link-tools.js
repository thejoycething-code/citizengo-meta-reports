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

const SOURCE_LABEL = { fb: 'Facebook', ig: 'Instagram', tw: 'X', tk: 'TikTok', yt: 'YouTube', tg: 'Telegram' };

// Pure aggregation, exported for the tests.
//   posts: link_posts rows; sigs: link_signatures rows (any codes);
//   reach: Map post_id -> {impressions, url_link_clicks} for X posts.
//
// A campaign code is a LINK, not a post: the same link can sit in other
// people's posts, an ad, a bio, Stories or DMs. So (16 Oct 2026, after a
// 57-impression post was shown with 1,159 signatures that belonged to its
// link's other uses) each code's signatures are split by where the signer
// arrived from:
//   credited   - signers who came from a platform the code was POSTED on in
//                the posts we hold (an X post gets "tw" signers);
//   other uses - everything else: shares (WhatsApp...), and the link's uses
//                outside these posts.
// Flags: the link was made for another platform (an IG1 code posted on X);
// the link was made by someone else (a spokesperson reusing a colleague's
// link); the platform's signers exceed the posts' impressions or link clicks.
// In the last two cases the link was ALSO SHARED ELSEWHERE: the signers are
// still reported against the post (Chris, 16 Oct 2026: report what was posted
// on X), and the answer says most of them came from the link's other uses.
function aggregate(posts, sigs, { includeUnposted = false, reach = new Map() } = {}) {
  const byCode = new Map();
  const untraced = posts.filter((p) => !p.campaign_code);
  for (const p of posts) {
    if (!p.campaign_code) continue;
    if (!byCode.has(p.campaign_code)) byCode.set(p.campaign_code, { code: p.campaign_code, owner: p.owner, petition_id: p.petition_id, series: p.series || null, posts: [], sources: {} });
    byCode.get(p.campaign_code).posts.push(p);
  }
  for (const s of sigs) {
    if (!byCode.has(s.campaign_code)) {
      if (!includeUnposted) continue;
      byCode.set(s.campaign_code, { code: s.campaign_code, owner: s.owner, petition_id: s.petition_id, series: s.series || null, posts: [], sources: {} });
    }
    byCode.get(s.campaign_code).sources[s.source] = s;
  }

  // Each spokesperson account's usual link maker: the initials on most of the
  // codes it posted. A code by anyone else is someone else's link.
  const ownersByAccount = new Map();
  for (const p of posts) {
    if (!p.campaign_code || !p.owner || p.account_kind !== 'spokesperson') continue;
    const m = ownersByAccount.get(p.account_id) || new Map();
    m.set(p.owner, (m.get(p.owner) || 0) + 1);
    ownersByAccount.set(p.account_id, m);
  }
  const usualOwner = new Map([...ownersByAccount].map(([acct, m]) => {
    const [top, cnt] = [...m].sort((a, b) => b[1] - a[1])[0];
    const all = [...m.values()].reduce((a, b) => a + b, 0);
    return [acct, all >= 2 && cnt / all > 0.5 ? top : null];
  }));

  const out = [];
  for (const e of byCode.values()) {
    const src = Object.values(e.sources);
    const sumOf = (rows, k) => rows.reduce((a, s) => a + (Number(s[k]) || 0), 0);
    const matched = src.length > 0;
    const all = { signatures: matched ? sumOf(src, 'signatures') : null, new_members: matched ? sumOf(src, 'new_members') : null, reactivated_members: matched ? sumOf(src, 'reactivated_members') : null };
    const madeFor = (String(e.series || '').match(/^(fb|ig|tw|tk|yt|tg)\d+$/) || [])[1] || (e.code.match(/-(fb|ig|tw|tk|yt|tg)\d+$/) || [])[1] || null;
    const postedSources = [...new Set(e.posts.map((p) => PLATFORM_SOURCE[p.platform]).filter(Boolean))];
    const flags = [];
    let sharedElsewhere = false;

    // Signers per posted platform, with the plausibility check as a note.
    const creditedBySource = {};
    for (const srcKey of postedSources) {
      const row = e.sources[srcKey];
      const sig = row ? Number(row.signatures) || 0 : 0;
      if (srcKey === 'tw' && sig > 0) {
        const xp = e.posts.filter((p) => p.platform === 'x');
        const r = xp.map((p) => reach.get(p.post_id)).filter(Boolean);
        const impr = r.length === xp.length ? r.reduce((a, x) => a + (Number(x.impressions) || 0), 0) : null;
        const clicksKnown = r.length === xp.length && r.every((x) => x.url_link_clicks !== null && x.url_link_clicks !== undefined);
        const clicks = clicksKnown ? r.reduce((a, x) => a + (Number(x.url_link_clicks) || 0), 0) : null;
        if (impr !== null && sig > impr) {
          flags.push(`also shared elsewhere: these X posts had ${n(impr)} impressions, so most of the ${n(sig)} X signers came from the link's other uses`);
          sharedElsewhere = true;
        } else if (clicks !== null && sig > clicks * 1.5 + 5) {
          flags.push(`also shared elsewhere: these X posts had ${n(clicks)} link clicks, so most of the ${n(sig)} X signers came from the link's other uses`);
          sharedElsewhere = true;
        }
      }
      if (row) creditedBySource[srcKey] = row;
    }
    const cRows = Object.values(creditedBySource);
    const credited = e.posts.length && matched
      ? { signatures: sumOf(cRows, 'signatures'), new_members: sumOf(cRows, 'new_members'), reactivated_members: sumOf(cRows, 'reactivated_members') }
      : { signatures: null, new_members: null, reactivated_members: null };

    if (madeFor && e.posts.length && !postedSources.includes(madeFor)) {
      flags.push(`link made for ${SOURCE_LABEL[madeFor] || madeFor} (${String(e.series || madeFor).toUpperCase()}), posted on ${postedSources.map((x) => SOURCE_LABEL[x] || x).join(' and ')}: its ${SOURCE_LABEL[madeFor] || madeFor} signers are not credited to these posts`);
    }
    const borrowed = [...new Set(e.posts.filter((p) => usualOwner.get(p.account_id) && e.owner && usualOwner.get(p.account_id) !== e.owner).map((p) => p.account_label || p.account_id))];
    if (borrowed.length) {
      flags.push(`also shared elsewhere: link made by ${String(e.owner).toUpperCase()}, not ${borrowed.join(', ')}, so its figures include everyone who used it`);
      sharedElsewhere = true;
    }

    out.push({ ...e, matched, ...all, credited, creditedBySource, sharedElsewhere,
      other_uses: matched && credited.signatures !== null ? all.signatures - credited.signatures : all.signatures, flags });
  }
  out.sort((a, b) => ((b.credited.signatures ?? -1) - (a.credited.signatures ?? -1)) || ((b.signatures || 0) - (a.signatures || 0)) || String(b.code).localeCompare(a.code));
  return { codes: out, untraced };
}

// Totals per account / owner / petition.
//   account: the signers who arrived from that account's own posts'
//            platform, with how many of them came through links also shared
//            elsewhere (so a reused link is visible, not hidden). A code posted
//            by two accounts on the same platform counts for both (said so).
//   owner / petition: every use of the links (who made them, what for).
function groupBy(codes, key) {
  const g = new Map();
  const bump = (k, sig, nw, re, posts, unmatched) => {
    if (!g.has(k)) g.set(k, { key: k, codes: 0, posts: 0, signatures: 0, new_members: 0, reactivated_members: 0, unmatched: 0, shared_signatures: 0 });
    const t = g.get(k);
    t.codes++; t.posts += posts; if (unmatched) t.unmatched++;
    t.signatures += sig || 0; t.new_members += nw || 0; t.reactivated_members += re || 0;
    return t;
  };
  for (const c of codes) {
    if (key !== 'account') { bump(c[key] || '(none)', c.signatures, c.new_members, c.reactivated_members, c.posts.length, !c.matched); continue; }
    if (!c.posts.length) { bump('(not seen in a post)', c.signatures, c.new_members, c.reactivated_members, 0, !c.matched); continue; }
    const byAcct = new Map();
    for (const p of c.posts) {
      const k = `${PLATFORM_LABEL[p.platform] || p.platform} ${p.account_label || p.account_id}`;
      if (!byAcct.has(k)) byAcct.set(k, { posts: 0, sources: new Set() });
      const a = byAcct.get(k); a.posts++; a.sources.add(PLATFORM_SOURCE[p.platform]);
    }
    for (const [k, a] of byAcct) {
      const rows = [...a.sources].map((x) => c.creditedBySource[x]).filter(Boolean);
      const sum = (f) => rows.reduce((t, r) => t + (Number(r[f]) || 0), 0);
      const t = bump(k, sum('signatures'), sum('new_members'), sum('reactivated_members'), a.posts, !c.matched);
      if (c.sharedElsewhere) t.shared_signatures += sum('signatures');
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
  const xIds = posts.filter((p) => p.platform === 'x' && p.campaign_code).map((p) => p.post_id);
  const reach = new Map((store.linkPostReach && xIds.length ? await store.linkPostReach({ xPostIds: xIds }) : []).map((r) => [String(r.post_id), r]));
  const fresh = await store.linkFreshness();
  const { codes: rows, untraced } = aggregate(posts, sigs, { includeUnposted, reach });

  const who = [account && `account "${account}"`, own && `links made by ${own.toUpperCase()}`, pet && `petition ${pet}`, campaign && `codes containing "${campaign}"`, platform && PLATFORM_LABEL[platform]].filter(Boolean).join(', ');
  const title = `**Link performance${who ? ` · ${who}` : ''}, ${w.label}**`;
  if (!rows.length && !untraced.length) {
    return { text: `${title}\n\nNo tracked CitizenGO links found.${fresh.registryAt ? '' : ' The link registry has not been built yet.'}` };
  }
  const sumAll = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const sumCred = (k) => rows.reduce((a, r) => a + (r.credited[k] || 0), 0);
  const notes = [];
  notes.push(`Figures come from Looker (Bluebook signatures by utm_campaign), all time for each code${fresh.pulledAt ? `, pulled ${String(fresh.pulledAt).slice(0, 16).replace('T', ' ')} UTC` : ' — **not pulled yet, so every figure is blank**'}. A code is a link, and one link can be used in many places. "From these posts" counts only signers who arrived from the platform each post is on (an X post gets X arrivals); "Other uses" is everything else the link brought: WhatsApp shares, and the link in other posts, ads, bios, Stories or DMs.`);
  const flagged = rows.filter((r) => r.flags.length).length;
  if (flagged) notes.push(`${n(flagged)} code(s) carry a note (⚠). "Also shared elsewhere" means the post did carry the link, but the same link was used in other places too, so most of its signers came from those: say so when quoting the number.`);
  const unmatched = rows.filter((r) => !r.matched).length;
  if (unmatched) notes.push(`${n(unmatched)} code(s) have no signatures recorded in Looker yet (shown as —): too new, no signers, or the code was changed after the link was made.`);
  const donation = rows.filter((r) => /-(md|otd)_[a-z]+-/.test(r.code)).length;
  if (donation) notes.push(`${n(donation)} code(s) are donation-form links (MD/OTD): this tool counts signatures, not donations, so they show none.`);
  if (untraced.length) notes.push(`${n(untraced.length)} post link(s) carried no campaign code (a plain petition link or an unresolved short link), so their signatures cannot be traced. Make links in Campaign Copilot.`);
  notes.push('Posts are what the connector collects: Facebook first comments, Stories and DMs are not posts here; with include_unposted their codes still count under "Other uses".');

  let body;
  if (group_by !== 'link') {
    const key = group_by === 'owner' ? 'owner' : group_by === 'petition' ? 'petition_id' : 'account';
    const g = groupBy(rows, key);
    const isAcct = key === 'account';
    body = table([isAcct ? 'Account' : key === 'owner' ? 'Made by' : 'Petition', 'Codes', 'Posts', isAcct ? 'Signatures from its posts' : 'Signatures (every use)', 'New members', 'Reactivated', ...(isAcct ? ['…of which via links also shared elsewhere'] : [])],
      g.map((t) => [cell(key === 'owner' ? String(t.key).toUpperCase() : t.key, 50), n(t.codes), n(t.posts), n(t.signatures), n(t.new_members), n(t.reactivated_members), ...(isAcct ? [t.shared_signatures ? `⚠ ${n(t.shared_signatures)}` : '0'] : [])]));
    if (isAcct) notes.push('Account totals count signers who arrived from the platform of that account\'s own posts. The last column shows how many of them came through links that were also shared elsewhere (someone else\'s link, or more signers than the posts could reach): the post carried the link, but most of those signers came from its other uses. A code posted by more than one account on the same platform counts for each.');
  } else {
    const off = Math.max(Number(offset) || 0, 0);
    const page = rows.slice(off, off + clampRows(limit, 50));
    body = table(['Campaign code', 'Posted', 'From these posts', 'New', 'Reactivated', 'Other uses', 'Notes'], page.map((r) => {
      const where = r.posts.length
        ? r.posts.slice(0, 3).map((p) => `${p.permalink_url ? `[${cell(`${PLATFORM_LABEL[p.platform]} ${p.account_label || ''} ${String(p.posted_at).slice(0, 10)}`, 40)}](${p.permalink_url})` : cell(`${PLATFORM_LABEL[p.platform]} ${p.account_label || ''}`, 40)}`).join('<br>') + (r.posts.length > 3 ? `<br>+${r.posts.length - 3} more` : '')
        : '_not in a post_';
      return [cell(r.code, 80), where, n(r.credited.signatures), n(r.credited.new_members), n(r.credited.reactivated_members), n(r.other_uses), r.flags.length ? cell('⚠ ' + r.flags.join('; '), 220) : ''];
    })) + xt.pageNote(off, page.length, rows.length, 'Codes').replace('x_period_summary', 'group_by');
  }
  const sharedSig = rows.filter((r) => r.sharedElsewhere).reduce((a, r) => a + (r.credited.signatures || 0), 0);
  const head = `${title}\n\n${n(rows.length)} campaign codes · **${n(sumCred('signatures'))} signatures from these posts** (${n(sumCred('new_members'))} new members, ${n(sumCred('reactivated_members'))} reactivated)`
    + `${sharedSig ? `, of which ${n(sharedSig)} via links also shared elsewhere ⚠` : ''} · ${n(sumAll('signatures'))} from every use of these links\n\n`;
  return { text: head + body + '\n\n' + notes.map((x) => `_${x}_`).join('\n\n'), rows, untraced: untraced.length };
}

// Instagram accounts connected by their holders (sql/ig-schema.sql), e.g. a
// spokesperson's professional account. Their posts are collected only when they
// link to or mention CitizenGO, so totals describe those posts.
async function igConnectedPosts(store, args = {}) {
  const w = xt.windowFor({ month: args.month, from: args.from, to: args.to, days: args.days }, 90);
  if (w.error) return { text: w.error };
  const accounts = await store.igConnectedAccounts();
  if (!accounts.length) return { text: 'No Instagram accounts have been connected by their holders yet. A holder shares the account with CitizenGO\'s Business Manager as a partner (Insights access), then the "Instagram partner account" workflow registers it.' };
  const off = Math.max(Number(args.offset) || 0, 0);
  const rows = await store.igConnectedPosts({ account: args.account, since: w.since, until: w.until, order: args.sort, limit: clampRows(args.limit, 25), offset: off });
  const acctLines = accounts.map((a) => {
    const t = a.token;
    const state = !a.is_active ? 'disconnected' : a.access === 'partner' ? `shared with our Business Manager (partner access), last read ${String(a.last_seen_at || '').slice(0, 10) || 'not yet'}`
      : !t ? 'needs reconnecting (no live token)' : t.last_error ? `token problem: ${t.last_error}` : `connected, token valid to ${String(t.expires_at || '').slice(0, 10)}`;
    return `- **@${a.username}** (${a.label || '—'}, ${a.kind}): ${n(a.followers_count)} followers · ${state}`;
  }).join('\n');
  const body = rows.length ? table(['Account', 'Posted', 'Type', 'Caption', 'Reach', 'Views', 'Likes', 'Comments', 'Shares', 'Saves'], rows.map((r) => [
    `@${cell(r.username, 30)}`, r.permalink ? `[${String(r.timestamp).slice(0, 10)}](${r.permalink})` : String(r.timestamp).slice(0, 10),
    cell(r.media_product_type === 'REELS' ? 'Reel' : (r.media_type || '').toLowerCase().replace('_', ' '), 12), cell(r.caption, 60),
    n(r.reach), n(r.views), n(r.likes), n(r.comments), n(r.shares), n(r.saved)]))
    : '_No posts in this window._';
  const spokes = accounts.some((a) => a.kind === 'spokesperson');
  return { text: `**Connected Instagram accounts**\n\n${acctLines}\n\n**Posts, ${w.label}**\n\n${body}`
    + (rows.length === clampRows(args.limit, 25) ? `\n\n_More posts may follow: call again with offset ${off + rows.length}._` : '')
    + (spokes ? '\n\n_Spokesperson accounts are collected only for posts that link to or mention CitizenGO, so these figures describe those posts, not the whole account. Stories are not collected. For signatures from the links, use link_performance._' : ''), rows };
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
  {
    name: 'ig_connected_posts',
    description: 'Instagram accounts connected by their holders (for example a spokesperson\'s professional account, such as Rocío D\'Angelo\'s), whether each connection is healthy, and their posts with reach, views, likes, comments, shares and saves. Spokesperson accounts only include posts that link to or mention CitizenGO. CitizenGO\'s own Page-linked Instagram accounts are in the other Instagram tools; signatures from links are in link_performance.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Instagram @username or label; partial names match.' },
        days: { type: 'number', description: 'Posts from the last N days (default 90, 0 for all).' },
        month: { type: 'string', description: 'A month, e.g. "2026-09", instead of days.' },
        from: { type: 'string', description: 'Start date (YYYY-MM-DD).' },
        to: { type: 'string', description: 'End date inclusive (YYYY-MM-DD).' },
        sort: { type: 'string', enum: ['timestamp', 'reach', 'views', 'total_interactions', 'shares'], description: 'Newest first (default) or by a metric.' },
        limit: { type: 'number', description: 'Posts per page (default 25, max 200).' },
        offset: { type: 'number', description: 'Where the page starts (0 = first).' },
      },
      additionalProperties: false,
    },
    handler: igConnectedPosts,
  },
];

module.exports = { LINK_TOOLS, aggregate, groupBy, linkPerformance, igConnectedPosts };
