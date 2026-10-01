/**
 * How long to honour a music service's 429, and when to stop honouring it.
 *
 * Split from spotify.js and tidal.js so it can be tested without dragging in
 * the Prisma client they need for user tokens.
 */

const axios = require('axios');

// The longest a 429 may park a caller. A badly tripped Spotify limit answers
// Retry-After: 23982 — six hours and forty minutes — and sleeping that out
// holds an Express handler, and the request behind it, for the rest of the day.
// Past this the honest answer is to fail and let the caller degrade.
const MAX_RETRY_WAIT_MS = 60000;

/**
 * How long to wait on a 429, or null when the wait is too long to be worth it.
 *
 * Retry-After is in seconds. Tidal does not promise to send one, so a missing
 * header is a short wait rather than none.
 */
function retryDelayMs(header) {
  const seconds = Number(header);
  const wait = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 2000;
  return wait > MAX_RETRY_WAIT_MS ? null : wait;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A request that waits out a brief 429 rather than failing the whole playlist
 * for it, and gives up rather than sleeping through a long one.
 *
 * Writes go through it too. Adding a festival's worth of tracks is several
 * POSTs in a row, and the searches before them have usually just spent the
 * rate budget — a 429 on the second chunk used to fail the build and leave a
 * half-filled playlist in the user's account.
 *
 * @param {object} config - An axios request config.
 * @param {{ label: string, authError: () => Error, attempts?: number }} options -
 *   `label` prefixes the log lines; `authError` is what a 401 becomes, so the
 *   route can tell "connect again" from "it broke".
 */
async function requestWithBackoff(config, { label, authError, attempts = 3 }) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await axios.request(config);
    } catch (error) {
      const status = error.response?.status;
      if (status === 401) throw authError();
      if (status !== 429 || attempt === attempts) throw error;
      const wait = retryDelayMs(error.response.headers?.['retry-after']);
      if (wait === null) {
        console.error(`[${label}] Rate limited for ${error.response.headers['retry-after']}s — giving up rather than waiting it out`);
        throw error;
      }
      console.warn(`[${label}] Rate limited, waiting ${wait}ms (attempt ${attempt}/${attempts})`);
      await sleep(wait);
    }
  }
  throw new Error('unreachable');
}

module.exports = { MAX_RETRY_WAIT_MS, retryDelayMs, requestWithBackoff };
