#!/usr/bin/env node
'use strict';
// What is SAID in an Instagram Reel.
//
// Meta does not offer this. Probed on Graph v23.0, 21 Sept 2026
// (scripts/probe-ig-video-source.js): media_url returns a fetchable mp4, while
// captions, transcript and source are all refused with HTTP 400. So the only
// route to the spoken word is to fetch the file and run speech recognition
// over it ourselves.
//
//   node collector/transcribe-ig.js [--limit 25] [--since 2026-08-01]
//                                   [--media-id X] [--redo] [--dry-run]
//                                   [--budget-minutes 300]
//
// Runs in Actions, not on a laptop: META_TOKENS is a repository secret and is
// deliberately absent from local .env files.
//
// TWO RULES THIS FILE EXISTS TO KEEP
//
//   1. media_url is a SHORT-LIVED signed CDN URL. It is requested and consumed
//      inside the same iteration and never stored. Storing it would produce a
//      table of links that quietly stop working.
//   2. A failure is a ROW, with error set. A media_id absent from the
//      transcript table means "not attempted"; a row with an error means
//      "tried and could not". A backfill that skips failures silently stops
//      covering a page and nobody finds out for weeks.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { loadEnv, makeClient } = require('../lib/graph');

loadEnv();

const { makePageTokens } = require('../lib/pagetokens');

const VERSION = process.env.GRAPH_VERSION || 'v23.0';
const ENGINE = 'whisper.cpp';
const MODEL = process.env.WHISPER_MODEL || 'small';
const WHISPER_BIN = process.env.WHISPER_BIN || 'whisper-cli';
const MODEL_PATH = process.env.WHISPER_MODEL_PATH || `models/ggml-${MODEL}.bin`;
const THREADS = process.env.WHISPER_THREADS || String(os.cpus().length || 2);

// A Reel is seconds long. Anything claiming to be much longer is not a Reel we
// want to spend a runner hour on, and is usually a mis-typed media record.
const MAX_SECONDS = Number(process.env.TRANSCRIBE_MAX_SECONDS || 900);
const MAX_BYTES = Number(process.env.TRANSCRIBE_MAX_BYTES || 200 * 1024 * 1024);

function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  if (hit === `--${name}`) return true;
  return hit.split('=').slice(1).join('=');
}

const LIMIT = Number(arg('limit', 0)) || 0;
const SINCE = arg('since', null);
const ONE = arg('media-id', null);
const REDO = !!arg('redo', false);
const DRY = !!arg('dry-run', false);
const BUDGET_MIN = Number(arg('budget-minutes', 0)) || 0;

