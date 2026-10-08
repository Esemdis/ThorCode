/**
 * A show that has moved: another day, or another venue.
 *
 * Shared by the two paths that read a show's own listing by its event id —
 * /bulk (routes/data/bands/ingest.js), when a scrape matches a stored row on
 * it, and the followed-show checker (routes/data/followChecks.js), which reads
 * that listing's page directly. Only those can be sure of a move: an event id
 * is one listing, so another date on it is that show moving, where the rules
 * in utils/concertDedup.js match two listings that may always have disagreed.
 */
const { haversineKm } = require('./concertDedup');

const DAY_MS = 24 * 60 * 60 * 1000;
// Two positions further apart than this are two places, not one venue under
// two names. Bandsintown files a festival's acts under the grounds and under
// each stage, all at one spot.
const VENUE_MOVE_KM = 1;

/**
 * What changed about a show the scrapers already sent, when it has moved.
 *
 * A postponed or moved show keeps its event id, and used to keep its old date
 * and venue here for good: only prices, sale state and sold-out were updated,
 * and reconcile matches it by event id and looks no further.
 *
 * A time filled in for the same day is not a move — see adoptedTime in
 * utils/concertDedup.js.
 *
 * Only a show still to come moves, and only to a date still to come: a night
 * already been to has photographs filed under its date and venue. A venue
 * changes only with a position more than VENUE_MOVE_KM from the stored one, so
 * a stage name at the same grounds is not a move, and a new name with no
 * position cannot be told from one.
 *
 * @returns {object} fields for concert.update, empty when nothing moved
 */
function movedFields(existing, incoming, now = new Date()) {
  const moved = {};
  const was = existing.concert_date ? new Date(existing.concert_date) : null;
  if (!was || was <= now) return moved;

  const next = incoming.concert_date ? new Date(incoming.concert_date) : null;
  if (next && !Number.isNaN(next.getTime())) {
    const day = (d) => Math.floor(d.getTime() / DAY_MS);
    const startOfToday = day(now) * DAY_MS;
    if (next.getTime() >= startOfToday && day(next) !== day(was)) moved.concert_date = next;
  }

  const venue = typeof incoming.venue === 'string' ? incoming.venue.trim() : '';
  const [lat, lng] = [parseFloat(incoming.latitude), parseFloat(incoming.longitude)];
  const [oldLat, oldLng] = [parseFloat(existing.latitude), parseFloat(existing.longitude)];
  if (venue && venue !== existing.venue && Number.isFinite(lat) && Number.isFinite(lng)
    && (!Number.isFinite(oldLat) || !Number.isFinite(oldLng) || haversineKm(oldLat, oldLng, lat, lng) > VENUE_MOVE_KM)) {
    Object.assign(moved, { venue, latitude: String(incoming.latitude), longitude: String(incoming.longitude) });
  }
  return moved;
}

module.exports = { movedFields, VENUE_MOVE_KM };
