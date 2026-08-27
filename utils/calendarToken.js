// The secret in a calendar feed URL.
//
// Calendar clients fetch a feed unattended and send no Authorization header, so
// the URL itself is the credential. That makes this token the only thing
// standing between a stranger and the user's upcoming concerts, and it has to
// hold up with no session, no expiry and no second factor behind it.

const crypto = require('crypto');

// 24 random bytes, base64url-encoded, is 32 characters and 192 bits. Far beyond
// guessing, and short enough to sit in a URL a user might paste by hand.
const TOKEN_BYTES = 24;
const TOKEN_LENGTH = 32;

const FEED_PATH = '/data/concerts/calendar/feed';

/**
 * Mint a feed token.
 *
 * `randomBytes` rather than `Math.random` or a timestamp: this is a credential,
 * so it has to come from a cryptographic source. base64url is used directly
 * because it is already URL-safe — no encoding, and nothing that changes shape
 * when a calendar client normalises the URL.
 *
 * @returns {string}
 */
function generateCalendarToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * The absolute URL a calendar subscribes to.
 *
 * Built from the configured public base URL and never from the incoming
 * request: behind a proxy the request host is whatever the proxy passes along,
 * and in development it is localhost. Either one gets pasted into a calendar
 * that then quietly never updates, which is indistinguishable from the feature
 * being broken.
 *
 * @param {string} baseUrl - Public base URL of this API.
 * @param {string} token
 * @returns {string}
 */
function feedUrl(baseUrl, token) {
  if (!baseUrl) throw new Error('No public base URL configured for calendar feeds');
  return `${String(baseUrl).replace(/\/+$/, '')}${FEED_PATH}/${token}/going.ics`;
}


// Hostnames only this machine, or only this LAN, can resolve.
const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i;
const PRIVATE_V4 = /^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/;
const LOCAL_TLD = /\.local$/i;

/**
 * Whether a base URL can be fetched by someone else's server.
 *
 * A calendar feed is not fetched by the browser that subscribed — Google,
 * Apple and Outlook fetch it from their own infrastructure on their own
 * schedule. So a base URL of http://127.0.0.1:4000, which is exactly what a
 * development config holds, resolves to *their* machine and the subscription
 * quietly never populates. Nothing errors; the calendar is simply always empty.
 *
 * Anything unparseable counts as unreachable. A needless warning is a small
 * cost; a missing one buys the user a subscription that can never work.
 *
 * @param {string} baseUrl
 * @returns {boolean}
 */
function isPubliclyReachable(baseUrl) {
  try {
    const { hostname } = new URL(String(baseUrl));
    if (!hostname) return false;
    return !LOOPBACK.test(hostname) && !PRIVATE_V4.test(hostname) && !LOCAL_TLD.test(hostname);
  } catch {
    return false;
  }
}

module.exports = { generateCalendarToken, feedUrl, isPubliclyReachable, TOKEN_LENGTH };
