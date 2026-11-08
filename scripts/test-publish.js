#!/usr/bin/env node
'use strict';
// These tests cover the engine publishing itself; hand-off mode has its own (test-handoff.js).
process.env.ENGINE_HANDOFF_MODE = '0';
// The Content Engine publisher (collector/publish.js, lib/publish.js) against
// an in-memory engine and a fake Facebook: a dry run changes nothing; a live
// run publishes each due Facebook and Instagram destination once, with the
// approver's sealed Page token and the first comment; X is left for a person;
// and every reason to hold back is reported instead of published.
// Usage: node scripts/test-publish.js

const xauth = require('../lib/xauth');
const E = require('../lib/engine');
const P = require('../lib/publish');
const { run } = require('../collector/publish');
const { ENGINE_TOOLS } = require('../mcp/engine-tools');

let passed = 0, failed = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${name}`); passed++; } else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failed++; }
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const keys = xauth.generateKeyPair();
const NOW = Date.parse('2026-11-03T14:05:00Z');

function engine() {
  const db = {
    teams: [{ id: 'uk', name: 'United Kingdom', accounts: [{ key: 'uk-fb', platform: 'facebook', page_id: '105' }, { key: 'uk-ig', platform: 'instagram', ig_id: '178' }, { key: 'uk-x', platform: 'x' }, { key: 'sc-fb', platform: 'facebook', page_id: '120' }] }],
    rights: [{ who: 'chris', account_key: 'uk-fb', source: 'meta' }, { who: 'chris', account_key: 'uk-ig', source: 'meta' }, { who: 'chris', account_key: 'sc-fb', source: 'maintainer' }],
    tokens: [{ who: 'chris', account_key: 'uk-fb', page_id: '105', ig_id: '178', sealed: xauth.seal(keys.publicKey, 'PAGE-TOKEN') }, { who: 'chris', account_key: 'uk-ig', page_id: '105', ig_id: '178', sealed: xauth.seal(keys.publicKey, 'PAGE-TOKEN') }],
    posts: [], events: [], media: {},
  };
  return {
    db,
    async engineTeams() { return clone(db.teams); },
    async enginePosts({ statuses } = {}) { return clone(db.posts.filter((p) => !statuses || statuses.includes(p.status))); },
    async enginePost(id) { const p = db.posts.find((x) => x.id === id); return p ? clone(p) : null; },
    async engineUpdatePost(id, version, fields) { const p = db.posts.find((x) => x.id === id && x.version === version); if (!p) return null; Object.assign(p, fields, { version: version + 1 }); return clone(p); },
    async engineEvent(row) { db.events.push(row); },
    async enginePauses() { return clone(db.pauses || []); },
    async engineRights({ who }) { return clone(db.rights.filter((r) => r.who === who)); },
    async enginePageToken({ who, account_key }) { return clone(db.tokens.find((t) => t.who === who && t.account_key === account_key) || null); },
    async engineMediaUrl(path) { return path in db.media || path.startsWith('uk/') ? `https://db.example/signed/${path}?token=t` : null; },
    async engineMediaUpload(path, buf) { db.media[path] = buf.length; return path; },
    async engineMembers({ who }) { return who === 'chris' ? [{ team_id: 'uk', who: 'chris', role: 'admin' }] : []; },
  };
}
const final = { facebook: { text: 'Pray with us. https://cgo.ac/x', comment: 'Sign here: https://cgo.ac/y', media: ['uk/p1/facebook-0-aa.jpg'] }, instagram: { text: 'Pray with us. Link in bio', comment: '', media: ['uk/p1/instagram-0-aa.jpg', 'uk/p1/instagram-1-bb.jpg'] } };
const approved = { action: 'approve', by: 'chris', at: '2026-11-02T10:00:00Z' };
function addPost(store, id, doc, status = 'scheduled') { store.db.posts.push({ id, team_id: 'uk', status, version: 1, doc: clone(doc), post_at: E.postAt(doc) }); }

