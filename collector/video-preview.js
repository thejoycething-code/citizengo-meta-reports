#!/usr/bin/env node
// Store a small preview of a cut clip in the engine, so the desk's trimmer can
// play it (Play my cut). Runs where SUPABASE_SERVICE_KEY is set (the Mini's
// ~/runner/meta-reports). The file goes to the private engine-media bucket
// under the post's own folder; the desk only ever gets a 1-hour signed link
// for it (engine_preview).
//
//   node collector/video-preview.js <postId> <target> <file.mp4> [--encode]
//
// target: "video" (the post's cut video) or the id of one of its
// videoSuggestions. --encode makes the small copy first (640 px wide, about
// 1 Mbit/s, faststart) with ffmpeg; without it the file is sent as it is.
// Previews are at most 25 MB. Nothing is published anywhere.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { loadEnv } = require('../lib/graph');
const { supabaseStore } = require('../lib/store');
const E = require('../lib/engine');

const MAX = 25 * 1024 * 1024;

function ffmpeg() {
  for (const p of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) if (fs.existsSync(p)) return p;
  try { return execFileSync('python3', ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())']).toString().trim(); } catch (e) { return null; }
}

function encode(file) {
  const ff = ffmpeg();
  if (!ff) throw new Error('ffmpeg not found: install it, or make the preview yourself and run without --encode');
  const out = path.join(os.tmpdir(), `preview-${process.pid}.mp4`);
  execFileSync(ff, ['-loglevel', 'error', '-y', '-i', file, '-vf', "scale='min(640,iw)':-2", '-c:v', 'libx264', '-preset', 'veryfast',
    '-b:v', '900k', '-maxrate', '1200k', '-bufsize', '2400k', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', out]);
  return out;
}

// Where the preview's path goes in the post: the cut video, or one suggestion.
function withPreview(doc, target, p) {
  if (target === 'video') {
    if (!doc.video) throw new Error('This post has no cut video yet');
    return { video: { ...doc.video, preview: p } };
  }
  const list = Array.isArray(doc.videoSuggestions) ? doc.videoSuggestions : [];
  if (!list.some((s) => s && s.id === target)) throw new Error(`No suggestion "${target}" on this post`);
  return { videoSuggestions: list.map((s) => (s && s.id === target ? { ...s, preview: p } : s)) };
}

async function main() {
  const [id, target, file] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!id || !target || !file) { console.error('usage: node collector/video-preview.js <postId> <video|suggestionId> <file.mp4> [--encode]'); process.exit(2); }
  loadEnv();
  const store = supabaseStore({ url: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_KEY });
  const post = await store.enginePost(id);
  if (!post) throw new Error(`No post ${id}`);
  const src = process.argv.includes('--encode') ? encode(file) : file;
  const buf = fs.readFileSync(src);
  if (buf.length > MAX) throw new Error(`The preview is ${(buf.length / 1048576).toFixed(1)} MB; keep it under 25 MB (use --encode)`);
  const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);
  const safe = String(target).replace(/[^a-z0-9-]/gi, '-').slice(0, 40);
  const p = `${post.team_id}/${String(post.id).replace(/[^a-z0-9-]/gi, '-')}/preview-${safe}-${hash}.mp4`;
  await store.engineMediaUpload(p, buf, 'video/mp4');
  const doc = E.mergeDoc(post.doc, withPreview(post.doc || {}, target, p));
  const saved = await store.engineUpdatePost(post.id, post.version, { doc, updated_by: 'import' });
  if (!saved) throw new Error('Someone changed the post meanwhile; run it again');
  await store.engineEvent({ post_id: post.id, team_id: post.team_id, who: 'import', action: 'preview', detail: { target, bytes: buf.length } });
  console.log(`preview stored: ${p} (${(buf.length / 1048576).toFixed(1)} MB)`);
}

if (require.main === module) main().catch((e) => { console.error(e.message || e); process.exit(1); });
module.exports = { withPreview, encode };
