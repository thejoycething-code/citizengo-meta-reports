'use strict';
// Config for the CitizenGO Page Inviter Chrome extension, served from the
// inviter_config table (one row per version; the newest row is live).
//
// The extension holds the words, patterns and page selectors it uses on
// Facebook in this config, so when Facebook changes a page the fix is one edit
// here rather than a reinstall on every campaigner's machine. Every copy of the
// extension calls inviter_config at start-up and hourly, with the same bearer
// token as the reporting tools.
//
//   inviter_config         read. Anyone with a token. The config is words and
//                          CSS selectors - nothing about people or performance.
//   inviter_pages          read. Page IDs and names, nothing else.
//   inviter_posts          read. One Page's recent posts: link, date and reaction
//                          total from the latest snapshot - what the extension
//                          needs to visit only posts with new reactions, and no
//                          more. Views, reach and spend stay behind top_posts.
//   update_inviter_config  WRITE. The only write on the MCP request path, so it
//                          is narrow on purpose: one table, append-only (a new
//                          row per change, nothing updated or deleted), only for
//                          names in INVITER_CONFIG_ADMINS, and every change is
//                          validated against the shape the extension expects
//                          before it is saved. A config the extension cannot use
//                          is refused here rather than discovered by campaigners.

const { shapeFeed } = require('../lib/shape');

