'use strict';
// Video ideas (12 Nov 2026). The morning run suggests videos that people make
// with their OWN Claude (no paid AI, nothing rendered by the engine). A post's
// doc.videoIdea holds the idea; engine_create and engine_save tidy it and write
// the ready-to-copy prompts here, so every prompt carries the same brand rules.
//
//   doc.videoIdea = {
//     standalone: true,      // its own idea, in Drafts › Video ideas (false: an
//                            // optional "Make it a video" on a normal draft)
//     route: 'make' | 'film',// make: Claude draws an animated-words MP4
//                            // film: Claude writes the shoot for a person to film
//     seconds: 15,           // 6-60
//     brand: 'CitizenGO UK', // optional, the account name on the end card
//     beats: [{ text, secs, look, shot }],  // look: plain | blue (make);
//                            // shot: what the camera sees (film). *word* = highlight
//     ask: 'Sign the petition: link in the first comment',  // optional last line
//     notes: '...',          // optional extra direction for Claude
//     prompts: { make, film } // written here, never by hand
//   }
// Both prompts are always written, so a person can switch route on the desk.

const ROUTES = ['make', 'film'];
const LOOKS = ['plain', 'blue'];
const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const BRAND_BLUE = '#4285F4';
const INK = '#3C4043';

function brandFor(team, vi) {
  if (vi && vi.brand) return clean(vi.brand, 40);
  if (team && team.id === 'uk') return 'CitizenGO UK';
  if (team && team.id === 'mx') return 'CitizenGO México';
  return 'CitizenGO';
}

// Tidy what the run (or a person) sent. Returns null when there's nothing usable.
function normalize(vi, { team } = {}) {
  if (!vi || typeof vi !== 'object') return null;
  const beats = (Array.isArray(vi.beats) ? vi.beats : []).slice(0, 8).map((b) => {
    const o = typeof b === 'string' ? { text: b } : (b || {});
    const out = { text: clean(o.text, 220) };
    const s = Number(o.secs);
    if (s > 0) out.secs = Math.min(15, Math.max(1, Math.round(s * 2) / 2));
    if (LOOKS.includes(o.look)) out.look = o.look;
    if (o.shot) out.shot = clean(o.shot, 200);
    return out;
  }).filter((b) => b.text);
  if (!beats.length) return null;
  const route = ROUTES.includes(vi.route) ? vi.route : 'make';
  const given = beats.reduce((n, b) => n + (b.secs || 0), 0);
  let seconds = Number(vi.seconds) > 0 ? Math.round(Number(vi.seconds)) : (given || (route === 'film' ? 30 : beats.length * 4));
  seconds = Math.min(60, Math.max(6, seconds));
  const out = { standalone: vi.standalone !== false, route, seconds, brand: brandFor(team, vi), beats };
  if (vi.ask) out.ask = clean(vi.ask, 140);
  if (vi.notes) out.notes = clean(vi.notes, 600);
  out.prompts = { make: makePrompt(out), film: filmPrompt(out) };
  return out;
}

// Seconds per beat: the ones given, the rest share what's left (at least 2 s each).
function timeline(vi) {
  const fixed = vi.beats.reduce((n, b) => n + (b.secs || 0), 0);
  const open = vi.beats.filter((b) => !b.secs).length;
  const each = open ? Math.max(2, Math.round(((vi.seconds - fixed) / open) * 2) / 2) : 0;
  let t = 0;
  return vi.beats.map((b) => {
    const len = b.secs || each;
    const span = { from: t, to: t + len, beat: b };
    t += len;
    return span;
  });
}
const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const plain = (s) => s.replace(/\*([^*]+)\*/g, '$1');

function makePrompt(vi) {
  const tl = timeline(vi);
  const total = tl.length ? tl[tl.length - 1].to : vi.seconds;
  const screens = tl.map(({ from, to, beat }) => {
    const hi = (beat.text.match(/\*([^*]+)\*/g) || []).map((w) => w.slice(1, -1));
    const look = beat.look === 'blue' ? ' (full Brand Blue background, white text)' : (hi.length ? ` (${hi.map((w) => `"${w}"`).join(', ')} in Brand Blue)` : '');
    return `${fmt(from)}-${fmt(to)} s: "${plain(beat.text)}"${look}`;
  });
  const end = `${fmt(total)}-${fmt(total + 3)} s: end card, "${vi.brand}" large in Brand Blue${vi.ask ? `, then "${vi.ask}"` : ''}.`;
  return [
    `Make me a vertical video for ${vi.brand}'s Instagram Reel and Facebook.`,
    '',
    `Format: MP4, 1080 x 1920, 30 fps, about ${fmt(total + 3)} seconds, no sound.`,
    'How: use your code and file tools. Draw each frame in Python (Pillow) and join them into an MP4 with ffmpeg, then give me the MP4 to download. If you can\'t create files, build it as an animated artifact I can screen-record instead, and tell me so.',
    '',
    `Style: white background, text in dark grey ${INK}, highlighted words in Brand Blue ${BRAND_BLUE}. Roboto Black (or a similar heavy sans-serif), left aligned, very large: one short idea per screen. Each screen fades and slides up gently over 0.3 s. Keep the bottom 25% empty, because Instagram covers it. "CitizenGO" small in Brand Blue at the bottom left of every screen. No photos, no people, no AI images, no music. No yellow, gold or pastel colours.`,
    '',
    'Screens:',
    ...screens,
    end,
    ...(vi.notes ? ['', `Also: ${vi.notes}`] : []),
    '',
    'Use exactly these words. Don\'t add facts, numbers or names. When it\'s done, show me one still of each screen so I can check them.',
  ].join('\n');
}

function filmPrompt(vi) {
  const tl = timeline(vi);
  const lines = tl.map(({ beat }, i) => `${i + 1}. "${plain(beat.text)}"${beat.shot ? ` (shot: ${beat.shot})` : ''}`);
  const secs = Math.max(15, vi.route === 'film' ? vi.seconds : Math.min(45, vi.seconds * 2));
  return [
    `Help me film a short vertical video for ${vi.brand}'s Instagram Reel and Facebook. I'll film it on my phone.`,
    '',
    'What it says, in this order:',
    ...lines,
    ...(vi.ask ? [`Last line: "${vi.ask}"`] : []),
    ...(vi.notes ? ['', `Also: ${vi.notes}`] : []),
    '',
    'Please give me:',
    `1. A script I can say to camera in about ${secs} seconds, warm and plain, in the first person, keeping the points above in this order.`,
    '2. A shot list for a phone held upright: where to film, framing, and two or three cutaway shots that need no one\'s face but mine.',
    '3. Short on-screen text for each line (big words, up to 6 per screen).',
    '4. A captions file (.srt) that matches the script, to upload to CapCut or Instagram.',
    '5. A caption for the post, under 600 characters, with up to 5 hashtags.',
    '',
    'Don\'t add statistics, names or claims I haven\'t given you. Keep it hopeful, not angry.',
  ].join('\n');
}

// For engine_create / engine_save: the doc with its video idea tidied, or the
// doc unchanged when it has none. An unusable idea is dropped, not stored.
function applyToDoc(doc, team) {
  if (!doc || typeof doc !== 'object' || !('videoIdea' in doc)) return doc;
  const vi = doc.videoIdea == null ? null : normalize(doc.videoIdea, { team });
  const out = { ...doc };
  if (vi) out.videoIdea = vi; else delete out.videoIdea;
  if (vi && vi.standalone && !out.type) out.type = 'Video';
  return out;
}

module.exports = { normalize, makePrompt, filmPrompt, applyToDoc, timeline, ROUTES };
