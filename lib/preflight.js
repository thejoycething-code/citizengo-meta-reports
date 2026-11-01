'use strict';
// Go-live preflight for the Content Engine (docs/content-engine-golive.md).
// Pure: takes what scripts/engine-preflight.js read and says, in plain words,
// what is ready, what isn't and what to do next. Reads only; changes nothing.

const OK = 'ok', TODO = 'todo', INFO = 'info';

function check({ connectStatus, teams, rights, tokens, scheduled, pauses, automations, queued, env, plists, now = Date.now() }) {
  const out = [];
  const add = (state, title, detail, next) => out.push({ state, title, detail, next: next || null });

  add(connectStatus === 503 ? TODO : connectStatus >= 200 && connectStatus < 500 ? OK : TODO, 'Connect Facebook switched on',
    connectStatus === 503 ? 'The server answers "not configured": FB_APP_ID, FB_APP_SECRET and FB_REDIRECT_URI aren\'t set in Vercel.' : `The connect page answers HTTP ${connectStatus}.`,
    connectStatus === 503 ? 'Set up Facebook Login on the Meta app with the inbox permissions, add the three FB_* settings in Vercel, redeploy (Asana task).' : null);

  const metaAccounts = teams.flatMap((t) => (t.accounts || []).filter((a) => a.platform === 'facebook' || a.platform === 'instagram').map((a) => ({ team: t.id, ...a })));
  const withToken = new Set(tokens.map((t) => t.account_key));
  const missing = metaAccounts.filter((a) => !withToken.has(a.key)).map((a) => a.key);
  add(missing.length ? TODO : OK, 'Every Facebook and Instagram account has a connected person',
    `${metaAccounts.length - missing.length} of ${metaAccounts.length} accounts have someone's Page token${missing.length ? `; missing: ${missing.join(', ')}` : ''}.`,
    missing.length ? 'Someone with a Page role on each presses Connect Facebook on the desk.' : null);

  const maint = rights.filter((r) => r.source === 'maintainer');
  add(maint.length ? INFO : OK, 'Publishing rights come from Facebook, not by hand',
    maint.length ? `${maint.length} right${maint.length === 1 ? '' : 's'} still seeded by hand (${[...new Set(maint.map((r) => r.who))].join(', ')}). They let people approve, but the publisher can only post with a connected token.` : 'All rights come from Connect Facebook.',
    maint.length ? 'Once people have connected, the hand-seeded rights can be removed.' : null);

  const week = now + 7 * 864e5;
  const soon = scheduled.filter((p) => p.post_at && Date.parse(p.post_at) <= week);
  const unready = soon.filter((p) => { const f = (p.doc && p.doc.final) || {}; return !(f.facebook || f.instagram) && (p.doc && p.doc.posting && (p.doc.posting.destinations || []).some((k) => /-(fb|ig)$/.test(k))); });
  add(unready.length ? TODO : OK, 'Scheduled posts have their final snapshot',
    `${soon.length} post${soon.length === 1 ? '' : 's'} scheduled in the next 7 days${unready.length ? `; ${unready.length} without the snapshot the publisher posts (${unready.map((p) => p.id).slice(0, 5).join(', ')})` : ''}.`,
    unready.length ? 'Open each on the desk and press "Update where and when", or approve it again.' : null);

  const open = pauses.filter((p) => !p.resumed_at && (!p.until || Date.parse(p.until) > now));
  add(open.length ? INFO : OK, 'No pause in force', open.length ? `${open.length} pause${open.length === 1 ? '' : 's'} on: ${open.map((p) => `${p.reason} (by ${p.paused_by})`).join('; ')}.` : 'Publishing is not paused.', open.length ? 'Resume from the Calendar when ready.' : null);

  const active = automations.filter((a) => a.active);
  add(INFO, 'Automations and queued Inbox actions', `${active.length} active automation${active.length === 1 ? '' : 's'}; ${queued.length} Inbox action${queued.length === 1 ? '' : 's'} queued.`,
    queued.length ? 'Queued actions go out the moment Inbox live mode is on: check them in Moderation first, and undo any that are stale.' : null);

  if (env) {
    const pubLive = env.ENGINE_PUBLISH_LIVE === '1' && plists.publisher && !/--dry-run/.test(plists.publisher);
    const ibLive = env.ENGINE_INBOX_LIVE === '1' && plists.inbox && !/--dry-run/.test(plists.inbox);
    add(INFO, 'Publisher on this Mini', pubLive ? 'LIVE: it posts scheduled posts.' : `Dry run (${env.ENGINE_PUBLISH_LIVE === '1' ? 'the job still passes --dry-run' : 'ENGINE_PUBLISH_LIVE is not 1'}).`, pubLive ? null : 'With Chris\'s OK: set ENGINE_PUBLISH_LIVE=1 in ~/runner/meta-reports/.env and reinstall the plist without --dry-run.');
    add(INFO, 'Inbox sender on this Mini', ibLive ? 'LIVE: it sends replies, hides, deletes and automations.' : `Dry run (${env.ENGINE_INBOX_LIVE === '1' ? 'the job still passes --dry-run' : 'ENGINE_INBOX_LIVE is not 1'}).`, ibLive ? null : 'With Chris\'s OK: set ENGINE_INBOX_LIVE=1 and reinstall that plist without --dry-run.');
    add(env.ENGINE_TOKEN_PRIVATE_KEY ? OK : TODO, 'The key that opens Page tokens is on this machine', env.ENGINE_TOKEN_PRIVATE_KEY ? 'ENGINE_TOKEN_PRIVATE_KEY is set.' : 'ENGINE_TOKEN_PRIVATE_KEY is missing here (it lives only on the Mini).', null);
  }
  return out;
}

function render(items) {
  const mark = { ok: '✓', todo: '✗', info: '·' };
  const lines = items.map((i) => `${mark[i.state]} ${i.title}\n    ${i.detail}${i.next ? `\n    → ${i.next}` : ''}`);
  const todo = items.filter((i) => i.state === TODO).length;
  return `Content Engine go-live preflight\n\n${lines.join('\n\n')}\n\n${todo ? `${todo} thing${todo === 1 ? '' : 's'} to do before going live.` : 'Nothing blocking: ready for the go-live steps in docs/content-engine-golive.md.'}`;
}

module.exports = { check, render, OK, TODO, INFO };
