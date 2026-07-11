// Background import job: the client uploads the source video to Storage
// (import-media/{uid}/tmp/...), then POSTs here with its Supabase access
// token. We create the imports row, answer 202 immediately, and do the slow
// work after the response: ffmpeg analysis frames -> Claude generates
// original exercise entries (NO library matching -- that produced wrong and
// missing exercises) -> ffmpeg cuts a real 8fps motion clip per exercise ->
// Storage upload -> row update -> APNs push.
const fs = require('fs');
const path = require('path');

const supa = require('../_lib/supabase.js');
const video = require('../_lib/video.js');
const apns = require('../_lib/apns.js');

const BUCKET = 'import-media';
const MAX_EXERCISES = 20;

// The 20-tag vocabulary the swap feature keys on (from exercise-library.json).
const TYPE_TAGS = ['bridge', 'hinge', 'legraise', 'calf', 'row', 'armraise', 'press', 'curl',
  'legcurl', 'plank', 'squat', 'lunge', 'twist', 'fly', 'crunch', 'pushup', 'pulldown',
  'stretch', 'extension', 'rotation'];

// waitUntil keeps the function alive after the response on Vercel Fluid
// Compute; the local dev harness has no request context, so fall back to a
// detached promise (the harness process stays alive anyway).
function runAfterResponse(promise) {
  try {
    const { waitUntil } = require('@vercel/functions');
    waitUntil(promise);
  } catch {
    promise.catch(err => console.error('background job error:', err));
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { sourceUrl, thumbnailUrl, title, caption, videoPath } = body;

    const auth = String(req.headers.authorization || '');
    const accessToken = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    const userId = await supa.verifyToken(accessToken);
    if (!userId) {
      res.status(401).json({ error: 'Not signed in' });
      return;
    }

    // The video must live in the caller's own tmp folder -- prevents one user
    // pointing the job at another user's uploads.
    if (typeof videoPath !== 'string' || !videoPath.startsWith(`${userId}/tmp/`)) {
      res.status(400).json({ error: 'videoPath must be under your own tmp folder' });
      return;
    }

    const importId = await supa.insertImportRow({
      user_id: userId,
      source_url: sourceUrl || null,
      thumbnail_url: thumbnailUrl || null,
      title: title || null,
      caption: caption || null,
      exercises: [],
      status: 'processing',
    });

    res.status(202).json({ importId });

    runAfterResponse(processJob({ importId, userId, videoPath, title, caption, hasThumb: !!thumbnailUrl }));
  } catch (err) {
    console.error('submit error:', err);
    res.status(500).json({ error: 'Something went wrong accepting the import' });
  }
};

async function processJob({ importId, userId, videoPath, title, caption, hasThumb }) {
  const workdir = video.makeWorkdir();
  try {
    // 1. Pull the source video out of Storage.
    const bytes = await supa.downloadStorageObject(BUCKET, videoPath);
    const localVideo = path.join(workdir, 'source.mp4');
    fs.writeFileSync(localVideo, bytes);

    // 2. Analysis frames (~1fps, max 48, first 180s).
    const duration = await video.probeDuration(localVideo);
    const { frames, timestamps } = await video.analysisFrames(localVideo, workdir, duration);

    // 3. Generate exercise entries.
    const exercises = await generateExercises({ frames, timestamps, title, caption });
    if (!exercises.length) {
      await finishFailed(importId, userId, videoPath, 'No exercises could be identified in this video.');
      return;
    }

    // 4. Real motion clips per exercise (best-effort per clip).
    for (let i = 0; i < exercises.length; i++) {
      const ex = exercises[i];
      if (!ex.frameRange) { ex.gifPath = null; continue; }
      try {
        const [a, b] = ex.frameRange;
        const tStart = timestamps[a] != null ? Math.max(0, timestamps[a] - 0.5) : 0;
        const tEnd = timestamps[b] != null ? timestamps[b] + 0.5 : tStart + 3;
        const gif = await video.cutClipGif(localVideo, workdir, tStart, tEnd, i);
        ex.gifPath = await supa.uploadStorageObject(BUCKET, `${userId}/${importId}/${i}.gif`, gif, 'image/gif');
      } catch (err) {
        console.error(`clip ${i} failed:`, err.message);
        ex.gifPath = null;
      }
    }

    // 5. Thumbnail for camera-roll imports (no OG image).
    const patch = {
      exercises: exercises.map(({ name, dose, weight, cue, type, gifPath }) => ({ name, dose, weight, cue, type, gifPath })),
      status: 'pending',
      error: null,
    };
    if (!hasThumb) {
      try {
        const thumb = await video.firstFrameJpeg(localVideo, workdir);
        patch.thumbnail_url = await supa.uploadStorageObject(BUCKET, `${userId}/${importId}/thumb.jpg`, thumb, 'image/jpeg');
      } catch {}
    }

    // 6. Persist, clean up, notify.
    await supa.updateImportRow(importId, patch);
    await supa.deleteStorageObject(BUCKET, videoPath);
    const n = patch.exercises.length;
    await apns.pushToUser(userId, 'Import ready',
      `${title || 'Your workout'} — ${n} exercise${n === 1 ? '' : 's'} extracted.`, { importId });
  } catch (err) {
    console.error('import job failed:', err);
    await finishFailed(importId, userId, videoPath, String(err.message || err).slice(0, 500));
  } finally {
    video.cleanupWorkdir(workdir);
  }
}

