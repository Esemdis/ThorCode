/**
 * The stretch of a video the year recap plays.
 *
 * A cousin of a shared moment (see normaliseRange in mediaClips.js) with
 * different rules, because it is used differently. A share can be the whole
 * video or run to its end, and is cut into a file. This one is played in
 * place, on a slide that moves on when it finishes, so it always has both
 * ends and is never long: the recap is a minute of your year, not a
 * screening of it.
 */

// Shorter than this is a double-press on the marker, not a moment.
const MIN_MOMENT_MS = 1000;
// Long enough for a chorus, short enough that a slide still feels like one.
const MAX_MOMENT_MS = 30000;

/**
 * @param {{start_ms: number, end_ms: number}} asked - both ends, in ms.
 * @param {{durationMs?: number|null}} [video]
 * @returns {{range: {start_ms: number, end_ms: number}} | {error: string}}
 */
function recapMoment({ start_ms: start, end_ms: end }, { durationMs = null } = {}) {
  if (end <= start) return { error: 'A moment has to end after it starts' };
  let to = end;
  if (durationMs != null) {
    if (start >= durationMs) return { error: 'That moment starts after the video ends' };
    // The player's clock and the length read at upload can disagree by a
    // frame, so an end a hair past the last one is the last one, not an
    // error to show someone who pressed "End here" at the very end.
    to = Math.min(to, durationMs);
  }
  if (to - start < MIN_MOMENT_MS) return { error: 'A moment has to be at least a second long' };
  if (to - start > MAX_MOMENT_MS) return { error: `A moment can be at most ${MAX_MOMENT_MS / 1000} seconds long` };
  return { range: { start_ms: start, end_ms: to } };
}

module.exports = { recapMoment, MIN_MOMENT_MS, MAX_MOMENT_MS };
