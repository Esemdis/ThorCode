/**
 * Count how many of something are open at once per key, in-process, and refuse
 * the one past the cap.
 *
 * Written for the album share link's full-size downloads (THO-1003). A rate
 * limiter counts requests in a window, which bounds nothing about a request
 * that streams a 2 GB original over a home uplink for half an hour: a handful
 * of those, looping, fit inside any request budget and still hold the whole
 * connection. What needs bounding is how many are open at the same moment.
 *
 * Refuses rather than queues, unlike withScrubSlot in mediaPublicCopy.js. A
 * scrub is our own work and someone is waiting for its result; a download
 * past the cap is the very load being shed, and parking its socket in a queue
 * would keep the connection open anyway.
 *
 * In-process only, which covers the API because it runs as one Node process
 * (see serialQueue.js for the same caveat).
 */

/**
 * @param {{ max: number }} options - How many may be open per key at once.
 * @returns {{ tryAcquire(key: string): (null | (() => void)), size(): number }}
 */
function createSlotCounter({ max }) {
  const open = new Map();

  /**
   * Takes a slot under `key`, or answers null when `max` are already open.
   *
   * The release it hands back is safe to call more than once. The callers
   * release from every way a response can end ('finish', 'close', an error
   * path), and more than one of those fires for the same response; a second
   * release that decremented again would hand a slot to someone else's
   * download and let the key run past its cap.
   */
  function tryAcquire(key) {
    const held = open.get(key) ?? 0;
    if (held >= max) return null;
    open.set(key, held + 1);

    let released = false;
    return function release() {
      if (released) return;
      released = true;
      const left = (open.get(key) ?? 1) - 1;
      // Dropped at zero, so a long-lived process does not keep an entry for
      // every share token and client address it has ever served.
      if (left <= 0) open.delete(key);
      else open.set(key, left);
    };
  }

  /** How many keys hold at least one slot. For tests and diagnostics. */
  function size() {
    return open.size;
  }

  return { tryAcquire, size };
}

module.exports = { createSlotCounter };
