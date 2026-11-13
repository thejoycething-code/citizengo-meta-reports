'use strict';
// Preview links for planned posts [13 Nov 2026, Chris: "Build preview links for
// planned posts only"]. A read-only page showing one post as it will go out, for
// someone outside the desk (legal, a spokesperson) to check. No sign-in.
//
// The link carries a signed token: post id, a random nonce and an expiry. The
// nonce is also kept in the desk documents (collection previewLinks, id = post
// id), so "Stop sharing" ends a link at once, and a new link replaces the old.
// The page shows only while the post is planned (Idea approved / Editing, or
// handed off and not yet posted); after that the link says so and shows nothing.

const crypto = require('crypto');
const A = require('./asana');
const E = require('./engine');

const PLANNED = new Set(['hold', 'scheduled']);
const DAYS = 14;
const b64url = (b) => Buffer.from(b).toString('base64url');

function secret() {
  const s = process.env.OAUTH_SIGNING_SECRET;
  if (!s || s.length < 16) throw new Error('Preview links need OAUTH_SIGNING_SECRET.');
  return s;
}
const mac = (body) => b64url(crypto.createHmac('sha256', secret()).update(`post-preview.${body}`).digest());

function tokenFor({ id, nonce, exp }) {
  const body = b64url(JSON.stringify({ p: String(id), n: String(nonce), e: Number(exp) }));
  return `${body}.${mac(body)}`;
}

// { id, nonce, exp } or null (bad signature, garbled or expired).
function readToken(token, now = Date.now()) {
  const m = /^([A-Za-z0-9_-]{10,600})\.([A-Za-z0-9_-]{43})$/.exec(String(token || ''));
  if (!m) return null;
  const want = mac(m[1]);
  if (!crypto.timingSafeEqual(Buffer.from(want), Buffer.from(m[2]))) return null;
  let c;
  try { c = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!c || typeof c.p !== 'string' || typeof c.n !== 'string' || !(c.e > now)) return null;
  return { id: c.p, nonce: c.n, exp: c.e };
}

const newNonce = () => crypto.randomBytes(12).toString('base64url');

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// What each network will carry, as the Asana task shows it: final words once
// handed off, else the desk's edit, else the draft.
function networksOf(post) {
  const doc = post.doc || {};
  const keys = E.destinations(doc);
  const plats = [...new Set(keys.map((k) => (A.CALENDARS[k] && A.CALENDARS[k].platform) || (/-ig$/.test(k) ? 'instagram' : /-x$/.test(k) ? 'x' : /-fb$/.test(k) ? 'facebook' : null)).filter(Boolean))];
  const pick = (k) => { const e = doc.edited && doc.edited[k]; const v = e != null ? e : doc.platforms && doc.platforms[k]; return typeof v === 'string' ? v : (v && v.text) || ''; };
  return plats.map((platform) => {
    const accounts = keys.filter((k) => (A.CALENDARS[k] ? A.CALENDARS[k].platform === platform : k.endsWith({ facebook: '-fb', instagram: '-ig', x: '-x' }[platform]))).map((k) => (A.CALENDARS[k] && A.CALENDARS[k].label) || k);
    if (platform === 'x') return { platform, accounts, posts: A.xPosts(doc), media: [], video: false };
    const f = (doc.final && doc.final[platform]) || {};
    return { platform, accounts, text: String(f.text || pick(platform)), comment: String(f.comment || pick(platform + 'Comment')),
      media: (f.media || []).filter(Boolean), cover: f.cover || null, video: !!f.video };
  });
}

function whenOf(post) {
  const g = (post.doc && post.doc.posting) || {};
  const times = Object.values(g.times || {}).concat(g.at ? [g.at] : []).filter((t) => !Number.isNaN(Date.parse(t))).sort();
  const at = post.post_at || times[0] || g.suggestedAt || null;
  return at ? A.when(at) : null;
}

