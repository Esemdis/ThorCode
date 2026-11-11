const crypto = require('node:crypto');

/**
 * The arithmetic of a forgotten-password link (THO-808), apart from the route
 * so it can be tested without one.
 */

// Long enough to read the email and pick a password, short enough that a link
// left in an inbox is not a standing way into the account.
const RESET_TTL_MS = 30 * 60 * 1000;

// Anything longer is not a token this API ever issued (43 characters), and
// hashing a megabyte someone posted is work for nothing.
const MAX_TOKEN_LENGTH = 200;

/** 32 random bytes, base64url: safe in a query string without escaping. */
function newResetToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * What is stored and looked up. A plain sha256 rather than bcrypt: the token
 * is 256 random bits, so there is nothing to slow a guesser down on, and the
 * lookup has to be by equality.
 */
function hashResetToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * The link the email carries, or null when there is no app to send it to.
 *
 * `CONCERT_MAP_URL` is set with a trailing slash in some environments (the
 * OAuth callbacks strip it too), and "https://map//user/reset" is a page
 * concert-map does not route.
 */
function resetLink(base, token) {
  const root = typeof base === 'string' ? base.trim().replace(/\/+$/, '') : '';
  if (!root) return null;
  return `${root}/user/reset?token=${encodeURIComponent(token)}`;
}

/** A value worth hashing and looking up at all. */
function isPlausibleToken(token) {
  return typeof token === 'string' && token.length > 0 && token.length <= MAX_TOKEN_LENGTH;
}

module.exports = { RESET_TTL_MS, newResetToken, hashResetToken, resetLink, isPlausibleToken };
