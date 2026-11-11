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
 * and the original is served. A copy that was made has a `.stamp` beside it.
 * Both hold the scrubber's version and the source's size and mtime, and either
 * is ignored when they no longer match: a rendition can be made again under
 * the same key, and the new one may carry what the old one did not; and a
 * scrubber that has learned to strip more must look again at what an older
 * one let through (SCRUB_VERSION in mediaScrub.js).
 *
 * Nothing here ever falls back to the original on failure. A scrub that throws
 * propagates, and the route answers 404.
 */

// Called through the module object, not destructured, so a test can make one
// step of a copy fail.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { planScrubFile, SCRUB_VERSION } = require('./mediaScrub');
const { publicCachePath, publicCopyFiles } = require('./mediaPaths');

// Keys are made by the routes from a checksum or a link id; anything else
// reaching here is a bug, and must not become a path. Nor may a key end the
// way another key's marker or temp file does, or one could be read as the
// other.
const SAFE_KEY = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,200}$/;
const MARKER_NAME = /\.(clean|stamp|tmp)$/;

// Two first requests for one file — an album grid opened twice, a video's
// first Range requests — share one copy instead of racing two.
const inFlight = new Map();

const exists = (p) => fs.stat(p).then(() => true, () => false);

function tagged(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const stampOf = (info) => `v${SCRUB_VERSION}:${info.size}:${Math.trunc(info.mtimeMs)}`;

const readStamp = (p) => fs.readFile(p, 'utf8').then((text) => text.trim(), () => null);

async function statSource(absPath) {
  try {
    return await fs.stat(absPath);
  } catch (err) {
    if (err.code === 'ENOENT') throw tagged('NO_SOURCE', `no file at ${absPath}`);
    throw err;
  }
}

async function makeCopy(absPath, key) {
  const [target, stampFile, marker] = publicCopyFiles(key);
  // The source is looked at on every request, hit or not. A copy can only be
  // trusted while it is still the copy of this source by this scrubber, and a
  // source that is gone answers NO_SOURCE (a 404) like everywhere else.
  const before = await statSource(absPath);
  const stamp = stampOf(before);
  if (await readStamp(stampFile) === stamp && await exists(target)) return target;
  if (await readStamp(marker) === stamp) return absPath;

  const plan = await planScrubFile(absPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (plan.length === 0) {
    // Checked again after the read: a source replaced while it was being
    // planned would otherwise be served on the strength of the old one's plan.
    const after = await statSource(absPath);
    if (stampOf(after) !== stamp) throw tagged('UNSCRUBBABLE', `${absPath} changed while being read`);
    await fs.writeFile(marker, stamp);
    // A copy of what the source used to be is of no use any more.
    await fs.unlink(stampFile).catch(() => {});
    await fs.unlink(target).catch(() => {});
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
    // After the rename, so a stamp never vouches for a copy that is not there
    // yet. The stamp is the source as it was before the copy: had it changed
    // since, the next request finds a mismatch and makes the copy again.
    await fs.writeFile(stampFile, stamp);
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
  if (!SAFE_KEY.test(String(key)) || MARKER_NAME.test(String(key))) {
    return Promise.reject(new Error(`unsafe public copy key: ${key}`));
  }
  const pending = inFlight.get(key);
  if (pending) return pending;
  const work = makeCopy(absPath, key).finally(() => inFlight.delete(key));
  inFlight.set(key, work);
  return work;
}

// The names a row's copies go by. A master's is its checksum, with the
// extension kept so it is served as the same type; a rendition's is the
// master's checksum too, so the two never share a name. Null without a
// checksum: the routes refuse that rather than guess a name. A checksum is
// alphanumeric, so neither can collide with a `clip-<id>.mp4` or reach a path.
const hasChecksum = (row) => typeof row.sha256 === 'string' && /^[A-Za-z0-9]{1,128}$/.test(row.sha256);

function masterCopyKey(row) {
  if (!hasChecksum(row)) return null;
  const ext = path.extname(String(row.rel_path ?? '')).toLowerCase();
  return `${row.sha256}${/^\.[a-z0-9]{1,8}$/.test(ext) ? ext : ''}`;
}

const renditionCopyKey = (row) => (hasChecksum(row) ? `web-${row.sha256}.mp4` : null);

/**
 * Delete a row's copies from cache/public, once the row has gone. Nothing can
 * reach them after that, and a scrubbed video is as big as the video. Another
 * row with the same bytes simply has its copy made again on its next request.
 * Best effort: cache/public is disposable, so a failure here is not the
 * delete's failure.
 */
async function removePublicCopies(row) {
  for (const key of [masterCopyKey(row), renditionCopyKey(row)]) {
    if (!key) continue;
    for (const p of publicCopyFiles(key)) await fs.unlink(p).catch(() => {});
  }
}

module.exports = {
  ensurePublicCopy, removePublicCopies, masterCopyKey, renditionCopyKey,
};
