// Minimal APNs (Apple Push Notification service) sender: hand-rolled ES256
// provider JWT + HTTP/2 request, zero dependencies.
//
// The #1 silent-failure mode is an environment mismatch: device tokens minted
// by an Xcode dev build only work against api.sandbox.push.apple.com, and
// TestFlight/App Store tokens only against api.push.apple.com. A mismatch
// comes back as 400 BadDeviceToken (handled below by dropping the token, so
// re-registration on next app launch heals it once APNS_ENV is corrected).
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

function apnsHost() {
  return process.env.APNS_ENV === 'production'
    ? 'https://api.push.apple.com'
    : 'https://api.sandbox.push.apple.com';
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

// Push `title`/`body` to every device the user has registered. Dead tokens
// (410 Unregistered, 400 BadDeviceToken) are deleted so the table self-heals.
async function pushToUser(userId, title, body, extra = {}) {
  let tokens = [];
  try { tokens = await supa.fetchDeviceTokens(userId); } catch { return; }
  if (!tokens.length) return;

  let jwt;
  try { jwt = providerJwt(); } catch (err) {
    console.error('apns jwt error:', err.message);
    return;
  }

  const session = http2.connect(apnsHost());
  session.on('error', () => {}); // surfaced per-request instead
  try {
    const payload = { aps: { alert: { title, body }, sound: 'default' }, ...extra };
    for (const token of tokens) {
      const { status, reason } = await sendOne(session, token, jwt, payload);
      if (status === 410 || (status === 400 && reason === 'BadDeviceToken')) {
        await supa.deleteDeviceToken(token);
      } else if (status !== 200) {
        console.error(`apns send to …${token.slice(-8)}: ${status} ${reason || ''}`);
      }
    }
  } finally {
    session.close();
  }
}

module.exports = { pushToUser, providerJwt };