const NET = { facebook: 'Facebook', instagram: 'Instagram', x: 'X' };
const STYLE = `:root{--bg:#eef0f3;--card:#fff;--fg:#1f2a37;--mu:#667080;--line:#dfe3ea;--ac:#1d7ee2;--warn:#8a5300;--warnbg:#fdf0d9}
@media(prefers-color-scheme:dark){:root{--bg:#0f141c;--card:#18202c;--fg:#e6e9ef;--mu:#9aa4b5;--line:#2b3445;--ac:#6fa8ff;--warn:#f0c070;--warnbg:#2c2416}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:620px;margin:0 auto;padding:20px 16px 40px;display:flex;flex-direction:column;gap:14px}
.top{display:flex;flex-direction:column;gap:4px}.top h1{margin:0;font-size:20px}.mu{color:var(--mu);font-size:14px;margin:0}
.flag{background:var(--warnbg);color:var(--warn);border-radius:10px;padding:10px 14px;font-size:14px}
.net{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.nh{display:flex;justify-content:space-between;gap:8px;padding:10px 14px;border-bottom:1px solid var(--line);font-size:14px}.nh b{font-size:15px}
.tx{padding:12px 14px;white-space:pre-wrap;word-wrap:break-word}
.cm{margin:0 14px 12px;padding:10px 12px;border-left:3px solid var(--line);color:var(--mu);font-size:14px;white-space:pre-wrap;word-wrap:break-word}
.cm b{display:block;color:var(--fg);font-size:12px;letter-spacing:.04em;text-transform:uppercase;margin-bottom:2px}
.md{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:4px;padding:0 14px 12px}.md img{width:100%;border-radius:6px;display:block}
.vid{margin:0 14px 12px;font-size:14px;color:var(--mu)}
.xp{padding:10px 14px;border-top:1px dashed var(--line);white-space:pre-wrap;word-wrap:break-word}.xp:first-of-type{border-top:0}
footer{color:var(--mu);font-size:13px;text-align:center}`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

function goneHtml(why) {
  return page('Preview not available', `<div class="top"><h1>This preview isn't available</h1><p class="mu">${esc(why)}</p></div><footer>CitizenGO Content Engine</footer>`);
}

// images: { [storagePath]: signedUrl }
function previewHtml({ post, team, images = {}, exp }) {
  const doc = post.doc || {};
  const nets = networksOf(post);
  const when = whenOf(post);
  const status = post.status === 'hold' ? 'Still being finished: words or pictures may change before it goes out.' : 'Ready to post.';
  const img = (p) => images[p] ? `<img src="${esc(images[p])}" alt="" loading="lazy">` : '';
  const thumb = E.calendarItem(post, { editable: false }).thumb;
  const blocks = nets.map((n) => {
    const head = `<div class="nh"><b>${NET[n.platform]}</b><span class="mu">${esc(n.accounts.join(', '))}</span></div>`;
    if (n.platform === 'x') return `<section class="net">${head}${(n.posts.length ? n.posts : ['(no words yet)']).map((x, i) => `<div class="xp">${n.posts.length > 1 ? `<span class="mu">${i + 1}/${n.posts.length}</span>\n` : ''}${esc(x)}</div>`).join('')}</section>`;
    const pics = n.media.map(img).filter(Boolean);
    const cover = n.cover ? img(n.cover) : '';
    const media = pics.length ? `<div class="md">${pics.join('')}</div>` : cover ? `<div class="md">${cover}</div>` : !n.video && thumb && /^https:\/\//.test(thumb) ? `<div class="md"><img src="${esc(thumb)}" alt="" loading="lazy"></div>` : '';
    return `<section class="net">${head}<div class="tx">${esc(n.text || '(no words yet)')}</div>${media}${n.video ? '<p class="vid">▶ Video attached (not shown in the preview)</p>' : ''}${n.comment ? `<div class="cm"><b>First comment</b>${esc(n.comment)}</div>` : ''}</section>`;
  }).join('');
  const title = String(doc.title || doc.headline || 'Planned post').replace(/^Scotland:\s*/i, '');
  return page(`Preview: ${title}`, `<div class="top"><h1>${esc(title)}</h1><p class="mu">${esc(team || 'CitizenGO')}${when ? ` · planned for ${esc(when)} (UK time)` : ''}</p></div>
<p class="flag">Preview only. ${esc(status)} Please send any comments to the person who shared this link.</p>${blocks || '<p class="mu">No networks picked yet.</p>'}
<footer>CitizenGO Content Engine · this link stops working ${exp ? `on ${esc(new Date(exp).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/London' }))} or ` : ''}once the post goes out</footer>`);
}

module.exports = { PLANNED, DAYS, tokenFor, readToken, newNonce, networksOf, previewHtml, goneHtml };
