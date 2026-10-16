/**
 * Which City row a show belongs to, when its source spells the place another way.
 *
 * The scrapers send the city as the source wrote it, and Nominatim fills the
 * gaps with admin areas, so one place arrived as "London" and "Greater London",
 * "Vienna" and "Wien", "Stockholm" and "Johanneshov". Each spelling became its
 * own City row, and a city watch, which matches on the row, missed every show
 * filed under the other one.
 *
 * The rule, at ingest and in scripts/merge-nearby-cities.js:
 * 1. A City with the exact name in that country wins.
 * 2. Otherwise, for a show with a position, the nearest City in the same
 *    country whose stored point is within CITY_KM, under that row's name.
 * 3. Otherwise a new City, as before.
 *
 * Two different towns can sit within CITY_KM of each other. Keeping to one
 * country and taking the nearest keeps that rare.
 */
const { haversineKm } = require('./concertDedup');
const { mergeVenue } = require('./venueMatch');

const CITY_KM = 15;
// CITY_KM in degrees of latitude, rounded up: a cheap box for the query to
// narrow by before the exact distance is worked out here.
const LAT_SPAN = CITY_KM / 110;

/** The nearest of `cities` within CITY_KM of (lat, lng), with its distance, or null. */
function nearestCity(cities, lat, lng) {
  let best = null;
  for (const city of cities) {
    if (city.latitude == null || city.longitude == null) continue;
    const km = haversineKm(lat, lng, city.latitude, city.longitude);
    if (km <= CITY_KM && (!best || km < best.km)) best = { city, km };
  }
  return best;
}

/**
 * The rule above, over City rows already fetched.
 *
 * @param {Array<{id: number, name: string, country: string, latitude: number|null, longitude: number|null}>} cities
 * @param {{name: string, country: string, latitude: number|null, longitude: number|null}} show
 * @returns {object|null} the City to file the show under, or null for a new one
 */
function matchCity(cities, { name, country, latitude, longitude }) {
  const exact = cities.find((c) => c.name === name && c.country === country);
  if (exact) return exact;
  if (latitude == null || longitude == null) return null;
  return nearestCity(cities.filter((c) => c.country === country), latitude, longitude)?.city ?? null;
}

/**
 * matchCity against the database. Null for a show with no position: the
 * caller's upsert on the exact name is then the whole rule.
 */
async function storedCity(db, show) {
  const { name, country, latitude, longitude } = show;
  if (latitude == null || longitude == null) return null;
  const cities = await db.city.findMany({
    where: {
      country,
      OR: [
        { name },
        { latitude: { gte: latitude - LAT_SPAN, lte: latitude + LAT_SPAN }, longitude: { not: null } },
      ],
    },
    select: { id: true, name: true, country: true, latitude: true, longitude: true },
  });
  return matchCity(cities, show);
}

/**
 * The merges that file every existing City the way ingest now would.
 *
 * Rows are taken busiest first (most concerts, then oldest), and each one either
 * stays or goes into the nearest row already kept in its country within CITY_KM.
 * A row that goes is never a target itself, so nothing chains from town to town
 * across more than CITY_KM. A row with no point stays as it is.
 *
 * @param {Array<{id: number, name: string, country: string, latitude: number|null,
 *   longitude: number|null, concerts: number}>} cities
 * @returns {Array<{loser: object, winner: object, km: number}>}
 */
function planCityMerges(cities) {
  const kept = new Map();
  const merges = [];
  const busiestFirst = [...cities].sort((a, b) => b.concerts - a.concerts || a.id - b.id);
  for (const city of busiestFirst) {
    if (city.latitude == null || city.longitude == null) continue;
    if (!kept.has(city.country)) kept.set(city.country, []);
    const near = nearestCity(kept.get(city.country), city.latitude, city.longitude);
    if (near) merges.push({ loser: city, winner: near.city, km: near.km });
    else kept.get(city.country).push(city);
  }
  return merges;
}

// Filled on the City that stays from the one that goes, only where it has none:
// reachable and airport_iata are set by hand.
const GAP_FIELDS = ['reachable', 'airport_iata', 'weather_monthly', 'weather_updated_at'];

/**
 * Moves everything that points at City `loserId` onto `winnerId`, then deletes
 * it. Run inside one transaction per merge.
 *
 * Watches move first, because deleting a City cascades to its watches. A watch
 * the user already holds on the winner is dropped instead, as the route refuses
 * a second one. Concerts take the winner's name too, so the string and the link
 * agree. Venues move too, and one the winner already has under the same
 * folded name is merged into it. A home city lives in User.settings, which no
 * foreign key covers.
 */
async function mergeCity(tx, loserId, winnerId) {
  const [loser, winner] = await Promise.all([
    tx.city.findUniqueOrThrow({ where: { id: loserId } }),
    tx.city.findUniqueOrThrow({ where: { id: winnerId } }),
  ]);

  const watchKey = (s) => `${s.user_id}|${s.band_id}`;
  const held = new Set((await tx.notificationSubscription.findMany({
    where: { city_id: winnerId }, select: { user_id: true, band_id: true },
  })).map(watchKey));
  const twins = (await tx.notificationSubscription.findMany({
    where: { city_id: loserId }, select: { id: true, user_id: true, band_id: true },
  })).filter((s) => held.has(watchKey(s))).map((s) => s.id);
  await tx.notificationSubscription.deleteMany({ where: { id: { in: twins } } });
  const watches = await tx.notificationSubscription.updateMany({
    where: { city_id: loserId }, data: { city_id: winnerId },
  });

  const concerts = await tx.concert.updateMany({
    where: { city_id: loserId }, data: { city_id: winnerId, city: winner.name },
  });
  const theirs = await tx.venue.findMany({ where: { city_id: loserId }, select: { id: true, name_key: true } });
  const ours = new Map((await tx.venue.findMany({
    where: { city_id: winnerId, name_key: { in: theirs.map((v) => v.name_key) } }, select: { id: true, name_key: true },
  })).map((v) => [v.name_key, v.id]));
  for (const v of theirs.filter((t) => ours.has(t.name_key))) await mergeVenue(tx, v.id, ours.get(v.name_key));
  const venues = await tx.venue.updateMany({ where: { city_id: loserId }, data: { city_id: winnerId } });
  const homes = await tx.$executeRaw`
    UPDATE "User" SET settings = jsonb_set(settings, '{homeCityId}', to_jsonb(${winnerId}::int))
    WHERE settings->>'homeCityId' = ${String(loserId)}`;

  const gaps = Object.fromEntries(GAP_FIELDS
    .filter((f) => winner[f] == null && loser[f] != null)
    .map((f) => [f, loser[f]]));
  await tx.city.delete({ where: { id: loserId } });
  if (Object.keys(gaps).length) await tx.city.update({ where: { id: winnerId }, data: gaps });

  return {
    concerts: concerts.count, watches: watches.count, droppedWatches: twins.length,
    venues: venues.count, mergedVenues: theirs.length - venues.count, homes, filled: Object.keys(gaps),
  };
}

module.exports = { CITY_KM, nearestCity, matchCity, storedCity, planCityMerges, mergeCity };