async function finishFailed(importId, userId, videoPath, message) {
  try {
    await supa.updateImportRow(importId, { status: 'failed', error: message });
  } catch (err) {
    console.error('failed-state update failed:', err);
  }
  supa.deleteStorageObject(BUCKET, videoPath);
  try {
    await apns.pushToUser(userId, 'Import failed', message, { importId });
  } catch {}
}

// One Claude call: exhaustive enumeration, original entries, no library.
async function generateExercises({ frames, timestamps, title, caption }) {
  const apiKey = process.env.ANTHROPIC_KEY;
  if (!apiKey) throw new Error('Missing ANTHROPIC_KEY');

  const intro = buildPrompt({ n: frames.length, title, caption });
  const content = [{ type: 'text', text: intro }];
  frames.forEach((dataUrl, i) => {
    content.push({ type: 'text', text: `Frame ${i} — t=${timestamps[i]}s` });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: dataUrl.replace(/^data:image\/jpeg;base64,/, '') },
    });
  });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 8000,
      messages: [{ role: 'user', content }],
    }),
  });
  if (!res.ok) throw new Error(`Analysis call failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');

  let parsed = null;
  const match = text.match(/\{[\s\S]*\}/);
  if (match) { try { parsed = JSON.parse(match[0]); } catch {} }
  const raw = parsed && Array.isArray(parsed.exercises) ? parsed.exercises : [];

  // Normalize defensively; drop malformed entries rather than failing the job.
  const out = [];
  for (const e of raw) {
    if (out.length >= MAX_EXERCISES) break;
    if (!e || typeof e.name !== 'string' || !e.name.trim()) continue;
    let frameRange = null;
    if (Array.isArray(e.frameRange) && e.frameRange.length === 2
        && Number.isFinite(Number(e.frameRange[0])) && Number.isFinite(Number(e.frameRange[1]))) {
      let a = Math.max(0, Math.min(frames.length - 1, Math.round(Number(e.frameRange[0]))));
      let b = Math.max(0, Math.min(frames.length - 1, Math.round(Number(e.frameRange[1]))));
      if (a > b) [a, b] = [b, a];
      frameRange = [a, b];
    }
    out.push({
      name: e.name.trim(),
      dose: typeof e.dose === 'string' && e.dose.trim() ? e.dose.trim() : '3 x 10–12',
      weight: typeof e.weight === 'string' && e.weight.trim() ? e.weight.trim() : 'Bodyweight',
      cue: typeof e.cue === 'string' ? e.cue.trim() : '',
      type: TYPE_TAGS.includes(e.type) ? e.type : '',
      frameRange,
    });
  }
  return out;
}

// Exposed for the local dev harness / tests.
module.exports.generateExercises = generateExercises;

function buildPrompt({ n, title, caption }) {
  const titlePart = title ? ` titled "${String(title).slice(0, 200)}"` : '';
  const captionPart = caption
    ? `, posted with this caption:\n---\n${String(caption).slice(0, 1500)}\n---`
    : '. There is no caption.';
  return `You are the exercise cataloguer for GLEAMO, a strength-training app. You are given ${n} frames sampled at roughly 1-second intervals from a workout video${titlePart}${captionPart}

Your job is to produce an EXHAUSTIVE list of every distinct exercise in this workout. This list becomes real workout entries the user will train from, so completeness and accuracy matter more than brevity.

Rules for finding every exercise:
1. First read the caption (if any) and COUNT the exercises it lists or implies (numbered lists, lines like "3x12 hip thrusts", emoji bullets). Every one of those gets an entry.
2. Then scan the frames in order. Every distinct movement you can see — a change in body position, equipment, or movement pattern — gets an entry, even if the caption doesn't mention it.
3. Reconcile the two: if the caption lists 6 exercises and you can only see 5, still output all 6 (use the caption's details for the one you can't see). If you see a movement the caption skips, include it too. Do NOT merge similar-but-distinct variations (e.g. "glute bridge" and "single-leg glute bridge" are two entries).
4. Output the exercises in the order they are performed in the video.

For each exercise output exactly these fields:
- "name": clean, human-readable exercise name (e.g. "Dumbbell Romanian deadlift", "Banded lateral walk").
- "dose": sets x reps in GLEAMO house format — en dash for ranges, "/side" for unilateral moves, "sec" for timed holds. Examples: "3 x 10–12", "4 x 8–10", "3 x 15–25/side", "2 x 30–45 sec". Use the caption's programming if given, otherwise a sensible default for that movement.
- "weight": short starting-weight suggestion, e.g. "Bodyweight", "15–25 lb DBs", "95–135 lb", "Light band". Prefer what's visible in the video.
- "cue": ONE form cue under 20 words, in GLEAMO's terse coaching voice — imperative, specific, no fluff. Voice examples: "Pause 1 sec at top. Ribs down, chin tucked, shins vertical." / "Hips back, soft knees, feel hamstrings and glutes." / "Slow reps for side glute/hip stability." Base it on what you actually observe in the frames when possible.
- "type": exactly one of: ${TYPE_TAGS.join(', ')}. Pick the closest — this powers exercise-swap suggestions, so never invent a new tag.
- "frameRange": [startIndex, endIndex] — 0-based indices of the FIRST and LAST frame where this exercise is being performed (inclusive; frames are numbered in the input). If the exercise never appears in the frames (caption-only), use null. Ranges of different exercises should not overlap.

Respond with ONLY a JSON object of this exact shape, no markdown fences, no other text:
{"exercises":[{"name":"…","dose":"…","weight":"…","cue":"…","type":"…","frameRange":[0,5]}]}

If the video genuinely shows no identifiable exercise at all, respond with {"exercises":[]}.`;
}
