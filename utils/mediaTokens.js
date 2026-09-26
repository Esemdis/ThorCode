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

// Six hours at the least. Long enough that a browsing session never breaks
// mid-scroll, short enough that a URL shared by accident stops working the same
// day. The real lifetime runs up to an hour longer; see EXPIRY_STEP_SECONDS.
const MEDIA_TOKEN_TTL_SECONDS = 6 * 60 * 60;

// Every token minted within one clock hour carries the same expiry: the end of
// that hour, plus the TTL. The expiry is part of the signed payload, so at
// one-second resolution every listing minted a different URL for the same
// file, and the byte routes' year-long `immutable` cache — keyed by URL — never
// got a second hit: every refetch in the app downloaded every thumbnail and
// clip again. Rounded up to the hour, a token is byte-identical all hour, and
// still valid for at least the TTL however late in the hour it was minted.
const EXPIRY_STEP_SECONDS = 60 * 60;

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
  if (typeof userId !== 'string') throw new Error('userId must be a string');
  const key = mediaSecret(secret);
  const expires = (Math.floor(now / EXPIRY_STEP_SECONDS) + 1) * EXPIRY_STEP_SECONDS
    + MEDIA_TOKEN_TTL_SECONDS;
  const payload = Buffer
    .from(JSON.stringify({ m: mediaId, u: userId, e: expires }))
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
function verifyMediaToken(token, { mediaId, secret, now } = {}) {
  // Coerce now to current time if null or non-numeric, since null disables expiry
  // and a string expiry would coerce and pass the comparison.
  const timestamp = typeof now === 'number' ? now : Math.floor(Date.now() / 1000);

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

  // A validly-signed payload is still untrusted input. Every field here feeds an
  // authorisation decision, so validate the shape: m and e must be numbers, u must
  // be a string. This also prevents undefined userId and non-numeric expiry coercion.
  if (typeof claims !== 'object' || claims === null
      || typeof claims.m !== 'number'
      || typeof claims.e !== 'number'
      || typeof claims.u !== 'string') {
    return { ok: false, reason: 'malformed' };
  }

  if (claims.m !== mediaId) return { ok: false, reason: 'mismatch' };
  if (!(claims.e > timestamp)) return { ok: false, reason: 'expired' };
  return { ok: true, userId: claims.u };
}

/**
 * The absolute URLs for one media row.
 *
 * Built from the configured public base URL and never from the incoming
 * request: behind a proxy the request host is whatever the proxy passes along,
 * and the frontend is on a different origin entirely.
 */
function mediaUrls(baseUrl, mediaId, token) {
  if (!baseUrl) throw new Error('No public base URL configured (CALLBACK_URL)');
  const base = String(baseUrl).replace(/\/+$/, '');

  // Absolute, and over http(s). A value like `api.example.com` is an
  // ordinary-looking mistake that produces a RELATIVE url: the browser resolves
  // it against the frontend's origin, every tile asks a host that serves no
  // media, and nothing reaches this API to appear in its log. The failure is
  // then indistinguishable from an empty archive, forty tiles at a time.
  // Throwing costs one loud 500 on the listing instead.
  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error(`Public base URL (CALLBACK_URL) is not absolute: ${base}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Public base URL (CALLBACK_URL) is not http or https: ${base}`);
  }

  const id = encodeURIComponent(mediaId);
  const q = `?t=${encodeURIComponent(token)}`;
  return {
    file: `${base}${MEDIA_PATH}/${id}/file${q}`,
    thumb: `${base}${MEDIA_PATH}/${id}/thumb${q}`,
    // What a <video> should point at. `file` is the archive master and stays
    // the download; `play` is the same bytes until a rendition exists, and the
    // viewing copy afterwards, without the client having to know which.
    play: `${base}${MEDIA_PATH}/${id}/play${q}`,
  };
}

module.exports = { MEDIA_TOKEN_TTL_SECONDS, signMediaToken, verifyMediaToken, mediaUrls };
