/**
 * The copy of a file a public share route hands out: the original with its
 * location and camera metadata patched out (THO-894; the patching is
 * mediaScrub.js).
 *
 * Made on first request and kept in cache/public, like a thumbnail — a night's
 * album is downloaded file by file and a video is fetched again on every seek,
 * so scrubbing per request would re-read a gigabyte per Range request. Keyed by
 * the content it was made from, so the directory can be deleted at any time.
 *
 * A file with nothing to strip is not copied: a `.clean` marker records that,
 * and the original is served. The marker holds the source's size and mtime and
 * is ignored when they no longer match, because a rendition can be made again
 * under the same key and the new one may carry what the old one did not.
 *
 * Nothing here ever falls back to the original on failure. A scrub that throws
 * propagates, and the route answers 404.
 */

// Called through the module object, not destructured, so a test can make one
// step of a copy fail.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { planScrubFile } = require('./mediaScrub');
const { publicCachePath } = require('./mediaPaths');

// Keys are made by the routes from a checksum or a link id; anything else
// reaching here is a bug, and must not become a path.
const SAFE_KEY = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,200}$/;

// Two first requests for one file — an album grid opened twice, a video's
// first Range requests — share one copy instead of racing two.
const inFlight = new Map();

const exists = (p) => fs.stat(p).then(() => true, () => false);

function tagged(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const stampOf = (info) => `${info.size}:${Math.trunc(info.mtimeMs)}`;

async function statSource(absPath) {
  try {
    return await fs.stat(absPath);
  } catch (err) {
    if (err.code === 'ENOENT') throw tagged('NO_SOURCE', `no file at ${absPath}`);
    throw err;
  }
}

async function makeCopy(absPath, key) {
  const target = publicCachePath(key);
  const marker = `${target}.clean`;
  if (await exists(target)) return target;

  const before = await statSource(absPath);
  const recorded = await fs.readFile(marker, 'utf8').catch(() => null);
  if (recorded !== null && recorded.trim() === stampOf(before)) return absPath;

  const plan = await planScrubFile(absPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (plan.length === 0) {
    // Checked again after the read: a source replaced while it was being
    // planned would otherwise be served on the strength of the old one's plan.
    const after = await statSource(absPath);
    if (stampOf(after) !== stampOf(before)) throw tagged('UNSCRUBBABLE', `${absPath} changed while being read`);
    await fs.writeFile(marker, stampOf(before));
    return absPath;
  }

  // Unique per write for the reason writeWebp's temp name is (mediaThumbs.js).
  // The copy is planned again rather than patched with the source's plan, so
  // the offsets are always those of the bytes actually being patched, and
  // planned once more afterwards: anything left is a refusal, not a copy.
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.copyFile(absPath, temp);
    const patches = await planScrubFile(temp);
    const fh = await fs.open(temp, 'r+');
    try {
      for (const p of patches) await fh.write(p.bytes, 0, p.bytes.length, p.offset);
    } finally {
      await fh.close();
    }
    const left = await planScrubFile(temp);
    if (left.length) throw tagged('UNSCRUBBABLE', `${left.length} patches left after scrubbing ${absPath}`);
    await fs.rename(temp, target);
    return target;
  } catch (err) {
    await fs.unlink(temp).catch(() => {});
    throw err;
  }
}

/**
 * The path to serve a stranger for `absPath`: the cached scrubbed copy, or the
 * source itself when it has nothing to strip.
 *
 * @param {{absPath: string, key: string}} args - `key` names the copy in
 *   cache/public and must change whenever the source's content can.
 * @returns {Promise<string>}
 * @throws code NO_SOURCE when the source is gone, UNSCRUBBABLE when it cannot
 *   be scrubbed
 */
function ensurePublicCopy({ absPath, key }) {
  if (!SAFE_KEY.test(String(key))) return Promise.reject(new Error(`unsafe public copy key: ${key}`));
  const pending = inFlight.get(key);
  if (pending) return pending;
  const work = makeCopy(absPath, key).finally(() => inFlight.delete(key));
  inFlight.set(key, work);
  return work;
}

module.exports = { ensurePublicCopy };
