/**
 * The named stretches of a video an admin marks, and played by seeking.
 *
 * A cousin of recapMoment (see recapMoment.js) with looser rules: a clip is
 * for finding your way around a night, not for a slide that moves on, so there
 * are several to a video and no length cap, only the video's own length.
 */
const { MIN_MOMENT_MS } = require('./recapMoment');

const MAX_CLIPS = 50;
const MAX_NAME = 80;
const INT32_MAX = 2147483647;

const isMs = (v) => Number.isInteger(v) && v >= 0 && v <= INT32_MAX;

/**
 * @param {unknown} list - what a request asked the video's clips to become.
 * @param {{durationMs?: number|null}} [video]
 * @returns {{clips: {name: string, start_ms: number, end_ms: number}[]} | {error: string}}
 *   in the order they start.
 */
function namedClips(list, { durationMs = null } = {}) {
  if (!Array.isArray(list) || list.length > MAX_CLIPS) return { error: `A video can have at most ${MAX_CLIPS} clips` };
  const clips = [];
  for (const c of list) {
    const name = typeof c?.name === 'string' ? c.name.trim() : '';
    if (!name || name.length > MAX_NAME) return { error: `A clip needs a name of 1 to ${MAX_NAME} characters` };
    if (!isMs(c.start_ms) || !isMs(c.end_ms)) return { error: 'A clip needs a start and an end in whole milliseconds' };
    if (durationMs != null && c.start_ms >= durationMs) return { error: `"${name}" starts after the video ends` };
    // The player's clock and the length read at upload can disagree by a
    // frame, so an end a hair past the last one is the last one.
    const end = durationMs != null ? Math.min(c.end_ms, durationMs) : c.end_ms;
    if (end - c.start_ms < MIN_MOMENT_MS) return { error: `"${name}" has to be at least a second long` };
    clips.push({ name, start_ms: c.start_ms, end_ms: end });
  }
  return { clips: clips.sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms) };
}

module.exports = { namedClips, MAX_CLIPS, MAX_NAME };
