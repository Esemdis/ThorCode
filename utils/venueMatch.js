/**
 * Which Venue row a show was at, when its source spells the building another way.
 *
 * Concert.venue is the text the source sent, so one building arrives as
 * "Rockefeller" and "ROCKEFELLER ". Concert.venue_id points every spelling at
 * one Venue row (THO-346), so a venue page or a venue review has one thing to
 * hang off.
 *
 * At ingest, and in the migration that made the table, two spellings are one
 * Venue in the same City when they are the same name once case, whitespace and
 * accents are set aside. That is the SQL function venue_key(), defined by the
 * migration, so both fold alike.
 */
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

module.exports = { venueId, mergeVenue };
