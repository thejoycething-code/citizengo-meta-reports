#!/usr/bin/env node
// Tools › Clip a video: store one finished version of a requested clip where
// the desk can fetch it, and mark the request done. Runs where
// SUPABASE_SERVICE_KEY is set (the Mini's ~/runner/meta-reports).
//
//   node collector/clip-upload.js <requestId> <team> <version> <file.mp4> [--last]
//
// version: reel, facebook or x. The file goes to the private engine-media
// bucket at <team>/clips/<requestId>/<version>.mp4 (the desk gets a 1-hour
// signed link through engine_preview). Over 25 MB it is re-encoded smaller
// first. --last marks the request done with every version stored so far.
// Nothing is published anywhere.

const fs = require('fs');
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');
const { loadEnv } = require('../lib/graph');
const { supabaseStore } = require('../lib/store');
const D = require('../lib/desk');

const MAX = 25 * 1024 * 1024;

function smaller(file) {
  let ff = null;
  for (const p of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) if (fs.existsSync(p)) ff = p;
  if (!ff) try { ff = execFileSync('python3', ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())']).toString().trim(); } catch (e) { ff = null; }
  if (!ff) throw new Error('The clip is over 25 MB and ffmpeg is not here to make it smaller.');
  const out = path.join(os.tmpdir(), `clip-${process.pid}.mp4`);
  execFileSync(ff, ['-loglevel', 'error', '-y', '-i', file, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-maxrate', '2500k', '-bufsize', '5000k', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', out]);
  return out;
}

const clipPath = (team, id, version) => `${team}/clips/${id}/${version}.mp4`;

async function main() {
  loadEnv();
  const [id, team, version, file] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const last = process.argv.includes('--last');
  if (!id || !/^[a-z0-9-]+$/i.test(id) || !team || !/^[a-z]{2,10}$/.test(team) || !['reel', 'facebook', 'x'].includes(version) || !file || !fs.existsSync(file)) {
    console.error('usage: node collector/clip-upload.js <requestId> <team> <reel|facebook|x> <file.mp4> [--last]'); process.exit(2);
  }
  const store = supabaseStore({ url: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_KEY });
  let f = file;
  if (fs.statSync(f).size > MAX) f = smaller(f);
  if (fs.statSync(f).size > MAX) throw new Error('Still over 25 MB after re-encoding: cut it shorter.');
  const p = clipPath(team, id, version);
  await store.engineMediaUpload(p, fs.readFileSync(f), 'video/mp4');
  const cur = (await D.docsList('videoRequests', { limit: 1000 })).find((r) => r.id === id);
  const data = (cur && cur.data) || {};
  const files = [...(data.files || []).filter((x) => x.version !== version), { version, path: p }];
  await D.docsPut('videoRequests', id, { ...data, files, ...(last ? { status: 'done', done_at: new Date().toISOString() } : {}) }, 'engine-run');
  console.log(`stored ${p}${last ? '; request done' : ''}`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { clipPath };
