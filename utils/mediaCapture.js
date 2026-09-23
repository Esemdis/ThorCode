/**
 * Whether to believe the capture time the browser sent.
 *
 * The client already supplies the poster, the duration and the dimensions, and
 * this is a fourth fact it could get wrong. It matters more than the others: a
 * stored time that contradicts its own show would misplace every clip that
 * night relative to it, not only itself.
 *
 * The window is deliberately wide and does NOT try to detect a timezone error.
 * A muxer writing local time into a UTC field shifts every clip from that
 * device that night by the same amount, and a constant offset does not change
 * their order — which is all the anchoring uses. Narrowing this to catch skew
 * would throw away real encores instead.
 *
 * Kept in step with `isPlausibleCapture` in concert-map's
 * `src/utils/videoCapturedAt.js`. Two repos, one rule.
 */
const PLAUSIBLE_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * @param {unknown} iso - whatever arrived in the upload's meta blob.
 * @param {'PHOTO'|'VIDEO'} kind
 * @param {Date|string|null} concertDate
 * @returns {string|null} An ISO instant safe to store, or null.
 */
function capturedAtFor(iso, kind, concertDate) {
  if (kind !== 'VIDEO') return null;
  if (typeof iso !== 'string' || !iso) return null;
  if (!concertDate) return null;

  const captured = Date.parse(iso);
  // Sliced rather than parsed: concert_date is a calendar day, and running a
  // date-only string through a local parse slides it backwards west of UTC.
  const source = concertDate instanceof Date ? concertDate.toISOString() : String(concertDate);
  const day = Date.parse(`${source.slice(0, 10)}T00:00:00Z`);

  if (!Number.isFinite(captured) || !Number.isFinite(day)) return null;
  if (Math.abs(captured - day) > PLAUSIBLE_WINDOW_MS) return null;

  return new Date(captured).toISOString();
}

module.exports = { capturedAtFor, PLAUSIBLE_WINDOW_MS };
