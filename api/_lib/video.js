// ffmpeg helpers for the background import job. Files under api/_lib are not
// deployed as functions (underscore prefix) -- this is plain library code.
//
// All work happens in /tmp (the only writable path on Vercel). Callers own
// cleanup via makeWorkdir()/cleanupWorkdir().
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ffmpegPath = require('ffmpeg-static');

const EXEC_OPTS = { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 };

function run(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, EXEC_OPTS, (err, stdout, stderr) => {
      // ffmpeg writes its banner/progress to stderr even on success; only a
      // nonzero exit is an error, but stderr is where all the info lives.
      if (err && err.code !== 0 && !err.killed) {
        reject(new Error(`ffmpeg failed: ${String(stderr).slice(-400)}`));
      } else if (err && err.killed) {
        reject(new Error('ffmpeg timed out'));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function makeWorkdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gleamo-import-'));
}

function cleanupWorkdir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// Duration in seconds, parsed from ffmpeg's stderr banner ("Duration:
// 00:00:31.42") -- ffprobe isn't bundled and isn't needed for this.
async function probeDuration(file) {
  // -f null exits after reading headers + a decode pass; -t 0.1 keeps it fast.
  const { stderr } = await run(['-hide_banner', '-i', file, '-t', '0.1', '-f', 'null', '-']);
  const m = String(stderr).match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) throw new Error('Could not read video duration');
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// Evenly-sampled analysis frames: ~1fps capped at maxFrames, 360px wide,
// JPEG. Returns { frames: [dataUrl...], timestamps: [seconds...], fps }.
async function analysisFrames(file, workdir, duration, maxFrames = 48) {
  const usable = Math.min(duration, 180); // cap processing at the first 3 min
  const count = Math.min(maxFrames, Math.max(4, Math.round(usable)));
  const fps = count / usable;
  const pattern = path.join(workdir, 'frame-%03d.jpg');
  await run([
    '-hide_banner', '-i', file,
    '-t', String(usable),
    '-vf', `fps=${fps},scale=360:-2`,
    '-q:v', '5',
    pattern,
  ]);
  const files = fs.readdirSync(workdir)
    .filter(f => f.startsWith('frame-') && f.endsWith('.jpg'))
    .sort();
  const frames = [];
  const timestamps = [];
  files.forEach((f, i) => {
    if (i >= maxFrames) return;
    const data = fs.readFileSync(path.join(workdir, f));
    frames.push('data:image/jpeg;base64,' + data.toString('base64'));
    // fps filter emits frame i at ~ (i + 0.5) / fps seconds of source time.
    timestamps.push(Number(((i + 0.5) / fps).toFixed(1)));
  });
  if (!frames.length) throw new Error('No frames could be extracted');
  return { frames, timestamps, fps };
}

// A real motion clip: up to `maxLen` seconds centered in [tStart, tEnd],
// 8fps, 360px, ffmpeg's palettegen/paletteuse for quality, infinite loop.
// Returns the GIF bytes.
async function cutClipGif(file, workdir, tStart, tEnd, index, maxLen = 4) {
  const segLen = Math.max(0.5, tEnd - tStart);
  const len = Math.min(maxLen, segLen);
  const start = Math.max(0, tStart + (segLen - len) / 2);
  const out = path.join(workdir, `clip-${index}.gif`);
  await run([
    '-hide_banner',
    '-ss', start.toFixed(2),
    '-t', len.toFixed(2),
    '-i', file,
    '-vf', 'fps=8,scale=360:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
    '-loop', '0',
    out,
  ]);
  return fs.readFileSync(out);
}

// First-frame JPEG (thumbnail for camera-roll imports that have no OG image).
async function firstFrameJpeg(file, workdir) {
  const out = path.join(workdir, 'thumb.jpg');
  await run(['-hide_banner', '-i', file, '-frames:v', '1', '-vf', 'scale=360:-2', '-q:v', '5', out]);
  return fs.readFileSync(out);
}

module.exports = { makeWorkdir, cleanupWorkdir, probeDuration, analysisFrames, cutClipGif, firstFrameJpeg, ffmpegPath };
