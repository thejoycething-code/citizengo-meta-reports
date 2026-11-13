'use strict';
// Preview links for planned posts (lib/preview.js) [13 Nov 2026].
process.env.OAUTH_SIGNING_SECRET = process.env.OAUTH_SIGNING_SECRET || 'test-secret-for-preview-links-0123456789';
const assert = require('assert');
const PV = require('../lib/preview');
let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log('  ok   ', name); } catch (e) { fail++; console.log('  FAIL ', name, e.message); } };

const now = Date.parse('2026-11-13T09:00:00Z');
const tok = PV.tokenFor({ id: 'uk-20261113-abc', nonce: 'n0nce', exp: now + 864e5 });
ok('a token reads back', () => assert.deepStrictEqual(PV.readToken(tok, now), { id: 'uk-20261113-abc', nonce: 'n0nce', exp: now + 864e5 }));
ok('an expired token is refused', () => assert.strictEqual(PV.readToken(tok, now + 2 * 864e5), null));
ok('a changed token is refused', () => {
  const [b, m] = tok.split('.');
  const other = Buffer.from(JSON.stringify({ p: 'uk-other', n: 'n0nce', e: now + 864e5 })).toString('base64url');
  assert.strictEqual(PV.readToken(`${other}.${m}`, now), null);
  assert.strictEqual(PV.readToken(`${b}.${m.slice(0, -1)}${m.endsWith('A') ? 'B' : 'A'}`, now), null);
  assert.strictEqual(PV.readToken('garbage', now), null);
});
ok('only planned posts', () => assert.deepStrictEqual(['hold', 'scheduled', 'posted', 'review', 'rejected'].map((s) => PV.PLANNED.has(s)), [true, true, false, false, false]));
const post = { id: 'uk-1', team_id: 'uk', status: 'scheduled', post_at: '2026-11-14T12:00:00Z',
  doc: { title: 'Stop the <Bill>', posting: { destinations: ['uk-fb', 'uk-ig', 'uk-x'] },
    final: { facebook: { text: 'Sign now <b>', comment: 'cgo.ac/x', media: ['uk/uk-1/facebook-0.jpg'] }, instagram: { text: 'IG words', media: [] } },
    platforms: { x: ['One', 'Two'] } } };
ok('each network carries its words, comment and pictures', () => {
  const n = PV.networksOf(post);
  assert.deepStrictEqual(n.map((x) => x.platform), ['facebook', 'instagram', 'x']);
  assert.strictEqual(n[0].comment, 'cgo.ac/x');
  assert.deepStrictEqual(n[0].media, ['uk/uk-1/facebook-0.jpg']);
  assert.deepStrictEqual(n[2].posts, ['One', 'Two']);
});
ok('the page escapes words and shows signed pictures', () => {
  const h = PV.previewHtml({ post, team: 'CitizenGO United Kingdom', images: { 'uk/uk-1/facebook-0.jpg': 'https://s.test/x.jpg' }, exp: now + 864e5 });
  assert(h.includes('Stop the &lt;Bill&gt;'));
  assert(h.includes('Sign now &lt;b&gt;'));
  assert(h.includes('<img src="https://s.test/x.jpg"'));
  assert(h.includes('noindex'));
  assert(h.includes('Ready to post.'));
  assert(!h.includes('<script'));
});
ok('a still-editing post says it may change', () => assert(PV.previewHtml({ post: { ...post, status: 'hold' } }).includes('may change')));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
