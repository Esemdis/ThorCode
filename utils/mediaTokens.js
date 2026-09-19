/**
 * The credential in a media URL.
 *
 * A <video> element and an <img> tag issue their own requests and send no
 * Authorization header, so a bearer token cannot protect the bytes. The URL has
 * to carry its own proof, exactly as utils/calendarToken.js does for the
 * calendar feed.
 *
 * Two differences from that one, both deliberate. This token is signed rather
 * than random, so nothing has to be stored per file. And it expires, because a
 * media URL is far more likely to be pasted into a chat than a feed URL is.
 */

const crypto = require('node:crypto');

// Six hours. Long enough that a browsing session never breaks mid-scroll, short
// enough that a URL shared by accident stops working the same day.
const MEDIA_TOKEN_TTL_SECONDS = 6 * 60 * 60;

const MEDIA_PATH = '/data/concerts/media';

function mediaSecret(override) {
  const secret = override ?? process.env.MEDIA_URL_SECRET;
  if (!secret) throw new Error('MEDIA_URL_SECRET is not set');
  return secret;
}

const sign = (payload, secret) =>
  crypto.createHmac('sha256', secret).update(payload).digest('base64url');

/**
 * @param {{ mediaId: number, userId: string, secret?: string, now?: number }} args
 *   `now` is seconds since the epoch, injectable so the tests can pin it.
 * @returns {string}
 */
function signMediaToken({ mediaId, userId, secret, now = Math.floor(Date.now() / 1000) }) {
  const key = mediaSecret(secret);
  const payload = Buffer
    .from(JSON.stringify({ m: mediaId, u: userId, e: now + MEDIA_TOKEN_TTL_SECONDS }))
    .toString('base64url');
  return `${payload}.${sign(payload, key)}`;
}

/**
 * Check a token against the file it is being used for.
 *
 * The media id is inside the signature, not just in the path: without it one
 * valid URL would unlock every file in the archive.
 *
 * Returns a reason rather than throwing so the route can log which check failed
 * while telling the client only that it was refused.
 */
function verifyMediaToken(token, { mediaId, secret, now = Math.floor(Date.now() / 1000) }) {
  let key;
  try {
    key = mediaSecret(secret);
  } catch {
    return { ok: false, reason: 'unconfigured' };
  }

  const parts = String(token ?? '').split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [payload, provided] = parts;

  const expected = sign(payload, key);
  // Compare through timingSafeEqual: a plain === leaks where the first byte
  // differs, which is enough to forge a signature a byte at a time.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature' };
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (claims.m !== mediaId) return { ok: false, reason: 'mismatch' };
  if (!(claims.e > now)) return { ok: false, reason: 'expired' };
  return { ok: true, userId: claims.u };
}

/**
 * The two absolute URLs for one media row.
 *
 * Built from the configured public base URL and never from the incoming
 * request: behind a proxy the request host is whatever the proxy passes along,
 * and the frontend is on a different origin entirely.
 */
function mediaUrls(baseUrl, mediaId, token) {
  if (!baseUrl) throw new Error('No public base URL configured (CALLBACK_URL)');
  const base = String(baseUrl).replace(/\/+$/, '');
  const q = `?t=${encodeURIComponent(token)}`;
  return {
    file: `${base}${MEDIA_PATH}/${mediaId}/file${q}`,
    thumb: `${base}${MEDIA_PATH}/${mediaId}/thumb${q}`,
  };
}

module.exports = { MEDIA_TOKEN_TTL_SECONDS, signMediaToken, verifyMediaToken, mediaUrls };
