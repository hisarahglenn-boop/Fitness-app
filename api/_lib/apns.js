// Minimal APNs (Apple Push Notification service) sender: hand-rolled ES256
// provider JWT + HTTP/2 request, zero dependencies.
//
// Environment mismatch used to be the #1 silent-failure mode: device tokens
// minted by an Xcode dev build only work against api.sandbox.push.apple.com,
// and TestFlight/App Store tokens only against api.push.apple.com. Since a
// single database mixes both (Sarah runs a dev build; testers run TestFlight),
// APNS_ENV alone can never be right for everyone. So we try the configured
// gateway FIRST, and on a wrong-environment rejection retry the OTHER gateway
// before giving up -- a token is only deleted when BOTH gateways reject it.
const crypto = require('crypto');
const http2 = require('http2');

const supa = require('./supabase.js');

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// APNs requires provider tokens younger than 60 minutes but throttles minting
// more than ~1/20min, so cache at module scope (warm serverless instances
// share it) and reuse for 45 minutes.
let cachedJwt = null;
let cachedAt = 0;

function providerJwt() {
  const now = Date.now();
  if (cachedJwt && now - cachedAt < 45 * 60 * 1000) return cachedJwt;

  const keyPem = String(process.env.APNS_KEY_P8 || '').replace(/\\n/g, '\n');
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APPLE_TEAM_ID;
  if (!keyPem || !keyId || !teamId) throw new Error('Missing APNS_KEY_P8 / APNS_KEY_ID / APPLE_TEAM_ID');

  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const payload = b64url(JSON.stringify({ iss: teamId, iat: Math.floor(now / 1000) }));
  const signingInput = `${header}.${payload}`;
  // dsaEncoding 'ieee-p1363' emits the raw 64-byte R||S signature JOSE/APNs
  // require -- the default DER encoding is rejected.
  const sig = crypto.createSign('SHA256').update(signingInput).sign({ key: keyPem, dsaEncoding: 'ieee-p1363' });
  if (sig.length !== 64) throw new Error(`ES256 signature is ${sig.length} bytes, expected 64`);
  cachedJwt = `${signingInput}.${b64url(sig)}`;
  cachedAt = now;
  return cachedJwt;
}

const PROD_HOST = 'https://api.push.apple.com';
const SANDBOX_HOST = 'https://api.sandbox.push.apple.com';

// Configured gateway first, the other as fallback. APNS_ENV just decides which
// one we try first (a small latency optimization for the common case); both
// are always available so dev and TestFlight tokens both deliver.
function gatewayOrder() {
  return process.env.APNS_ENV === 'production'
    ? [PROD_HOST, SANDBOX_HOST]
    : [SANDBOX_HOST, PROD_HOST];
}

// A response that means "this token is not valid on THIS gateway" -- either
// wrong environment (400 BadDeviceToken) or gone (410 Unregistered). Only a
// token that draws this from BOTH gateways is truly dead.
function isTokenRejected(status, reason) {
  return status === 410 || (status === 400 && reason === 'BadDeviceToken');
}

// Sends one alert push. Resolves { status, reason } -- never rejects for
// delivery problems (push is strictly best-effort).
function sendOne(session, token, jwt, payload) {
  return new Promise(resolve => {
    const req = session.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${jwt}`,
      'apns-topic': process.env.APNS_TOPIC || 'gleamo.lol.Gleamo',
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    });
    let status = 0;
    let body = '';
    req.setTimeout(15_000, () => { req.close(); resolve({ status: 0, reason: 'timeout' }); });
    req.on('response', headers => { status = headers[':status']; });
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let reason = null;
      try { reason = JSON.parse(body).reason || null; } catch {}
      resolve({ status, reason });
    });
    req.on('error', err => resolve({ status: 0, reason: String(err.message) }));
    req.end(JSON.stringify(payload));
  });
}

// Push `title`/`body` to every device the user has registered. A token is
// deleted only when BOTH gateways reject it, so a dev token never gets nuked
// by the production gateway (or vice versa) -- the exact bug that killed
// TestFlight testers' pushes.
async function pushToUser(userId, title, body, extra = {}) {
  let tokens = [];
  try { tokens = await supa.fetchDeviceTokens(userId); } catch { return; }
  if (!tokens.length) return;

  let jwt;
  try { jwt = providerJwt(); } catch (err) {
    console.error('apns jwt error:', err.message);
    return;
  }

  const [primaryHost, fallbackHost] = gatewayOrder();
  // Sessions are opened lazily and reused across all tokens. The fallback
  // connection is only made if some token needs it (the common case never
  // touches it).
  const sessions = {};
  function sessionFor(host) {
    if (!sessions[host]) {
      const s = http2.connect(host);
      s.on('error', () => {}); // surfaced per-request instead
      sessions[host] = s;
    }
    return sessions[host];
  }

  try {
    const payload = { aps: { alert: { title, body }, sound: 'default' }, ...extra };
    for (const token of tokens) {
      const primary = await sendOne(sessionFor(primaryHost), token, jwt, payload);
      if (primary.status === 200) continue;

      if (isTokenRejected(primary.status, primary.reason)) {
        // Might just be the other environment -- try the fallback gateway
        // before deleting.
        const fallback = await sendOne(sessionFor(fallbackHost), token, jwt, payload);
        if (fallback.status === 200) continue;
        if (isTokenRejected(fallback.status, fallback.reason)) {
          await supa.deleteDeviceToken(token); // dead on both -> truly gone
        } else {
          console.error(`apns fallback to …${token.slice(-8)}: ${fallback.status} ${fallback.reason || ''}`);
        }
      } else {
        // Transient (timeout, 429, 5xx) -- leave the token alone, retry next push.
        console.error(`apns send to …${token.slice(-8)}: ${primary.status} ${primary.reason || ''}`);
      }
    }
  } finally {
    for (const s of Object.values(sessions)) s.close();
  }
}

module.exports = { pushToUser, providerJwt };