function fakeFacebook() {
  const calls = [];
  const fetchImpl = async (u, opts = {}) => {
    const url = new URL(u);
    const params = Object.fromEntries(new URLSearchParams(opts.body || url.search));
    calls.push({ method: opts.method || 'GET', path: url.pathname.replace(/^\/v[\d.]+\//, ''), params });
    const ok = (b) => ({ ok: true, status: 200, json: async () => b });
    const p = url.pathname;
    if (params.access_token !== 'PAGE-TOKEN') return { ok: false, status: 400, json: async () => ({ error: { message: 'Invalid OAuth access token' } }) };
    if (p.endsWith('/105/photos')) return ok(params.published === 'false' ? { id: `ph${calls.length}` } : { id: 'ph1', post_id: '105_900' });
    if (p.endsWith('/105/feed')) return ok({ id: '105_901' });
    if (p.endsWith('/comments')) return ok({ id: 'c1' });
    if (p.endsWith('/178/media')) return ok({ id: `cont${calls.length}` });
    if (p.endsWith('/178/media_publish')) return ok({ id: 'ig555' });
    if (p.endsWith('/ig555')) return ok({ permalink: 'https://www.instagram.com/p/abc/' });
    return { ok: false, status: 404, json: async () => ({ error: { message: `no route ${p}` } }) };
  };
  return { calls, fetchImpl };
}
const quiet = () => {};

(async () => {
  // What is due.
  const s0 = engine();
  addPost(s0, 'p1', { review: approved, final, posting: { destinations: ['uk-fb', 'uk-ig', 'uk-x'], at: '2026-11-03T14:00:00Z', times: { 'uk-ig': '2026-11-03T18:00:00Z' } } });
  addPost(s0, 'p2', { review: approved, final, posting: { destinations: ['uk-fb'], at: '2026-11-04T14:00:00Z' } });
  addPost(s0, 'p3', { review: approved, final, posting: { destinations: ['uk-fb'], at: '2026-11-03T14:00:00Z' } }, 'hold');
  eq('plan: only scheduled posts, only Meta accounts whose own time has come', P.plan(await s0.enginePosts(), s0.db.teams, NOW).map((i) => [i.post.id, i.key, i.action]), [['p1', 'uk-fb', 'publish']]);
  eq('content: nothing without the approved snapshot', P.contentFor({}, 'facebook').ok, false);
  eq('content: Instagram needs an image', P.contentFor({ final: { instagram: { text: 'x', media: [] } } }, 'instagram').ok, false);

  // Dry run.
  const fb0 = fakeFacebook();
  const t0 = await run({ store: s0, privateKey: keys.privateKey, live: false, now: NOW, log: quiet, fetchImpl: fb0.fetchImpl });
  eq('dry run: says what it would publish, calls nothing, changes nothing', [t0.would, fb0.calls.length, s0.db.posts[0].version, s0.db.events.length], [1, 0, 1, 0]);

  // Videos: pieces joined and checked on the Mini, then straight to Meta.
  {
    const crypto = require('crypto');
    const file = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), crypto.randomBytes(5000)]);
    const sha = crypto.createHash('sha256').update(file).digest('hex');
    const video = { prefix: 'uk/pv/video-abcdefgh', parts: 3, size: file.length, sha256: sha, mime: 'video/mp4' };
    const sv = engine();
    const pieces = [file.slice(0, 2000), file.slice(2000, 4000), file.slice(4000)];
    sv.removed = [];
    sv.engineMediaFolders = async (prefix) => prefix === 'uk/pv' ? ['video-abcdefgh', 'video-old12345', 'notes'] : [];
    sv.engineMediaList = async (prefix) => prefix.endsWith('video-abcdefgh') ? ['000.part', '001.part', '002.part'].map((name) => ({ name, size: 1 })) : prefix.endsWith('video-old12345') ? [{ name: '000.part', size: 1 }] : [];
    sv.engineMediaRemove = async (paths) => { sv.removed.push(...paths); };
    sv.engineMediaDownload = async (path) => { const i = Number(path.slice(-8, -5)); return path.startsWith(video.prefix) && pieces[i] ? Buffer.from(pieces[i]) : null; };
    eq('content: a video post with no uploaded video is held with a clear reason', [P.contentFor({ final: { facebook: { text: 'x', video: true } } }, 'facebook').ok, /Video to publish/.test(P.contentFor({ final: { facebook: { text: 'x', video: true } } }, 'facebook').error)], [false, true]);
    eq('assemble: the pieces join into exactly the file the desk sent', (await P.assembleVideo(sv, video)).equals(file), true);
    let bad = null; try { await P.assembleVideo(sv, { ...video, sha256: 'a'.repeat(64) }); } catch (e) { bad = e.message; }
    eq('assemble: a mismatch is refused', /doesn't match/.test(bad || ''), true);
    const vfinal = { facebook: { text: 'Watch.', comment: 'Sign: https://cgo.ac/z', media: [], video }, instagram: { text: 'Watch. Link in bio', comment: '', media: [], video, cover: 'uk/pv/instagram-0-cover.jpg' } };
    addPost(sv, 'pv', { review: approved, final: vfinal, posting: { destinations: ['uk-fb', 'uk-ig'], at: '2026-11-03T14:00:00Z' } });
    const calls = []; let polls = 0, vpolls = 0;
    const fetchImpl = async (u, opts = {}) => {
      const url = new URL(u); const ok = (b) => ({ ok: true, status: 200, json: async () => b });
      const body = opts.body instanceof FormData ? Object.fromEntries([...opts.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `blob:${v.size}`])) : opts.body instanceof Buffer ? { bytes: opts.body.length } : Object.fromEntries(new URLSearchParams(opts.body || url.search));
      calls.push({ host: url.hostname, path: url.pathname.replace(/^\/v[\d.]+\//, ''), body, headers: opts.headers || {} });
      if (url.hostname === 'graph-video.facebook.com') return ok({ id: 'v777' });
      if (url.hostname === 'rupload.facebook.com') return ok({ success: true });
      if (url.pathname.endsWith('/178/media')) return ok({ id: 'c900', uri: 'https://rupload.facebook.com/ig-api-upload/c900' });
      if (url.pathname.endsWith('/c900')) return ok({ status_code: ++polls < 2 ? 'IN_PROGRESS' : 'FINISHED' });
      if (url.pathname.endsWith('/178/media_publish')) return ok({ id: 'ig42' });
      if (url.pathname.endsWith('/ig42')) return ok({ permalink: 'https://www.instagram.com/reel/xyz/' });
      if (url.pathname.endsWith('/comments')) return ok({ id: 'cm1' });
      if (url.pathname.endsWith('/v777')) return ok({ status: { video_status: ++vpolls < 2 ? 'processing' : 'ready' } });
      return { ok: false, status: 404, json: async () => ({ error: { message: 'unexpected ' + url.pathname } }) };
    };
    const tv = await run({ store: sv, privateKey: keys.privateKey, live: true, now: NOW, log: quiet, fetchImpl, wait: async () => {} });
    const pv = sv.db.posts.find((x) => x.id === 'pv');
    const fbUp = calls.find((c) => c.host === 'graph-video.facebook.com');
    const igUp = calls.find((c) => c.host === 'rupload.facebook.com');
    eq('video: Facebook gets the whole file as a Page video with the text; the first comment waits while Facebook processes it', [tv.published, fbUp.path, fbUp.body.description, fbUp.body.source, calls.some((c) => c.path === 'v777/comments'), pv.doc.published['uk-fb'].comment_pending], [2, '105/videos', 'Watch.', `blob:${file.length}`, false, true]);
    await run({ store: sv, privateKey: keys.privateKey, live: true, now: NOW + 300_000, log: quiet, fetchImpl, wait: async () => {} });
    const pvc = sv.db.posts.find((x) => x.id === 'pv').doc.published['uk-fb'];
    eq('video: once Facebook says it is ready, the first comment goes up once', [calls.filter((c) => c.path === 'v777/comments').length, calls.find((c) => c.path === 'v777/comments').body.message, pvc.comment_id, pvc.comment_pending, pvc.comment_claim], [1, 'Sign: https://cgo.ac/z', 'cm1', null, null]);
    await run({ store: sv, privateKey: keys.privateKey, live: true, now: NOW + 600_000, log: quiet, fetchImpl, wait: async () => {} });
    eq('video: never a second comment', calls.filter((c) => c.path === 'v777/comments').length, 1);
    eq('video: Instagram gets a resumable Reel, waits until it is processed, then publishes', [calls.find((c) => c.path === '178/media').body.media_type, igUp.body.bytes, igUp.headers.file_size, polls, pv.doc.published['uk-ig'].url], ['REELS', file.length, String(file.length), 2, 'https://www.instagram.com/reel/xyz/']);
    eq('video: no public link to the file was ever made', calls.some((c) => JSON.stringify(c.body).includes('signed') && !c.body.cover_url), false);
    eq('video: once everything is out the stored pieces are removed, and it is Posted', [sv.removed, pv.doc.videoPieces.removed, pv.status], [['uk/pv/video-abcdefgh/000.part', 'uk/pv/video-abcdefgh/001.part', 'uk/pv/video-abcdefgh/002.part', 'uk/pv/video-old12345/000.part'], 4, 'posted']);
    eq('video: the Reel cover goes as a short-lived link to the stored image', calls.find((c) => c.path === '178/media').body.cover_url, 'https://db.example/signed/uk/pv/instagram-0-cover.jpg?token=t');
  }

  // Instagram Stories: their own slot, frame by frame, never twice.
  {
    const ss = engine();
    const sfinal = { ...final, story: { media: ['uk/ps/story-0-a.jpg', 'uk/ps/story-1-b.jpg', 'uk/ps/story-2-c.jpg'], skipped: 1 } };
    addPost(ss, 'ps', { review: approved, final: sfinal, posting: { destinations: ['uk-ig'], at: '2026-11-03T14:00:00Z', story: true } });
    eq('stories: an Instagram post with story ticked has a post slot and a story slot', P.plan(await ss.enginePosts(), ss.db.teams, NOW).map((i) => i.slot), ['uk-ig', 'uk-ig:story']);
    const noTick = engine(); addPost(noTick, 'pn', { review: approved, final: sfinal, posting: { destinations: ['uk-ig'], at: '2026-11-03T14:00:00Z' } });
    eq('stories: not ticked, no story slot', P.plan(await noTick.enginePosts(), noTick.db.teams, NOW).map((i) => i.slot), ['uk-ig']);
    let n = 0, failAt = 0; const sc = [];
    const fetchImpl = async (u, opts = {}) => {
      const url = new URL(u); const params = Object.fromEntries(new URLSearchParams(opts.body || url.search)); sc.push({ path: url.pathname.replace(/^\/v[\d.]+\//, ''), params });
      const ok = (b) => ({ ok: true, status: 200, json: async () => b });
      if (url.pathname.endsWith('/178/media')) { n++; if (failAt && n === failAt) return { ok: false, status: 400, json: async () => ({ error: { message: 'Rate limited' } }) }; return ok({ id: `c${n}` }); }
      if (url.pathname.endsWith('/178/media_publish')) return ok({ id: `pub-${params.creation_id}` });
      if (url.pathname.startsWith('/v') && /\/pub-/.test(url.pathname)) return ok({ permalink: 'https://www.instagram.com/p/post/' });
      if (url.pathname.endsWith('/comments')) return ok({ id: 'cm' });
      return ok({});
    };
    await run({ store: ss, privateKey: keys.privateKey, live: true, now: NOW, log: quiet, fetchImpl });
    const ps = ss.db.posts[0];
    eq('stories: three frames, each its own STORIES container, published in order', [sc.filter((c) => c.params.media_type === 'STORIES').map((c) => c.params.image_url.split('/').pop().split('?')[0]), ps.doc.published['uk-ig:story'].frames], [['story-0-a.jpg', 'story-1-b.jpg', 'story-2-c.jpg'], 3]);
    eq('stories: once the post and its Story are out, it is Posted', ps.status, 'posted');

    const sf = engine(); addPost(sf, 'pf', { review: approved, final: sfinal, posting: { destinations: ['uk-ig'], at: '2026-11-03T14:00:00Z', story: true } });
    n = 0; failAt = 6; /* the carousel post makes containers 1-3, story frames are 4,5,6: the third frame fails */
    await run({ store: sf, privateKey: keys.privateKey, live: true, now: NOW, log: quiet, fetchImpl });
    const pf = sf.db.posts[0];
    eq('stories: a failure after some frames are up says how many and is never retried', [!!pf.doc.published['uk-ig'], /2 of 3/.test(pf.doc.publishErrors['uk-ig:story'].message), pf.doc.publishErrors['uk-ig:story'].tries, P.plan([pf], sf.db.teams, NOW + 60_000).map((i) => i.action)], [true, true, P.MAX_TRIES, ['gave_up']]);
  }

  // Facebook Page Stories.
  {
    const sfb = engine();
    addPost(sfb, 'pfs', { review: approved, final: { facebook: final.facebook, story: { media: ['uk/pfs/story-0-a.jpg', 'uk/pfs/story-1-b.jpg'], skipped: 0 } }, posting: { destinations: ['uk-fb'], at: '2026-11-03T14:00:00Z', story: true } });
    eq('fb stories: a Facebook destination with story ticked gets a story slot too', P.plan(await sfb.enginePosts(), sfb.db.teams, NOW).map((i) => i.slot), ['uk-fb', 'uk-fb:story']);
    const fc = []; let ph = 0;
    const fetchImpl = async (u, opts = {}) => {
      const url = new URL(u); const params = Object.fromEntries(new URLSearchParams(opts.body || url.search)); fc.push({ path: url.pathname.replace(/^\/v[\d.]+\//, ''), params });
      const ok = (b) => ({ ok: true, status: 200, json: async () => b });
      if (url.pathname.endsWith('/105/photos')) return ok(params.published === 'false' ? { id: `ph${++ph}` } : { id: 'ph0', post_id: '105_900' });
      if (url.pathname.endsWith('/105/photo_stories')) return ok({ success: true, post_id: `st-${params.photo_id}` });
      if (url.pathname.endsWith('/comments')) return ok({ id: 'cm' });
      return ok({});
    };
    await run({ store: sfb, privateKey: keys.privateKey, live: true, now: NOW, log: quiet, fetchImpl });
    const pfs = sfb.db.posts[0];
    eq('fb stories: each frame is an unpublished photo, then a photo story, in order; then Posted', [fc.filter((c) => c.path === '105/photo_stories').map((c) => c.params.photo_id), pfs.doc.published['uk-fb:story'].frames, pfs.status], [['ph1', 'ph2'], 2, 'posted']);
  }

  // Instagram collabs.
  {
    eq('collabs: handles lose the @, duplicates go, at most three, and bad handles are refused',
      [P.collaboratorsOf({ collaborators: ['@RightToLifeUK', 'righttolifeuk', 'cfam.org'] }).list, P.collaboratorsOf({ collaborators: ['a', 'b', 'c', 'd'] }).ok, P.collaboratorsOf({ collaborators: ['no spaces'] }).ok],
      [['righttolifeuk', 'cfam.org'], false, false]);
    eq('collabs: only on Instagram', P.contentFor({ final: { facebook: { text: 'x', media: [], collaborators: ['bad handle'] } } }, 'facebook').ok, true);
    const sc = engine();
    addPost(sc, 'pc', { review: approved, final: { instagram: { ...final.instagram, collaborators: ['@righttolifeuk'] } }, posting: { destinations: ['uk-ig'], at: '2026-11-03T14:00:00Z' } });
    const fbc = fakeFacebook();
    await run({ store: sc, privateKey: keys.privateKey, live: true, now: NOW, log: quiet, fetchImpl: fbc.fetchImpl });
    const media = fbc.calls.filter((c) => c.path === '178/media');
    eq('collabs: invited on the carousel itself, not on its slides', [media.filter((c) => c.params.collaborators).map((c) => [c.params.media_type, c.params.collaborators]), !!sc.db.posts[0].doc.published['uk-ig']], [[['CAROUSEL', '["righttolifeuk"]']], true]);
  }

  // Pause everything: held, nothing called, and a long pause never marks it late.
  {
    const sp = engine();
    addPost(sp, 'pp', { review: approved, final, posting: { destinations: ['uk-fb'], at: '2026-11-03T14:00:00Z' } });
    sp.db.pauses = [{ id: 1, scope: 'mine', account_keys: ['uk-fb'], reason: 'National tragedy', paused_by: 'chris', until: null, resumed_at: null }];
    const fbp = fakeFacebook();
    const tp = await run({ store: sp, privateKey: keys.privateKey, live: true, now: NOW + 8 * 3600e3, log: quiet, fetchImpl: fbp.fetchImpl });
    eq('paused: held even 8 hours past its time, Facebook not called, post untouched', [tp.held, tp.failed, fbp.calls.length, sp.db.posts[0].version], [1, 0, 0, 1]);
    sp.db.pauses = [{ id: 2, scope: 'all', account_keys: [], reason: 'x', paused_by: 'admin', until: '2026-11-03T13:00:00Z', resumed_at: null }];
    eq('an organisation pause that has run out holds nothing', P.plan(await sp.enginePosts(), sp.db.teams, NOW, sp.db.pauses).map((i) => i.action), ['publish']);
  }

  // Live: Facebook at 14:00, Instagram at 18:00, X by hand.
  const s1 = engine();
  addPost(s1, 'p1', { review: approved, final, posting: { destinations: ['uk-fb', 'uk-ig', 'uk-x'], at: '2026-11-03T14:00:00Z', times: { 'uk-ig': '2026-11-03T18:00:00Z' } } });
  const fb1 = fakeFacebook();
  const t1 = await run({ store: s1, privateKey: keys.privateKey, live: true, now: NOW, log: quiet, fetchImpl: fb1.fetchImpl });
  const p1 = s1.db.posts[0];
  eq('live: Facebook goes out with the approver\'s Page token, the photo and the first comment', [t1.published, fb1.calls.map((c) => `${c.method} ${c.path}`), fb1.calls[0].params.url, fb1.calls[1].params.message], [1, ['POST 105/photos', 'POST 105_900/comments'], 'https://db.example/signed/uk/p1/facebook-0-aa.jpg?token=t', 'Sign here: https://cgo.ac/y']);
  eq('live: recorded as published, claim cleared, still scheduled (Instagram later, X by hand)', [p1.doc.published['uk-fb'].url, p1.doc.publishing, p1.status], ['https://www.facebook.com/105_900', {}, 'scheduled']);
  const fb1b = fakeFacebook();
  await run({ store: s1, privateKey: keys.privateKey, live: true, now: NOW + 60_000, log: quiet, fetchImpl: fb1b.fetchImpl });
  eq('never twice: the next run leaves Facebook alone', fb1b.calls.length, 0);
  const fb1c = fakeFacebook();
  await run({ store: s1, privateKey: keys.privateKey, live: true, now: Date.parse('2026-11-03T18:01:00Z'), log: quiet, fetchImpl: fb1c.fetchImpl });
  eq('Instagram at its own time: a carousel of two, published, permalink kept', [fb1c.calls.map((c) => c.path), s1.db.posts[0].doc.published['uk-ig'].url], [['178/media', '178/media', '178/media', '178/media_publish', 'ig555'], 'https://www.instagram.com/p/abc/']);
  eq('with X still to post by hand, it stays Scheduled', s1.db.posts[0].status, 'scheduled');

  // Cloud backup: only steps in 10 minutes after the time, and never on a destination another run has claimed.
  const sb = engine();
  addPost(sb, 'pb', { review: approved, final, posting: { destinations: ['uk-fb'], at: '2026-11-03T14:00:00Z' } });
  const fbb = fakeFacebook();
  await run({ store: sb, privateKey: keys.privateKey, live: true, now: Date.parse('2026-11-03T14:05:00Z'), log: quiet, fetchImpl: fbb.fetchImpl, runner: 'cloud', minLateMs: 600_000 });
  eq('backup: 5 minutes late is left to the Mini', [fbb.calls.length, !!(sb.db.posts[0].doc.published || {})['uk-fb']], [0, false]);
  await run({ store: sb, privateKey: keys.privateKey, live: true, now: Date.parse('2026-11-03T14:12:00Z'), log: quiet, fetchImpl: fbb.fetchImpl, runner: 'cloud', minLateMs: 600_000 });
  eq('backup: 12 minutes late, it publishes and says so', [fbb.calls[0].path, sb.db.events.find((e) => e.action === 'published').detail.via], ['105/photos', 'cloud']);
  const sr = engine();
  addPost(sr, 'pr', { review: approved, final, posting: { destinations: ['uk-fb'], at: '2026-11-03T14:00:00Z' } });
  const seen = clone(sr.db.posts);
  sr.enginePosts = async () => clone(seen);
  sr.db.posts[0].doc.publishing = { 'uk-fb': { at: '2026-11-03T14:11:00Z', by: 'mini' } };
  const fbr = fakeFacebook();
  const tr = await run({ store: sr, privateKey: keys.privateKey, live: true, now: Date.parse('2026-11-03T14:12:00Z'), log: quiet, fetchImpl: fbr.fetchImpl, runner: 'cloud', minLateMs: 600_000 });
  eq('race: the Mini claimed it between the backup planning and claiming, so the backup leaves it', [fbr.calls.length, tr.held], [0, 1]);

  // Facebook only: Posted afterwards.
  const s2 = engine();
  addPost(s2, 'p2', { review: approved, final, posting: { destinations: ['uk-fb'], at: '2026-11-03T14:00:00Z' } });
  await run({ store: s2, privateKey: keys.privateKey, live: true, now: NOW, log: quiet, fetchImpl: fakeFacebook().fetchImpl });
  eq('everything out and nothing by hand: Posted', [s2.db.posts[0].status, s2.db.posts[0].doc.posted.by, s2.db.events.map((e) => e.action)], ['posted', 'publisher', ['published', 'posted']]);

  // Every reason to hold back.
  const s3 = engine();
  addPost(s3, 'lost', { review: approved, final, posting: { destinations: ['uk-fb'], at: '2026-11-03T14:00:00Z' } });
  s3.db.rights = s3.db.rights.filter((r) => r.account_key !== 'uk-fb');
  addPost(s3, 'notoken', { review: approved, final, posting: { destinations: ['sc-fb'], at: '2026-11-03T14:00:00Z' } });
  addPost(s3, 'nofinal', { review: approved, posting: { destinations: ['uk-ig'], at: '2026-11-03T14:00:00Z' } });
  addPost(s3, 'late', { review: approved, final, posting: { destinations: ['uk-ig'], at: '2026-11-03T06:00:00Z' } });
  addPost(s3, 'claimed', { review: approved, final, publishing: { 'uk-ig': { at: '2026-11-03T13:30:00Z' } }, posting: { destinations: ['uk-ig'], at: '2026-11-03T13:00:00Z' } });
  addPost(s3, 'busy', { review: approved, final, publishing: { 'uk-ig': { at: '2026-11-03T14:00:00Z' } }, posting: { destinations: ['uk-ig'], at: '2026-11-03T13:59:00Z' } });
  const fb3 = fakeFacebook();
  const t3 = await run({ store: s3, privateKey: keys.privateKey, live: true, now: NOW, log: quiet, fetchImpl: fb3.fetchImpl });
  const err = (id, k) => (s3.db.posts.find((p) => p.id === id).doc.publishErrors || {})[k];
  eq('held back, nothing published', [t3.published, fb3.calls.length], [0, 0]);
  eq('approver lost the right', /can no longer post to uk-fb/.test(err('lost', 'uk-fb').message), true);
  eq('maintainer right but no connected Facebook', /hasn't connected Facebook/.test(err('notoken', 'sc-fb').message), true);
  eq('no approved snapshot', /Not ready to publish/.test(err('nofinal', 'uk-ig').message), true);
  eq('more than 6 hours late', /more than 6 hours/.test(err('late', 'uk-ig').message), true);
  eq('an old claim with no answer is reported, not retried (it may already be up)', [/may already be up/.test(err('claimed', 'uk-ig').message), err('claimed', 'uk-ig').tries], [true, P.MAX_TRIES]);
  eq('a fresh claim from another run is left alone', [err('busy', 'uk-ig'), t3.held], [undefined, 1]);

  // Facebook refusing: counted, retried up to 3 times, then left for a person.
  const s4 = engine();
  addPost(s4, 'bad', { review: approved, final, posting: { destinations: ['uk-fb'], at: '2026-11-03T14:00:00Z' } });
  s4.db.tokens[0].sealed = xauth.seal(keys.publicKey, 'EXPIRED');
  for (let i = 0; i < 4; i++) await run({ store: s4, privateKey: keys.privateKey, live: true, now: NOW + i * 600_000, log: quiet, fetchImpl: fakeFacebook().fetchImpl });
  const e4 = s4.db.posts[0].doc.publishErrors['uk-fb'];
  eq('Facebook refusing: three tries, then it stops and says why', [e4.tries, /Invalid OAuth access token/.test(e4.message), s4.db.events.filter((e) => e.action === 'publish_failed').length], [3, true, 3]);

  // The post goes up but the first comment fails: published, never retried.
  const s6 = engine();
  addPost(s6, 'cm', { review: approved, final, posting: { destinations: ['uk-fb'], at: '2026-11-03T14:00:00Z' } });
  const fb6 = fakeFacebook();
  const f6 = fb6.fetchImpl;
  const noComments = async (u, o) => (String(u).includes('/comments') ? { ok: false, status: 400, json: async () => ({ error: { message: 'Comments are off' } }) } : f6(u, o));
  await run({ store: s6, privateKey: keys.privateKey, live: true, now: NOW, log: quiet, fetchImpl: noComments });
  const fb6b = fakeFacebook();
  await run({ store: s6, privateKey: keys.privateKey, live: true, now: NOW + 600_000, log: quiet, fetchImpl: fb6b.fetchImpl });
  const pub6 = s6.db.posts[0].doc.published['uk-fb'];
  eq('first comment fails: the post counts as published, the comment is flagged, nothing is posted twice', [!!pub6.id, /Add it by hand/.test(pub6.comment_error), fb6b.calls.length, s6.db.posts[0].status], [true, true, 0, 'posted']);

  // A Facebook video still processing after 2 hours: the comment is left for a person.
  const sw = engine();
  addPost(sw, 'pw', { review: approved, final, published: { 'uk-fb': { id: 'v9', url: 'u', at: '2026-11-03T11:00:00Z', by: 'chris', comment_id: null, comment_pending: true } }, posting: { destinations: ['uk-fb'], at: '2026-11-03T11:00:00Z' } }, 'posted');
  const fbw = fakeFacebook();
  await run({ store: sw, privateKey: keys.privateKey, live: true, now: NOW, log: quiet, fetchImpl: fbw.fetchImpl });
  const pw = sw.db.posts[0].doc.published['uk-fb'];
  eq('video still processing after 2 hours: no comment, flagged to add by hand', [fbw.calls.length, pw.comment_pending, /Add it by hand/.test(pw.comment_error)], [0, null, true]);

  // engine_media: the desk's finished images.
  const tool = ENGINE_TOOLS.find((t) => t.name === 'engine_media').handler;
  const s5 = engine();
  s5.engineTeams = async () => clone(s5.db.teams);
  addPost(s5, 'uk-1', { title: 'x' }, 'review');
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(100)]).toString('base64');
  const m = JSON.parse((await tool(s5, { id: 'uk-1', platform: 'instagram', index: 1, mime: 'image/jpeg', data: jpeg }, { who: 'chris' })).text);
  eq('engine_media: stored under the team and post, by content hash', [m.ok, /^uk\/uk-1\/instagram-1-[0-9a-f]{12}\.jpg$/.test(m.path)], [true, true]);
  const notJpeg = JSON.parse((await tool(s5, { id: 'uk-1', platform: 'facebook', mime: 'image/jpeg', data: Buffer.from('<svg/>').toString('base64') }, { who: 'chris' })).text);
  eq('engine_media: refuses a file that isn\'t the image it claims to be', notJpeg.ok, false);
  let notMember = null; try { await tool(s5, { id: 'uk-1', platform: 'facebook', mime: 'image/jpeg', data: jpeg }, { who: 'greg' }); } catch (e) { notMember = e.code; }
  eq('engine_media: only for posts you can edit', notMember, 'ENGINE_NOT_FOUND');

  // Picture-less Facebook posts go out as link posts, so the preview card shows.
  eq('linkOf: the last web address, without trailing punctuation', P.linkOf('Read https://a.example/x then sign 👇\nhttps://cgo.ac/abc.'), 'https://cgo.ac/abc');
  eq('linkOf: none in a plain text post', P.linkOf('Pray with us tonight.'), null);
  const fl = fakeFacebook();
  const lr = await P.publishFacebook({ pageId: '105', token: 'PAGE-TOKEN', text: 'Tell all 90 MLAs 👇\nhttps://cgo.ac/abc', comment: '', urls: [], fetchImpl: fl.fetchImpl });
  eq('link post: one feed call carrying the message and the link', fl.calls.map((c) => [c.path, c.params.link || null, c.params.message]), [['105/feed', 'https://cgo.ac/abc', 'Tell all 90 MLAs 👇\nhttps://cgo.ac/abc']]);
  eq('link post: the post id comes back', lr.id, '105_901');
  const ft = fakeFacebook();
  await P.publishFacebook({ pageId: '105', token: 'PAGE-TOKEN', text: 'Pray with us tonight.', comment: '', urls: [], fetchImpl: ft.fetchImpl });
  eq('text post: no link sent when the text has none', 'link' in ft.calls[0].params, false);
  const fp = fakeFacebook();
  await P.publishFacebook({ pageId: '105', token: 'PAGE-TOKEN', text: 'Pray with us. https://cgo.ac/x', comment: '', urls: ['https://db.example/a.jpg'], fetchImpl: fp.fetchImpl });
  eq('photo post: unchanged, no link param', [fp.calls[0].path, 'link' in fp.calls[0].params], ['105/photos', false]);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
