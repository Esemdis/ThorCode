/**
 * Which copy of a video a browser should actually be given.
 *
 * The archive holds phone originals, and they are not viewing copies. One
 * night's clips measured 43 Mbit/s of 4K HEVC — a gigabyte for three and a half
 * minutes — which no browser streams smoothly over a home connection and which
 * Firefox cannot decode at all. The bytes are the point of the archive and are
 * never touched; what was missing was something to watch.
 *
 * So a rendition service writes `.web/<name>.mp4` beside the original — 1080p
 * H.264 with the index at the front — and this is how the serving route finds
 * it. Existence is the whole record: no column, no sidecar entry, nothing to
 * keep in step. A rendition that is missing means the original is served, which
 * is exactly what happened before it existed, and deleting `.web` costs only
 * the CPU to make it again.
 *
 * That is also why the rendition service needs no database and no secrets. It
 * reads the sidecar to find the videos and writes files next to them.
 */

const { access } = require('node:fs/promises');
const { webRenditionPath } = require('./mediaPaths');

const exists = (p) => access(p).then(() => true, () => false);

/**
 * The file to serve for playback, and whether it is the derived one.
 *
 * `rendition: false` is not a failure — it is the ordinary answer for a
 * photograph, and for a clip the service has not reached yet.
 *
 * @param {string} absOriginal - already resolved and confined to the archive
 * @param {string} kind - the row's kind; only VIDEO has a rendition
 * @returns {Promise<{absPath: string, rendition: boolean}>}
 */
async function playableFor(absOriginal, kind) {
  if (kind !== 'VIDEO') return { absPath: absOriginal, rendition: false };
  const web = webRenditionPath(absOriginal);
  return (await exists(web))
    ? { absPath: web, rendition: true }
    : { absPath: absOriginal, rendition: false };
}

module.exports = { playableFor };
