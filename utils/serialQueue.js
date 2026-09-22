/**
 * Run work one-at-a-time per key, in-process.
 *
 * Extracted from updateSidecar, which had grown this queue for its own use and
 * then a second caller needed the same thing: the upload route, where two
 * concurrent requests to one show could each pick the same filename from the
 * same stale snapshot and the second's rename would silently replace the
 * first's bytes.
 *
 * In-process only, which covers the API because it runs as one Node process. A
 * second process touching the same resource (the rebuild script, say) is still
 * outside it; those are run by hand, not concurrently with a sweep.
 */

const tails = new Map();

/**
 * @param {string} key - What the work contends over. Callers from different
 *   concerns must not share a key space, or unrelated work serialises — and
 *   worse, nesting two of them under one key would deadlock, since this is
 *   not reentrant.
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function serialise(key, fn) {
  // Chained off the previous holder settling EITHER way. Chaining on success
  // alone would let one failed run wedge every later run for that key.
  const prev = tails.get(key) ?? Promise.resolve();
  const result = prev.then(() => {}, () => {}).then(fn);

  const tail = result.then(() => {}, () => {});
  tails.set(key, tail);
  // Dropped once this is the last run for the key, so a long-lived process
  // does not accumulate an entry per resource it has ever touched.
  tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
  return result;
}

/**
 * The same queue, as an explicit take-and-release pair.
 *
 * `serialise` wants the work as a callback, which means wrapping the region it
 * guards — and in the upload route that region is most of a long handler, so
 * wrapping it would reindent a hundred lines to add a lock. This hands back a
 * release function instead, for use in the handler's existing try/finally.
 *
 * The caller MUST release, in a finally. Forgetting to wedges the key for the
 * life of the process.
 *
 * @param {string} key
 * @returns {Promise<() => void>} resolves once the lock is held
 */
function acquire(key) {
  const prev = tails.get(key) ?? Promise.resolve();
  let release;
  const held = new Promise((r) => { release = r; });

  // The next caller waits on `held`, so the lock is not handed on until this
  // holder releases. Settled either way, as above.
  const tail = prev.then(() => {}, () => {}).then(() => held);
  tails.set(key, tail);
  tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });

  return prev.then(() => {}, () => {}).then(() => release);
}

module.exports = { serialise, acquire };
