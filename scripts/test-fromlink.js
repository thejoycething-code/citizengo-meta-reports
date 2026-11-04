#!/usr/bin/env node
'use strict';
// 41C (Priority Three, 4 Nov): a picture from a Canva, Drive or public link
// (lib/fromlink.js) against a fake web: share links become the file, pages
// give their og:image, private networks and non-pictures are refused, and
// redirects are checked again.
// Usage: node scripts/test-fromlink.js

const F = require('../lib/fromlink');
let passed = 0, failed = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${name}`); passed++; } else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failed++; }
}
const PNG = Buffer.from('89504e470d0a1a0a0000', 'hex');
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const res = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] || null }, arrayBuffer: async () => (Buffer.isBuffer(body) ? body : Buffer.from(String(body))) });
const WEB = {
  'https://drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMn': () => res(302, '', { location: 'https://drive.usercontent.google.com/download?id=1AbCdEfGhIjKlMn' }),
  'https://drive.usercontent.google.com/download?id=1AbCdEfGhIjKlMn': () => res(200, JPG, { 'content-type': 'image/jpeg' }),
  'https://www.canva.com/design/DAF1/abc/view': () => res(200, '<html><head><meta property="og:image" content="https://document-export.canva.com/x/thumb.png?a=1&amp;b=2"></head></html>', { 'content-type': 'text/html; charset=utf-8' }),
  'https://document-export.canva.com/x/thumb.png?a=1&b=2': () => res(200, PNG, { 'content-type': 'image/png' }),
  'https://news.example/story': () => res(200, '<p>no picture here</p>', { 'content-type': 'text/html' }),
  'https://news.example/fake.png': () => res(200, '<html>not a png</html>', { 'content-type': 'image/png' }),
  'https://news.example/hop': () => res(301, '', { location: 'https://intranet.example/secret.png' }),
  'https://private.example/x.png': () => res(403, ''),
};
const fetchImpl = async (url) => (WEB[url] ? WEB[url]() : res(404, ''));
const lookup = async (host) => [{ address: /intranet|evil/.test(host) ? '10.0.0.5' : '93.184.216.34' }];
const opts = { fetchImpl, lookup };
const err = async (p) => { try { await p; return 'no error'; } catch (e) { return e.message; } };

(async () => {
  eq('share links: Drive file links become the file; Canva stays as the page', [F.normalise('https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view?usp=sharing').url, F.normalise('https://www.canva.com/design/DAF1/abc/view').source, F.normalise('ftp://x/y'), F.normalise('http://a.example/p.png').url], ['https://drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMn', 'canva', null, 'https://a.example/p.png']);
  const d = await F.pictureFrom('https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view', opts);
  eq('Drive: follows the download redirect to the picture', [d.type, d.source], ['image/jpeg', 'drive']);
  const c = await F.pictureFrom('https://www.canva.com/design/DAF1/abc/view', opts);
  eq('Canva: the page\'s og:image, entities decoded', [c.type, c.source, c.from], ['image/png', 'canva', 'https://document-export.canva.com/x/thumb.png?a=1&b=2']);
  eq('a page with no picture is refused', await err(F.pictureFrom('https://news.example/story', opts)), "Couldn't find a picture on that page.");
  eq('the bytes decide, not the header', await err(F.pictureFrom('https://news.example/fake.png', opts)), "That link isn't a picture or a page with one.");
  eq('private networks refused, also after a redirect', [await err(F.pictureFrom('https://evil.example/x.png', opts)), await err(F.pictureFrom('https://news.example/hop', opts)), await err(F.pictureFrom('https://127.0.0.1/x.png', opts))], ['That address is not allowed.', 'That address is not allowed.', 'That address is not allowed.']);
  eq('a private share link says how to fix it', await err(F.pictureFrom('https://private.example/x.png', opts)), 'That link is private: share it with "Anyone with the link" first.');
  eq('private address ranges', ['10.1.2.3', '192.168.0.1', '172.20.0.1', '169.254.169.254', '127.0.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1', '8.8.8.8'].map(F.privateIp), [true, true, true, true, true, true, true, true, false]);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
