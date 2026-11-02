'use strict';
// A small QR code maker for Link in bio's leaflet code [2 Nov 2026]: byte
// mode, error correction level M, versions 1 to 10 (up to 213 bytes, plenty
// for a page address). Written here rather than pulled in, because the
// project has no npm dependencies. Follows ISO/IEC 18004; the structure is
// the well-known one (finders, timing, alignment, format and version bits,
// Reed-Solomon over GF(256) with 0x11D, the eight masks, lowest penalty).

// Level M per version: total codewords, EC codewords per block, blocks.
const M = [null,
  { total: 26, ec: 10, blocks: 1 }, { total: 44, ec: 16, blocks: 1 }, { total: 70, ec: 26, blocks: 1 },
  { total: 100, ec: 18, blocks: 2 }, { total: 134, ec: 24, blocks: 2 }, { total: 172, ec: 16, blocks: 4 },
  { total: 196, ec: 18, blocks: 4 }, { total: 242, ec: 22, blocks: 4 }, { total: 292, ec: 22, blocks: 5 },
  { total: 346, ec: 26, blocks: 5 }];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

// GF(256) arithmetic.
function gmul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
  return z & 0xff;
}
function rsDivisor(degree) {
  const r = new Array(degree).fill(0); r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) { r[j] = gmul(r[j], root); if (j + 1 < r.length) r[j] ^= r[j + 1]; }
    root = gmul(root, 2);
  }
  return r;
}
function rsRemainder(data, div) {
  const r = div.map(() => 0);
  for (const b of data) {
    const f = b ^ r.shift(); r.push(0);
    div.forEach((c, i) => { r[i] ^= gmul(c, f); });
  }
  return r;
}

function utf8(s) { return [...Buffer.from(String(s), 'utf8')]; }

// The data codewords, interleaved with their error correction.
function codewords(bytes, ver) {
  const { total, ec, blocks } = M[ver];
  const dataLen = total - ec * blocks;
  const bits = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(4, 4); put(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, dataLen * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let p = 0; data.length < dataLen; p ^= 1) data.push(p ? 0x11 : 0xec);
  // Blocks: the short ones first, each long one has one more data codeword.
  const shortLen = Math.floor(total / blocks) - ec, longCount = total % blocks;
  const div = rsDivisor(ec);
  const blks = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const n = shortLen + (i >= blocks - longCount ? 1 : 0);
    const d = data.slice(k, k + n); k += n;
    blks.push({ d, e: rsRemainder(d, div) });
  }
  const out = [];
  for (let i = 0; i <= shortLen; i++) for (const b of blks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ec; i++) for (const b of blks) out.push(b.e[i]);
  return out;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function build(ver, cw, mask) {
  const size = ver * 4 + 17;
  const mod = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { mod[y][x] = dark; fn[y][x] = true; };
  // Timing patterns.
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  // Finders with their separators.
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      set(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  // Alignment patterns.
  const al = ALIGN[ver], n = al.length;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  // Format bits (level M = 00), reserved now and drawn after masking.
  const format = () => {
    const data = (0 << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const b = (i) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, b(i));
    set(8, 7, b(6)); set(8, 8, b(7)); set(7, 8, b(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, b(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, b(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, b(i));
    set(8, size - 8, true);
  };
  format();
  // Version bits (7 and up).
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1, a = size - 11 + (i % 3), c = Math.floor(i / 3);
      set(a, c, dark); set(c, a, dark);
    }
  }
  // Data, in the zig-zag, then the mask on data modules only.
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - v : v;
      if (fn[y][x]) continue;
      const bit = i < cw.length * 8 ? ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) === 1 : false;
      i++;
      mod[y][x] = bit !== MASKS[mask](x, y);
    }
  }
  format();
  return mod;
}

// Lower is better: runs of five or more, 2x2 blocks, finder look-alikes,
// and dark/light balance.
function penalty(m) {
  const size = m.length;
  let p = 0;
  const line = (get) => {
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b < size; b++) {
        if (get(a, b) === get(a, b - 1)) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1;
      }
      for (let b = 0; b + 10 < size + 1; b++) {
        const s = Array.from({ length: Math.min(11, size - b) }, (_, k) => (get(a, b + k) ? 1 : 0)).join('');
        if (s === '10111010000' || s === '00001011101') p += 40;
      }
    }
  };
  line((y, x) => m[y][x]); line((x, y) => m[y][x]);
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (m[y][x]) dark++;
    if (x < size - 1 && y < size - 1 && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
  }
  p += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  return p;
}

// The modules (true = dark) for the text, smallest version that fits.
function encode(text) {
  const bytes = utf8(text);
  let ver = 1;
  for (; ver <= 10; ver++) {
    const { total, ec, blocks } = M[ver];
    if (4 + (ver < 10 ? 8 : 16) + bytes.length * 8 <= (total - ec * blocks) * 8) break;
  }
  if (ver > 10) throw new Error('Too long for a QR code here (213 bytes at most).');
  const cw = codewords(bytes, ver);
  let best = null, bestP = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = build(ver, cw, mask);
    const p = penalty(m);
    if (p < bestP) { best = m; bestP = p; }
  }
  return best;
}

// An SVG, black on white with a four-module quiet zone, sized by viewBox.
function svg(text, { margin = 4, dark = '#000', light = '#fff' } = {}) {
  const m = encode(text), n = m.length + margin * 2;
  let d = '';
  m.forEach((row, y) => row.forEach((on, x) => { if (on) d += `M${x + margin} ${y + margin}h1v1h-1z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n * 8}" height="${n * 8}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}

module.exports = { encode, svg, _gmul: gmul, _rsRemainder: rsRemainder, _rsDivisor: rsDivisor, _codewords: codewords };