const SB = String(process.env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

async function rest(pathname, init = {}) {
  const res = await fetch(`${SB}/rest/v1/${pathname}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// Every VIDEO media not yet attempted, oldest first so a partial run leaves a
// contiguous covered tail rather than a random scatter.
// A video with no audio track will never produce a transcript, no matter how
// many times it is retried, and each retry costs a fresh download. It is
// SETTLED, not failed - recorded with this prefix and never picked up again.
// Without it the backfill would carry a growing tail of silent videos it
// re-downloads on every run forever.
const NO_AUDIO = 'no-audio: ';
const isNoAudio = (msg) => /does not contain any stream|Output file .* no audio|does not contain any audio/i.test(String(msg));

async function pending() {
  if (ONE) {
    return rest(`meta_ig_media?select=media_id,page_id,timestamp,permalink&media_id=eq.${encodeURIComponent(ONE)}`);
  }
  // Settled = transcribed, or proven to have no audio to transcribe.
  const done = REDO ? [] : await rest(
    `meta_ig_media_transcript?select=media_id&or=(error.is.null,error.like.${encodeURIComponent(NO_AUDIO)}*)&limit=100000`);
  const seen = new Set(done.map((r) => r.media_id));
  const parts = ['select=media_id,page_id,timestamp,permalink', 'media_type=eq.VIDEO', 'order=timestamp.asc', 'limit=100000'];
  if (SINCE) parts.push(`timestamp=gte.${encodeURIComponent(SINCE)}`);
  const all = await rest(`meta_ig_media?${parts.join('&')}`);
  const todo = all.filter((m) => !seen.has(m.media_id));
  return LIMIT ? todo.slice(0, LIMIT) : todo;
}

async function save(row) {
  if (DRY) return;
  await rest('meta_ig_media_transcript?on_conflict=media_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([row]),
  });
}

// ffmpeg straight from the URL to 16 kHz mono wav, which is the only input
// whisper.cpp accepts. Piping avoids writing the mp4 at all: at 3-16 MB a Reel
// that is not a lot of disk, but 402 of them in one run would be.
function toWav(url, wav) {
  const r = spawnSync('ffmpeg', [
    '-nostdin', '-loglevel', 'error',
    '-i', url,
    '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav',
    '-y', wav,
  ], { encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 1 << 24 });
  if (r.status !== 0) throw new Error(`ffmpeg: ${(r.stderr || r.error || 'failed').toString().trim().slice(0, 200)}`);
  const size = fs.statSync(wav).size;
  // 16-bit mono at 16 kHz is 32000 bytes per second, minus a 44-byte header.
  return { seconds: Math.round(((size - 44) / 32000) * 10) / 10, wavBytes: size };
}

function runWhisper(wav, outBase) {
  const r = spawnSync(WHISPER_BIN, [
    '-m', MODEL_PATH,
    '-f', wav,
    '-t', THREADS,
    '-l', 'auto',          // nine-plus languages in this corpus; never assume
    '-otxt', '-oj',        // text for reading, json for the detected language
    '-of', outBase,
    '-np', '-nt',          // no progress spam, no timestamps in the txt
  ], { encoding: 'utf8', timeout: 30 * 60 * 1000, maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`whisper: ${(r.stderr || r.error || 'failed').toString().trim().slice(-300)}`);

  const txt = fs.existsSync(`${outBase}.txt`) ? fs.readFileSync(`${outBase}.txt`, 'utf8').trim() : '';
  let language = null;
  try {
    const j = JSON.parse(fs.readFileSync(`${outBase}.json`, 'utf8'));
    language = (j.result && j.result.language) || null;
  } catch (e) { /* the txt is the artefact; a missing json costs us the label only */ }
  return { transcript: txt, language };
}

async function main() {
  if (!SB || !KEY) { console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required'); process.exit(2); }
  const tokens = String(process.env.META_TOKENS || process.env.META_TOKEN || '')
    .split(/[\n,]/).map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) { console.error('No token. Set META_TOKENS or META_TOKEN.'); process.exit(2); }

  if (!DRY) {
    try { execFileSync(WHISPER_BIN, ['-h'], { stdio: 'ignore' }); }
    catch (e) { console.error(`${WHISPER_BIN} not on PATH — build whisper.cpp first (see the workflow)`); process.exit(2); }
    if (!fs.existsSync(MODEL_PATH)) { console.error(`model missing: ${MODEL_PATH}`); process.exit(2); }
  }

  const client = makeClient({ token: tokens[0], version: VERSION });
  const pt = makePageTokens(client, tokens);
  await pt.enumeratePages();

  const todo = await pending();
  console.log(`${todo.length} Reel(s) to transcribe · model ${MODEL} · ${THREADS} threads${DRY ? ' · DRY RUN' : ''}`);
  if (BUDGET_MIN) console.log(`budget ${BUDGET_MIN} min of audio`);
  if (!todo.length) { console.log('nothing to do'); return; }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-asr-'));
  let ok = 0; let failed = 0; let settled = 0; let seconds = 0;

  for (const [i, m] of todo.entries()) {
    const tag = `[${i + 1}/${todo.length}] ${m.media_id}`;
    if (BUDGET_MIN && seconds / 60 >= BUDGET_MIN) {
      console.log(`${tag} — stopping: ${Math.round(seconds / 60)} min of audio done, budget reached`);
      break;
    }
    const wav = path.join(tmp, `${m.media_id}.wav`);
    const outBase = path.join(tmp, m.media_id);
    try {
      // Requested here and used immediately: the URL is signed and short-lived.
      const tok = (await pt.tokenFor(m.page_id)) || tokens[0];
      const r = await client.get(`/${m.media_id}`, { fields: 'media_url,media_type' }, { token: tok });
      if (!r.ok || !r.body.media_url) {
        throw new Error(`no media_url: ${(r.body && r.body.error && r.body.error.message) || `HTTP ${r.status}`}`);
      }

      const head = await fetch(r.body.media_url, { method: 'HEAD' });
      const bytes = Number(head.headers.get('content-length') || 0);
      if (bytes > MAX_BYTES) throw new Error(`refusing ${bytes} bytes (over ${MAX_BYTES})`);

      if (DRY) { console.log(`${tag} — would transcribe (${bytes} bytes)`); ok++; continue; }

      const { seconds: secs } = toWav(r.body.media_url, wav);
      if (secs > MAX_SECONDS) throw new Error(`refusing ${secs}s of audio (over ${MAX_SECONDS}s)`);
      const { transcript, language } = runWhisper(wav, outBase);
      seconds += secs;

      await save({
        media_id: m.media_id, page_id: m.page_id, transcript: transcript || null,
        language, duration_seconds: secs, engine: ENGINE, model: MODEL,
        source_bytes: bytes || null, transcribed_at: new Date().toISOString(),
        error: transcript ? null : 'whisper returned no text',
      });
      ok++;
      console.log(`${tag} — ${secs}s ${language || '??'} · ${transcript.length} chars · "${transcript.slice(0, 60).replace(/\s+/g, ' ')}…"`);
    } catch (e) {
      const silent = isNoAudio(e.message);
      if (silent) settled++; else failed++;
      // The row is the point: without it this media looks untried forever.
      try {
        await save({
          media_id: m.media_id, page_id: m.page_id, transcript: null, language: null,
          duration_seconds: null, engine: ENGINE, model: MODEL, source_bytes: null,
          transcribed_at: new Date().toISOString(),
          error: (silent ? NO_AUDIO : '') + String(e.message).slice(0, 480),
        });
      } catch (e2) { console.error(`${tag} — could not even record the failure: ${e2.message}`); }
      if (silent) console.log(`${tag} — no audio track, nothing to transcribe (settled, will not retry)`);
      else console.error(`${tag} — FAILED: ${e.message}`);
    } finally {
      for (const f of [wav, `${outBase}.txt`, `${outBase}.json`]) {
        try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) { /* tmp dir goes anyway */ }
      }
    }
  }

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  console.log(`\n${ok} transcribed, ${settled} with no audio, ${failed} failed, ${Math.round(seconds / 60)} min of audio`);
  // A failure is recorded, not fatal: a run that stops at the first bad Reel
  // never gets through a backfill. The rows say what happened.
  if (ok === 0 && failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
