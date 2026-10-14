/**
 * Which City row a show belongs to, when its source spells the place another way.
 *
 * The scrapers send the city as the source wrote it, and Nominatim fills the
 * gaps with admin areas, so one place arrived as "London" and "Greater London",
 * "Vienna" and "Wien", "Stockholm" and "Johanneshov". Each spelling became its
 * own City row, and a city watch, which matches on the row, missed every show
 * filed under the other one.
 *
 * The rule, at ingest:
 * 1. A City with the exact name in that country wins.
 * 2. Otherwise, for a show with a position, the nearest City in the same
 *    country whose stored point is within CITY_KM, under that row's name.
 * 3. Otherwise a new City, as before.
 *
 * Two different towns can sit within CITY_KM of each other. Keeping to one
 * country and taking the nearest keeps that rare.
 */
const { haversineKm } = require('./concertDedup');

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

module.exports = { CITY_KM, nearestCity, matchCity, storedCity };
