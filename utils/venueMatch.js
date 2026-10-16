/**
 * Which Venue row a show was at, when its source spells the building another way.
 *
 * Concert.venue is the text the source sent, so one building arrives as
 * "Rockefeller", "ROCKEFELLER " and, from another source, "Rockefeller Music
 * Hall". Concert.venue_id points every spelling at one Venue row (THO-346), so
 * a venue page or a venue review has one thing to hang off.
 *
 * Two levels of sameness:
 * - At ingest, and in the migration that made the table: same City, and the
 *   same name once case, whitespace and accents are set aside. That is the
 *   SQL function venue_key(), defined by the migration, so both fold alike.
 * - In scripts/merge-venues.js, a dry run read before it is applied: same City
 *   and a name that mostly agrees (concertDedup's venueSimilarity), or two
 *   rows standing within NEAR_KM of each other.
 */
const { haversineKm, venueSimilarity } = require('./concertDedup');

// The bar concertDedup holds two listings' venue names to before calling them one room.
const NAME_SIM = 0.7;
// Two rows this close are one building with two names, or two rooms in one
// building (Rockefeller and John Dee). The dry run shows which; veto the second.
const NEAR_KM = 0.2;

const coord = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * The id of the Venue `name` names in City `cityId`, made if it is new. Null
 * when there is no name or no city to file it under.
 *
 * A position fills the row only where it has none: the first one sent stays,
 * as a City's does. Pass none for a position that is the city's, not the
 * building's (setlist.fm's).
 */
async function venueId(db, { name, cityId, latitude = null, longitude = null }) {
  if (cityId == null || typeof name !== 'string' || !name.trim()) return null;
  const [lat, lng] = [coord(latitude), coord(longitude)];
  const placed = lat != null && lng != null;
  // DO UPDATE rather than DO NOTHING, which returns no row for one that exists.
  const [row] = await db.$queryRaw`
    INSERT INTO "Venue" (name, name_key, city_id, latitude, longitude)
    VALUES (${name.trim()}, venue_key(${name}), ${cityId}, ${placed ? lat : null}, ${placed ? lng : null})
    ON CONFLICT (city_id, name_key) DO UPDATE SET
      latitude = COALESCE("Venue".latitude, EXCLUDED.latitude),
      longitude = COALESCE("Venue".longitude, EXCLUDED.longitude)
    RETURNING id`;
  return row.id;
}

/** Why `a` and `b` look like one building, or null. */
function sameBuilding(a, b) {
  const name = venueSimilarity(a.name, b.name);
  const km = a.latitude != null && a.longitude != null && b.latitude != null && b.longitude != null
    ? haversineKm(a.latitude, a.longitude, b.latitude, b.longitude)
    : null;
  if (name < NAME_SIM && !(km != null && km <= NEAR_KM)) return null;
  return { name, km };
}

/**
 * The merges scripts/merge-venues.js proposes.
 *
 * Rows are taken busiest first (most concerts, then oldest), and each one either
 * stays or goes into a row already kept in its City: the one whose name agrees
 * most, then the nearest. A row that goes is never a target itself, so nothing
 * chains from one name to the next.
 *
 * @param {Array<{id: number, name: string, city_id: number, latitude: number|null,
 *   longitude: number|null, concerts: number}>} venues
 * @returns {Array<{loser: object, winner: object, name: number, km: number|null}>}
 */
function planVenueMerges(venues) {
  const kept = new Map();
  const merges = [];
  const busiestFirst = [...venues].sort((a, b) => b.concerts - a.concerts || a.id - b.id);
  for (const venue of busiestFirst) {
    if (!kept.has(venue.city_id)) kept.set(venue.city_id, []);
    let best = null;
    for (const other of kept.get(venue.city_id)) {
      const why = sameBuilding(venue, other);
      if (why && (!best || why.name > best.name || (why.name === best.name && (why.km ?? Infinity) < (best.km ?? Infinity)))) {
        best = { winner: other, ...why };
      }
    }
    if (best) merges.push({ loser: venue, ...best });
    else kept.get(venue.city_id).push(venue);
  }
  return merges;
}

/**
 * Moves every concert at Venue `loserId` onto `winnerId`, fills the winner's
 * position if it has none, then deletes the loser. Run inside one transaction.
 * The concerts keep their own venue text.
 */
async function mergeVenue(tx, loserId, winnerId) {
  const [loser, winner] = await Promise.all([
    tx.venue.findUniqueOrThrow({ where: { id: loserId } }),
    tx.venue.findUniqueOrThrow({ where: { id: winnerId } }),
  ]);
  const concerts = await tx.concert.updateMany({ where: { venue_id: loserId }, data: { venue_id: winnerId } });
  await tx.venue.delete({ where: { id: loserId } });
  if (winner.latitude == null && loser.latitude != null) {
    await tx.venue.update({ where: { id: winnerId }, data: { latitude: loser.latitude, longitude: loser.longitude } });
  }
  return { concerts: concerts.count };
}

module.exports = { NEAR_KM, venueId, sameBuilding, planVenueMerges, mergeVenue };
