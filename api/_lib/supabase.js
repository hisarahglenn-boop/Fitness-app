// Server-side Supabase access for the background import job. Uses plain REST
// with the service-role key (SUPABASE_SERVICE_KEY) -- the only server-side
// writer in the codebase; everything else goes through the browser/app under
// RLS. Keep it that way: this module must only ever operate on rows scoped to
// a user id that came out of verifyToken().
const fs = require('fs');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const MAX_VIDEO_BYTES = 160 * 1024 * 1024; // just above the client's 150MB cap

// Storage object paths are user-influenced -- encode each segment so special
// characters (and, combined with caller-side validation, traversal) can't
// reshape the URL. Slashes stay as separators.
function encodeObjectPath(objectPath) {
  return String(objectPath).split('/').map(encodeURIComponent).join('/');
}

function assertEnv() {
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    throw new Error('Missing SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_KEY');
  }
}

// Resolves the caller's user id from their access token, or null.
// No JWT secret needed -- Supabase's own auth endpoint does the verification.
async function verifyToken(accessToken) {
  assertEnv();
  if (!accessToken) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user && user.id ? user.id : null;
}

function serviceHeaders(extra = {}) {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    ...extra,
  };
}

async function insertImportRow(row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/imports`, {
    method: 'POST',
    headers: serviceHeaders({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`imports insert failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  if (!rows[0] || !rows[0].id) throw new Error('imports insert returned no id');
  return rows[0].id;
}

async function updateImportRow(importId, patch) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/imports?id=eq.${encodeURIComponent(importId)}`, {
    method: 'PATCH',
    headers: serviceHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`imports update failed: ${res.status} ${await res.text()}`);
}

// Streams the object to `destPath` instead of buffering it in RAM (source
// videos are up to 150MB). Rejects an oversized object by content-length.
async function downloadStorageObjectToFile(bucket, objectPath, destPath) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${encodeObjectPath(objectPath)}`, {
    headers: serviceHeaders(),
  });
  if (!res.ok) throw new Error(`storage download failed: ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len && len > MAX_VIDEO_BYTES) throw new Error('source video too large');
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));
}

async function uploadStorageObject(bucket, objectPath, bytes, contentType) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${encodeObjectPath(objectPath)}`, {
    method: 'POST',
    headers: serviceHeaders({ 'Content-Type': contentType, 'x-upsert': 'true' }),
    body: bytes,
  });
  if (!res.ok) throw new Error(`storage upload failed: ${res.status} ${await res.text()}`);
  return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${encodeObjectPath(objectPath)}`;
}

async function deleteStorageObject(bucket, objectPath) {
  try {
    await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${encodeObjectPath(objectPath)}`, {
      method: 'DELETE',
      headers: serviceHeaders(),
    });
  } catch {} // best-effort cleanup, never fails the job
}

async function fetchDeviceTokens(userId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/device_tokens?user_id=eq.${encodeURIComponent(userId)}&select=token`,
    { headers: serviceHeaders() },
  );
  if (!res.ok) return [];
  const rows = await res.json();
  return rows.map(r => r.token).filter(Boolean);
}

async function deleteDeviceToken(token) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/device_tokens?token=eq.${encodeURIComponent(token)}`, {
      method: 'DELETE',
      headers: serviceHeaders(),
    });
  } catch {}
}

module.exports = {
  verifyToken,
  insertImportRow,
  updateImportRow,
  downloadStorageObjectToFile,
  uploadStorageObject,
  deleteStorageObject,
  fetchDeviceTokens,
  deleteDeviceToken,
};
