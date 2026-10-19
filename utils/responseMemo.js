/**
 * A short-lived, in-process memo for a route whose answer is the same for every
 * caller.
 *
 * Not utils/cache.js: that is Redis, and it answers a miss whenever Redis is
 * missing or down. This exists to bound how often a request can turn into
 * whole-table queries, so it has to hold even in an environment with no Redis.
 *
 * The pending promise is what gets stored, not the settled value. Ten requests
 * arriving during one cold computation then share it, instead of each starting
 * its own set of scans — which is the loop this was added to stop (THO-381).
 * A computation that fails is dropped, so an error is never served from here.
 */
function createResponseMemo({ ttlMs, now = () => Date.now() }) {
  const entries = new Map();

  return {
    async get(key, compute) {
      const hit = entries.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.value;

      // Through a promise so a compute that throws synchronously is dropped too.
      const value = Promise.resolve().then(compute);
      entries.set(key, { at: now(), value });
      try {
        return await value;
      } catch (err) {
        if (entries.get(key)?.value === value) entries.delete(key);
        throw err;
      }
    },
    clear() {
      entries.clear();
    },
  };
}

module.exports = { createResponseMemo };
