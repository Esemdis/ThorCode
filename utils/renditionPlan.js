/**
 * What the rendition service should encode next, and with what.
 *
 * Kept out of the service's loop so it can be tested without ffmpeg, a share or
 * a container. The loop's own job is small on purpose: ask this what to do, run
 * ffmpeg, rename the result into place.
 *
 * The plan is built from the sidecar rather than from Postgres, and that is the
 * design rather than a convenience. `concert-media.json` is the record of truth
 * and the index is disposable, so a service that reads the sidecar needs no
 * DATABASE_URL, no migrations and no secret of any kind — it reads files and
 * writes files beside them. Nothing it does can corrupt the index, because it
 * never touches it, and nothing it writes has to be kept in step with a column,
 * because a rendition's existence is the whole record of it.
 */

const path = require('node:path');

// A marker rather than a retry. A clip ffmpeg cannot read will not become
// readable on the next pass, and a service that retried it every interval would
// spend every interval failing on the same file and never reach the rest.
const FAILED_SUFFIX = '.failed';

// Written under a temp name and renamed, for the same reason the sidecar and
// the posters are: the serving route decides on existence alone, so a
// half-written file at the final path would be streamed to a browser as though
// it were finished, forever.
const PART_SUFFIX = '.part';

/**
 * The ffmpeg arguments for one clip.
 *
 * H.264 because it is the only codec every browser decodes, which is the entire
 * point — the originals are HEVC and Firefox plays none of them.
 *
 * The scale filter limits the LONG edge, not the width. Half these clips are
 * held portrait, and capping the width would leave a portrait 4K clip at its
 * full height while a landscape one came down to 1080.
 *
 * +faststart moves the index to the front. A phone writes it at the end, so
 * without this a browser must range-request the tail of a gigabyte before it can
 * start, which is most of what made playback feel slow to begin with.
 */
function ffmpegArgs({
  input, output, height = 1080, crf = 21, maxrateMbps = 8,
  vcodec = 'libx264', preset = 'veryfast',
}) {
  // The cap is on the long edge, derived from the short one at 16:9 — 1080
  // becomes 1920. A clip that is neither ratio keeps its own: the filter only
  // ever sets one dimension and lets -2 solve the other to an even number,
  // which H.264 requires.
  const cap = Math.round(Number(height) * (16 / 9));
  return [
    // Never read stdin: under a service manager there is none, and ffmpeg
    // treating a closed stdin as a keypress has ended runs early before.
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    '-i', input,
    '-vf', `scale='if(gt(iw,ih),min(${cap},iw),-2)':'if(gt(iw,ih),-2,min(${cap},ih))'`,
    '-c:v', vcodec,
    '-preset', preset,
    '-crf', String(crf),
    // A ceiling as well as a quality target. CRF alone lets a dark, grainy
    // crowd shot balloon past the original's own bitrate, which would make the
    // viewing copy the slow one.
    '-maxrate', `${maxrateMbps}M`,
    // Two seconds of headroom, the conventional pairing with maxrate: smaller
    // makes the encoder fight the ceiling on every hard cut, larger lets a
    // burst through that the ceiling exists to stop.
    '-bufsize', `${maxrateMbps * 2}M`,
    '-c:a', 'aac',
    '-b:a', '160k',
    '-movflags', '+faststart',
    // Stated rather than inferred, because it cannot be inferred here: the
    // output is written to `<name>.mp4.part` so a half-finished file is never
    // served, and ffmpeg guesses the container from the extension it is given.
    // Without this every encode died at "Error initializing the muxer ...
    // Invalid argument" — a message about the output format that says nothing
    // about the filename that caused it.
    '-f', 'mp4',
    '-y', output,
  ];
}

/**
 * Every clip in one show that still needs a rendition.
 *
 * @param {object|null} sidecar - the show's parsed concert-media.json
 * @param {string[]} webDirEntries - what `.web` already holds
 * @returns {{name: string, output: string, marker: string}[]}
 */
function pendingInShow(sidecar, webDirEntries) {
  if (!sidecar?.files?.length) return [];
  const have = new Set(webDirEntries);
  return sidecar.files
    .filter((f) => f.kind === 'VIDEO' && typeof f.name === 'string' && f.name)
    .filter((f) => !have.has(`${f.name}.mp4`) && !have.has(`${f.name}.mp4${FAILED_SUFFIX}`))
    .map((f) => ({
      name: f.name,
      output: `${f.name}.mp4`,
      marker: `${f.name}.mp4${FAILED_SUFFIX}`,
      // Only ever used for logging, so a missing one costs nothing. It is the
      // difference between "encoding 1 of 28" and knowing it is the 20-minute
      // one.
      bytes: f.bytes ?? null,
      durationMs: f.duration_ms ?? null,
    }));
}

/**
 * A `.part` left behind by a killed run.
 *
 * Deleted rather than resumed: ffmpeg cannot continue into a truncated file, and
 * a half-written mp4 whose name lost its suffix would be served as finished.
 */
const isAbandonedPart = (name) => name.endsWith(PART_SUFFIX);

const partNameFor = (output) => `${output}${PART_SUFFIX}`;

const showDirOf = (relPath) => path.posix.dirname(relPath);

module.exports = {
  FAILED_SUFFIX, PART_SUFFIX, ffmpegArgs, pendingInShow, isAbandonedPart, partNameFor, showDirOf,
};