// Tokens limited to these tools (the extension's built-in token): if one leaks
// from the extension, it shows post links and reaction counts, not reporting data.
const SCOPED_TOKENS = ['invite-to-like-extension'];
function scopedTokens() {
  const extra = String(process.env.INVITER_SCOPED_TOKENS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return [...SCOPED_TOKENS, ...extra];
}
const isScoped = (who) => !!who && scopedTokens().includes(String(who).toLowerCase());
const toolAllowed = (who, name) => !isScoped(who) || name.startsWith('inviter_') || name === 'update_inviter_config';

const REACTION_KEYS = ['rLike', 'rLove', 'rCare', 'rWow', 'rSad', 'rHaha', 'rAngry'];
const ROUTE_KEYS = ['feed_grid', 'prodash', 'notifications'];
const LIST_KEYS = ['inviteWords', 'closeWords', 'supportedLangs', 'limitPatterns', 'pageLimitPatterns', 'reactSummaryPatterns'];
const PATTERN_LISTS = ['limitPatterns', 'pageLimitPatterns', 'reactSummaryPatterns'];
const SELECTOR_KEYS = ['row', 'toolbar', 'tab', 'dialog', 'alerts', 'limitLink', 'reactionIcon', 'pageIdInHtml'];
// Selector entries that are regular expressions with one capture group, not CSS.
const SELECTOR_PATTERNS = ['reactionIcon', 'pageIdInHtml'];
const TOP_KEYS = ['configVersion', 'minExtensionVersion', 'killSwitch', 'notice', ...LIST_KEYS,
  'postLinkPattern', 'reactions', 'selectors', 'newRowsMargin', 'routes',
  // Optional (added with extension 2.4.0): who campaigners send change requests
  // to, and the pattern that recognises Facebook's default profile picture.
  'maintainerName', 'maintainerEmail', 'defaultAvatarPattern'];

// Who requests are routed to when someone without edit rights asks for a change.
// The config's own maintainer wins; INVITER_CONFIG_CONTACT is the fallback.
function contactFrom(cfg) {
  if (cfg && cfg.maintainerName && cfg.maintainerEmail) return `${cfg.maintainerName} (${cfg.maintainerEmail})`;
  return String(process.env.INVITER_CONFIG_CONTACT || '').trim() || 'whoever maintains the extension';
}

// Names (token holders) and emails (Google sign-ins) allowed to edit. Read per
// request so a change in Vercel needs no code change. Empty means nobody.
function admins() {
  return String(process.env.INVITER_CONFIG_ADMINS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}
const isAdmin = (who) => !!who && admins().includes(String(who).toLowerCase());

function compiles(source, flags = '') {
  try { new RegExp(source, flags); return true; } catch (e) { return false; }
}

// Every problem with a config, as plain sentences. Empty list = valid.
function problems(cfg) {
  const out = [];
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(cfg)) return ['The config must be a JSON object.'];

  for (const k of Object.keys(cfg)) if (!TOP_KEYS.includes(k)) out.push(`"${k}" is not a setting the extension knows.`);

  if (!Number.isInteger(cfg.configVersion) || cfg.configVersion < 1) out.push('configVersion must be a whole number of at least 1.');
  if (typeof cfg.minExtensionVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(cfg.minExtensionVersion)) out.push('minExtensionVersion must look like 2.3.0.');
  if (typeof cfg.killSwitch !== 'boolean') out.push('killSwitch must be true or false.');
  if (typeof cfg.notice !== 'string' || cfg.notice.length > 500) out.push('notice must be text of at most 500 characters.');

  for (const k of LIST_KEYS) {
    const v = cfg[k];
    if (!Array.isArray(v) || !v.length) { out.push(`${k} must be a non-empty list.`); continue; }
    if (v.length > 300) out.push(`${k} has ${v.length} entries; the limit is 300.`);
    if (v.some((s) => typeof s !== 'string' || !s.trim() || s.length > 200)) out.push(`Every entry in ${k} must be non-empty text of at most 200 characters.`);
  }
  for (const k of PATTERN_LISTS) {
    if (!Array.isArray(cfg[k])) continue;
    for (const s of cfg[k]) if (typeof s === 'string' && !compiles(s, 'i')) out.push(`${k}: "${s}" is not a valid pattern.`);
  }
  if (typeof cfg.postLinkPattern !== 'string' || !compiles(cfg.postLinkPattern)) out.push('postLinkPattern must be a valid pattern.');

  if (!isObj(cfg.reactions) || !Object.keys(cfg.reactions).length) out.push('reactions must map reaction IDs to reaction names.');
  else {
    for (const [id, key] of Object.entries(cfg.reactions)) {
      if (!/^\d{5,25}$/.test(id)) out.push(`reactions: "${id}" is not a numeric Facebook reaction ID.`);
      if (!REACTION_KEYS.includes(key)) out.push(`reactions: "${key}" must be one of ${REACTION_KEYS.join(', ')}.`);
    }
  }

  if (!isObj(cfg.selectors)) out.push('selectors must be an object.');
  else {
    for (const k of SELECTOR_KEYS) {
      const v = cfg.selectors[k];
      if (typeof v !== 'string' || !v.trim() || v.length > 300) out.push(`selectors.${k} must be non-empty text of at most 300 characters.`);
    }
    for (const k of Object.keys(cfg.selectors)) if (!SELECTOR_KEYS.includes(k)) out.push(`selectors.${k} is not a selector the extension uses.`);
    for (const k of SELECTOR_PATTERNS) {
      const v = cfg.selectors[k];
      if (typeof v === 'string' && (!compiles(v) || new RegExp(`${v}|`).exec('').length < 2)) out.push(`selectors.${k} must be a valid pattern with one (capturing group).`);
    }
  }

  if (typeof cfg.newRowsMargin !== 'number' || cfg.newRowsMargin < 0 || cfg.newRowsMargin > 100) out.push('newRowsMargin must be a number from 0 to 100.');

  // Optional keys: checked only when present, so configs saved before they existed stay valid.
  if ('maintainerName' in cfg && (typeof cfg.maintainerName !== 'string' || !cfg.maintainerName.trim() || cfg.maintainerName.length > 100)) out.push('maintainerName must be a name of at most 100 characters.');
  if ('maintainerEmail' in cfg && (typeof cfg.maintainerEmail !== 'string' || !/^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(cfg.maintainerEmail))) out.push('maintainerEmail must be an email address.');
  if ('defaultAvatarPattern' in cfg && (typeof cfg.defaultAvatarPattern !== 'string' || !cfg.defaultAvatarPattern || !compiles(cfg.defaultAvatarPattern))) out.push('defaultAvatarPattern must be a valid pattern.');

  if (!isObj(cfg.routes)) out.push('routes must be an object.');
  else {
    for (const k of Object.keys(cfg.routes)) if (!ROUTE_KEYS.includes(k)) out.push(`routes.${k} is not a route the extension has.`);
    for (const k of ROUTE_KEYS) {
      const r = cfg.routes[k];
      if (!isObj(r)) { out.push(`routes.${k} must have a url and a match.`); continue; }
      // Facebook addresses only: the extension opens these in campaigners' browsers.
      let host = '';
      try { host = new URL(String(r.url).replace('{pageId}', '1')).hostname; } catch (e) { /* reported below */ }
      if (!/^(www|web|business)\.facebook\.com$/.test(host) || !String(r.url).startsWith('https://')) out.push(`routes.${k}.url must be an https address on facebook.com.`);
      if (typeof r.match !== 'string' || !compiles(r.match)) out.push(`routes.${k}.match must be a valid pattern.`);
    }
  }
  return out;
}

// Applies { set, add, remove } to a copy of the config.
//   set    - replace whole settings; for reactions, selectors and routes, only the named entries.
//   add    - append to word/pattern lists (duplicates ignored).
//   remove - take entries out of word/pattern lists.
function applyChanges(base, { set = {}, add = {}, remove = {} }) {
  const cfg = JSON.parse(JSON.stringify(base));
  const errors = [];
  const unknown = (k) => !TOP_KEYS.includes(k) && errors.push(`"${k}" is not a setting the extension knows.`);
  for (const [k, v] of Object.entries(set || {})) {
    if (unknown(k)) continue;
    if (k === 'configVersion') { errors.push('configVersion is set automatically.'); continue; }
    if (['reactions', 'selectors', 'routes'].includes(k) && v && typeof v === 'object' && !Array.isArray(v)) {
      cfg[k] = { ...(cfg[k] || {}), ...v };
      if (k === 'routes') for (const [rk, rv] of Object.entries(v)) cfg.routes[rk] = { ...((base.routes || {})[rk] || {}), ...rv };
    } else cfg[k] = v;
  }
  for (const [k, v] of Object.entries(add || {})) {
    if (unknown(k)) continue;
    if (!LIST_KEYS.includes(k) || !Array.isArray(v)) { errors.push(`add only works on lists (${LIST_KEYS.join(', ')}).`); continue; }
    const have = new Set((cfg[k] || []).map((s) => String(s).toLowerCase()));
    cfg[k] = [...(cfg[k] || []), ...v.filter((s) => !have.has(String(s).toLowerCase()))];
  }
  for (const [k, v] of Object.entries(remove || {})) {
    if (unknown(k)) continue;
    if (!LIST_KEYS.includes(k) || !Array.isArray(v)) { errors.push(`remove only works on lists (${LIST_KEYS.join(', ')}).`); continue; }
    const drop = new Set(v.map((s) => String(s).toLowerCase()));
    cfg[k] = (cfg[k] || []).filter((s) => !drop.has(String(s).toLowerCase()));
  }
  return { cfg, errors };
}

// One line per setting that changed, readable by a person.
function describeDiff(before, after) {
  const lines = [];
  const show = (v) => (typeof v === 'string' ? `"${v}"` : JSON.stringify(v));
  for (const k of TOP_KEYS) {
    if (k === 'configVersion') continue;
    const a = before ? before[k] : undefined; const b = after[k];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (Array.isArray(a) && Array.isArray(b)) {
      const added = b.filter((x) => !a.includes(x)); const gone = a.filter((x) => !b.includes(x));
      lines.push(`- **${k}**:${added.length ? ` added ${added.map(show).join(', ')}` : ''}${gone.length ? `${added.length ? ';' : ''} removed ${gone.map(show).join(', ')}` : ''}`);
    } else if (a && b && typeof a === 'object' && typeof b === 'object') {
      for (const sk of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (JSON.stringify(a[sk]) !== JSON.stringify(b[sk])) lines.push(`- **${k}.${sk}**: ${show(a[sk])} → ${show(b[sk])}`);
      }
    } else lines.push(`- **${k}**: ${show(a)} → ${show(b)}`);
  }
  return lines;
}

const when = (iso) => (iso ? new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');

async function readConfig(store, args) {
  if (args.history) {
    const rows = await store.inviterConfigs(Math.min(50, Number(args.limit) || 10));
    if (!rows.length) return { text: 'No inviter config has been saved yet.', raw: true };
    const lines = rows.map((r, i) => `| ${r.id}${i === 0 ? ' (live)' : ''} | ${(r.config && r.config.configVersion) || '—'} | ${when(r.updated_at)} | ${String(r.note || '').replace(/\|/g, '/')} |`);
    return {
      text: '**Page Inviter config history** (newest first)\n\n| Row | Version | Saved | Note |\n| --- | --- | --- | --- |\n'
        + lines.join('\n') + '\n\n_To go back to an earlier version, call update_inviter_config with revert_to set to its Row number._',
      raw: true,
    };
  }
  const [row] = await store.inviterConfigs(1);
  if (!row) return { text: 'null', raw: true, structured: { config: null } };
  // Bare JSON: the extension parses this text. No banner, no prose.
  return {
    text: JSON.stringify(row.config),
    raw: true,
    structured: { config: row.config, row: row.id, updated_at: row.updated_at },
  };
}

async function updateConfig(store, args, ctx = {}) {
  if (!isAdmin(ctx.who)) {
    // Route the request rather than just refusing it.
    let contact = contactFrom(null);
    try { const [row] = await store.inviterConfigs(1); contact = contactFrom(row && row.config); } catch (e) { /* fallback contact */ }
    return {
      text: admins().length
        ? `Only ${contact} can change the Page Inviter config. Send the request to them: what you want changed and why — for a Facebook change, which page it was on and a screenshot. Nothing was changed.`
        : `Nobody can change the Page Inviter config yet: set INVITER_CONFIG_ADMINS in Vercel. Requests go to ${contact} in the meantime.`,
      raw: true,
      isError: true,
    };
  }
  const note = String(args.note || '').trim();
  if (!note) return { text: 'Say what the change is for in `note`, e.g. "Facebook renamed the Polish Invite button". It goes in the history.', raw: true, isError: true };

  const [live] = await store.inviterConfigs(1);
  let next; let label;
  if (args.revert_to !== undefined) {
    const old = await store.inviterConfigById(args.revert_to);
    if (!old) return { text: `There is no config row ${args.revert_to}. Call inviter_config with history: true to see the rows.`, raw: true, isError: true };
    next = JSON.parse(JSON.stringify(old.config));
    label = `Revert to row ${old.id}`;
  } else {
    if (!live) return { text: 'There is no config to change yet.', raw: true, isError: true };
    const { cfg, errors } = applyChanges(live.config, { set: args.set, add: args.add, remove: args.remove });
    if (errors.length) return { text: `Nothing saved:\n${errors.map((e) => `- ${e}`).join('\n')}`, raw: true, isError: true };
    next = cfg;
    label = 'Change';
  }
  next.configVersion = ((live && live.config && live.config.configVersion) || 0) + 1;

  const bad = problems(next);
  if (bad.length) return { text: `Nothing saved — the result would break the extension:\n${bad.map((e) => `- ${e}`).join('\n')}`, raw: true, isError: true };

  const diff = describeDiff(live && live.config, next);
  if (!diff.length) return { text: 'That would not change anything, so nothing was saved.', raw: true };

  if (args.dry_run) {
    return { text: `**Preview — not saved.** ${label} would make config version ${next.configVersion}:\n\n${diff.join('\n')}`, raw: true };
  }
  const saved = await store.insertInviterConfig({ config: next, note: `${note} — ${ctx.who}` });
  return {
    text: `**Saved config version ${next.configVersion}** (row ${saved.id}). ${label}:\n\n${diff.join('\n')}\n\n`
      + 'Every copy of the extension picks this up within the hour, or straight away from Settings → Check for config updates.',
    raw: true,
    structured: { row: saved.id, configVersion: next.configVersion },
  };
}

async function invitePages(store) {
  const { pages } = await store.loadAll();
  const rows = pages.filter((p) => p.is_active !== false && (p.platform || 'facebook') === 'facebook')
    .map((p) => ({ page_id: p.page_id, name: p.name }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { text: JSON.stringify({ pages: rows }), raw: true, structured: { pages: rows } };
}

async function invitePosts(store, args) {
  const pageId = String(args.page_id || '');
  if (!/^\d{5,25}$/.test(pageId)) return { text: 'page_id must be a numeric Page ID (see inviter_pages).', raw: true, isError: true };
  const days = Math.min(365, Math.max(1, Math.floor(Number(args.days)) || 60));
  const data = await store.loadAll();
  if (!data.pages.some((p) => p.page_id === pageId)) {
    return { text: JSON.stringify({ page_id: pageId, collected: false, posts: [] }), raw: true, structured: { page_id: pageId, collected: false, posts: [] } };
  }
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const posts = shapeFeed(data, { page_id: pageId, since, sort: 'recent', with_metrics_only: false }).rows
    .filter((r) => r.permalink_url)
    .map((r) => ({ post_id: r.post_id, permalink_url: r.permalink_url, created_time: r.created_time, reactions_total: r.reactions_total, collected_date: r.collected_date }));
  const out = { page_id: pageId, collected: true, days, posts };
  return { text: JSON.stringify(out), raw: true, structured: out };
}

const LIST_SCHEMA = (verb) => ({
  type: 'object',
  description: `Lists to ${verb}, e.g. {"inviteWords": ["Zaproś do polubienia"]}. Works on: ${LIST_KEYS.join(', ')}.`,
  additionalProperties: { type: 'array', items: { type: 'string' } },
});

const INVITER_TOOLS = [
  {
    name: 'inviter_pages',
    description: 'For the CitizenGO Page Inviter extension: the Facebook Pages being collected, as JSON with page_id and name only. For performance data use list_pages.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (store) => invitePages(store),
  },
  {
    name: 'inviter_posts',
    description: 'For the CitizenGO Page Inviter extension: one Page\'s posts from the last N days as JSON — link, date and latest reaction total only — so it can visit only posts with new reactions. For performance data use top_posts.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'The Page (see inviter_pages).' },
        days: { type: 'number', description: 'Posts from the last N days (default 60, max 365).' },
      },
      required: ['page_id'],
      additionalProperties: false,
    },
    handler: (store, args) => invitePosts(store, args),
  },
  {
    name: 'inviter_config',
    description: 'The live config of the CitizenGO Page Inviter Chrome extension: the words, patterns and Facebook page selectors it uses, plus its notice, kill switch and minimum version. Returns JSON. Set history: true to list earlier versions with who changed what.',
    inputSchema: {
      type: 'object',
      properties: {
        history: { type: 'boolean', description: 'List saved versions (newest first) instead of returning the live config.' },
        limit: { type: 'number', description: 'With history: how many versions to list (default 10, max 50).' },
      },
      additionalProperties: false,
    },
    handler: (store, args) => readConfig(store, args),
  },
  {
    name: 'update_inviter_config',
    description: 'Change the CitizenGO Page Inviter extension config, for every campaigner at once (they pick it up within the hour). Maintainers only. Use when Facebook renames a button or changes a page ("add the Polish word for Invite"), to show everyone a notice, to pause all inviting (set killSwitch true), to require a newer extension version, or to revert to an earlier version. Every change is checked before it is saved and kept in the history. Use dry_run first to preview.',
    inputSchema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'Required. Why the change is being made; recorded in the history.' },
        set: { type: 'object', description: 'Settings to replace, e.g. {"notice": "Facebook is limiting invites this week", "killSwitch": true}. For reactions, selectors and routes, only the entries named are replaced.' },
        add: LIST_SCHEMA('add to'),
        remove: LIST_SCHEMA('remove from'),
        revert_to: { type: 'number', description: 'Make an earlier version live again, by its Row number from inviter_config history. Ignores set/add/remove.' },
        dry_run: { type: 'boolean', description: 'Preview the change without saving it.' },
      },
      required: ['note'],
      additionalProperties: false,
    },
    handler: (store, args, ctx) => updateConfig(store, args, ctx),
  },
];

module.exports = { INVITER_TOOLS, problems, applyChanges, describeDiff, isAdmin, isScoped, toolAllowed };
