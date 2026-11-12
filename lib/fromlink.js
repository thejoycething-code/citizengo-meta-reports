'use strict';
// 41C (Priority Three, 4 Nov): a picture from a link. Someone pastes a Canva or
// Google Drive share link (or any public page or picture) into Compose; the
// desk fetches the picture once, server side, and keeps a copy in the public
// desk-assets bucket like an upload. Only what the link already shows to
// anyone: no sign-in to Canva or Google, no API keys.
//
//   Google Drive  drive.google.com/file/d/<id>/view -> the file itself
//                 (the file must be shared "Anyone with the link")
//   Canva         a "view" or public share link -> the picture the page
//                 shows to link previews (og:image)
//   Anything else a picture address, or a page with an og:image
//
// Safety: https only, no IP addresses or private networks (checked again on
// every redirect), at most 4 redirects, 15 MB and 20 seconds.

const dns = require('dns').promises;
const net = require('net');
const crypto = require('crypto');

const MAX_BYTES = 15 * 1048576;
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

// Share links people actually paste, turned into the address of the file.
function normalise(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (e) { return null; }
  if (u.protocol === 'http:') u.protocol = 'https:';
  if (u.protocol !== 'https:') return null;
  const h = u.hostname.toLowerCase();
  if (h === 'drive.google.com' || h === 'docs.google.com') {
    const m = u.pathname.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/) || [null, u.searchParams.get('id')];
    if (m && m[1]) return { url: `https://drive.google.com/uc?export=download&id=${m[1]}`, source: 'drive' };
  }
  if (/(^|\.)canva\.com$/.test(h)) return { url: u.toString(), source: 'canva' };
  return { url: u.toString(), source: 'link' };
}

async function checkHost(u, lookup) {
  if (u.protocol !== 'https:') throw Object.assign(new Error('Only https links.'), { status: 400 });
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) || /^localhost$|\.local$|\.internal$/i.test(host)) throw Object.assign(new Error('That address is not allowed.'), { status: 400 });
  const addrs = await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw Object.assign(new Error("Couldn't find that website."), { status: 400 });
  if (addrs.some((a) => privateIp(a.address))) throw Object.assign(new Error('That address is not allowed.'), { status: 400 });
}

async function get(url, { fetchImpl = fetch, lookup = dns.lookup } = {}) {
  let u = new URL(url);
  for (let hop = 0; hop <= 4; hop++) {
    await checkHost(u, lookup);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    let r;
    try { r = await fetchImpl(u.toString(), { redirect: 'manual', signal: ctl.signal, headers: { 'User-Agent': 'CitizenGO-desk/1.0 (link preview)', Accept: 'image/*,text/html;q=0.8' } }); }
    catch (e) { clearTimeout(timer); throw Object.assign(new Error("Couldn't reach that link."), { status: 502 }); }
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { clearTimeout(timer); u = new URL(r.headers.get('location'), u); continue; }
    if (!r.ok) { clearTimeout(timer); throw Object.assign(new Error(r.status === 403 || r.status === 401 ? 'That link is private: share it with "Anyone with the link" first.' : `The link answered ${r.status}.`), { status: 400 }); }
    const len = Number(r.headers.get('content-length') || 0);
    if (len > MAX_BYTES) { clearTimeout(timer); throw Object.assign(new Error('That file is over 15 MB.'), { status: 413 }); }
    const buf = Buffer.from(await r.arrayBuffer());
    clearTimeout(timer);
    if (buf.length > MAX_BYTES) throw Object.assign(new Error('That file is over 15 MB.'), { status: 413 });
    return { url: u.toString(), type: String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(), buf };
  }
  throw Object.assign(new Error('Too many redirects.'), { status: 400 });
}

// The type from the bytes themselves, so a page can't pass as a picture.
function sniff(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.slice(0, 4).toString('hex') === '89504e47') return 'image/png';
  if (buf.slice(0, 3).toString() === 'GIF') return 'image/gif';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

function ogImage(html, base) {
  const s = String(html).slice(0, 400000);
  const metas = s.match(/<meta\b[^>]*>/gi) || [];
  for (const want of ['og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src']) {
    for (const m of metas) {
      const key = (m.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
      const val = (m.match(/\bcontent\s*=\s*["']([^"']+)["']/i) || [])[1];
      if (key && val && key.toLowerCase() === want) { try { return new URL(val.replace(/&amp;/g, '&'), base).toString(); } catch (e) { /* next */ } }
    }
  }
  return null;
}

// The picture behind a link: { buf, type, source, from }.
async function pictureFrom(raw, opts = {}) {
  const n = normalise(raw);
  if (!n) throw Object.assign(new Error('Paste an https link.'), { status: 400 });
  let res = await get(n.url, opts);
  let type = sniff(res.buf);
  if (!type) {
    if (!/html/.test(res.type)) throw Object.assign(new Error("That link isn't a picture or a page with one."), { status: 400 });
    const img = ogImage(res.buf.toString('utf8'), res.url);
    if (!img) throw Object.assign(new Error(n.source === 'drive' ? 'Google Drive asked for a sign-in: share the file with "Anyone with the link".' : "Couldn't find a picture on that page."), { status: 400 });
    res = await get(img, opts);
    type = sniff(res.buf);
    if (!type) throw Object.assign(new Error("The page's picture couldn't be read."), { status: 400 });
  }
  return { buf: res.buf, type, source: n.source, from: res.url };
}

// Fetch it and keep a copy in desk-assets, like an upload.
async function saveFromLink(raw, opts = {}) {
  const pic = await pictureFrom(raw, opts);
  const base = String(process.env.SUPABASE_URL || '').trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!base || !key) throw Object.assign(new Error('Storage is not configured.'), { status: 503 });
  const id = crypto.randomUUID().replace(/-/g, '');
  const objectPath = `desk/${new Date().toISOString().slice(0, 7)}/${id}.${TYPES[pic.type]}`;
  const r = await (opts.fetchImpl || fetch)(`${base}/storage/v1/object/desk-assets/${objectPath}`, { method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': pic.type, 'x-upsert': 'false' }, body: pic.buf });
  if (!r.ok) throw Object.assign(new Error("Couldn't keep a copy of the picture."), { status: 502 });
  return { ok: true, id, url: `${base}/storage/v1/object/public/desk-assets/${objectPath}`, contentType: pic.type, sizeBytes: pic.buf.length, source: pic.source };
}

module.exports = { get, normalise, privateIp, sniff, ogImage, pictureFrom, saveFromLink, MAX_BYTES };
