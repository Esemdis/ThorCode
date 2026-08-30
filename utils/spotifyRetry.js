/**
 * How long to honour a Spotify 429, and when to stop honouring it.
 *
 * Split from spotify.js so it can be tested without dragging in the Prisma
 * client that module needs for user tokens.
 */

// The longest a 429 may park a caller. A badly tripped Spotify limit answers
// Retry-After: 23982 — six hours and forty minutes — and sleeping that out
// holds an Express handler, and the request behind it, for the rest of the day.
// Past this the honest answer is to fail and let the caller degrade.
const MAX_RETRY_WAIT_MS = 60000;

/**
 * How long to wait on a 429, or null when the wait is too long to be worth it.
 *
 * Spotify sends Retry-After in seconds.
 */
function retryDelayMs(header) {
  const seconds = Number(header);
  const wait = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 2000;
  return wait > MAX_RETRY_WAIT_MS ? null : wait;
}

module.exports = { MAX_RETRY_WAIT_MS, retryDelayMs };
