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

module.exports = { generateCalendarToken, feedUrl, TOKEN_LENGTH };
