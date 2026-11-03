// What GET /data/concerts/nearby decides about a concert, as pure functions so
// the decisions are tested without a database (THO-667).

const { haversineKm, hasTimeOfDay } = require('./concertDedup');
const { storesRealInstant } = require('./ics');
const { ticketState } = require('./ticketState');

/**
 * What the stored `concert_date` means, so a reader that has to place the show
 * on a clock does not have to know which scraper wrote it.
 *
 * - `date_only`: exactly midnight UTC. The scrapers store that for a show with
 *   no announced start, so it is "no time", never a show at 00:00.
 * - `instant`: a real UTC instant (Songkick). Read in the venue's zone to get
 *   the wall clock.
 * - `wall_clock`: the venue's local time with a `Z` stuck on it (Bandsintown,
 *   Ticketmaster, anything unverified). Read in UTC to get the wall clock;
 *   converting it again puts the show one or two hours out and looks measured.
 *
 * This is the same stopgap rule the calendar feed uses (`storesRealInstant`),
 * kept here as one named answer rather than copied into a second consumer.
 *
 * @param {{concert_date?: Date|string|null, source?: string|null}} concert
 * @returns {'instant'|'wall_clock'|'date_only'}
 */
function concertTimeKind(concert) {
  if (!hasTimeOfDay(concert?.concert_date)) return 'date_only';
  return storesRealInstant(concert.source) ? 'instant' : 'wall_clock';
}

/**
 * A stored coordinate as a number, or null. The columns are strings and hold
 * whatever a scraper wrote, so "" , "null" and out-of-range values all count
 * as no coordinate rather than as a point in the Gulf of Guinea.
 */
function coordinate(value, limit) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

/** Lowercase, accent-free and single-spaced, so "Köln " and "koln" compare equal. */
function cityKey(name) {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Keep the concerts near a point, each with how it matched.
 *
 * A concert with coordinates is kept when it is within `radiusKm` of the
 * point, and only then: a venue in the next country that shares a city name is
 * not "in the city". A concert with no usable coordinates cannot be measured,
 * so it is kept only when `city` is given and names the same place, and says
 * `match: 'city_name'` so the caller can tell the person it was a guess from
 * the name. Names differ across sources ("København" / "Copenhagen"), which is
 * why a name is only ever the fallback.
 *
 * @param {object[]} concerts rows with latitude, longitude, city and optionally city_rel.name
 * @param {{lat?: number|null, lng?: number|null, radiusKm: number, city?: string|null}} where
 * @returns {Array<object>} the concerts with `latitude`/`longitude` as numbers
 *   or null, `distance_km` (one decimal, null when not measured) and `match`
 */
function nearbyConcerts(concerts, { lat = null, lng = null, radiusKm, city = null }) {
  const hasPoint = Number.isFinite(lat) && Number.isFinite(lng);
  const wanted = cityKey(city);
  const sameCity = (c) => Boolean(wanted) && [c.city, c.city_rel?.name].some((n) => n && cityKey(n) === wanted);
  const out = [];
  for (const concert of concerts) {
    const latitude = coordinate(concert.latitude, 90);
    const longitude = coordinate(concert.longitude, 180);
    const located = latitude != null && longitude != null;
    if (located && hasPoint) {
      const distance = haversineKm(lat, lng, latitude, longitude);
      if (distance > radiusKm) continue;
      out.push({ ...concert, latitude, longitude, distance_km: Math.round(distance * 10) / 10, match: 'distance' });
    } else if ((!located || !hasPoint) && sameCity(concert)) {
      // Not measurable: the show has no usable coordinates, or the caller sent
      // no point. Either way it is the name that matched, and it says so.
      out.push({ ...concert, latitude, longitude, distance_km: null, match: 'city_name' });
    }
  }
  return out;
}

/**
 * The shape a concert leaves the API in. The follower's wishlist bands only:
 * the bill's other acts are not asked for, and a wishlist is what makes a show
 * worth interrupting a trip plan with.
 *
 * @param {object} concert a `nearbyConcerts` result with `bands` as band_rel rows
 * @param {Map<number,string>} tiers band id to the wishlist tier
 * @param {Date} now
 */
function nearbyConcertOut(concert, tiers, now = new Date()) {
  return {
    id: concert.id,
    name: concert.name ?? null,
    festival: Boolean(concert.festival),
    venue: concert.venue,
    city: concert.city,
    country: concert.country,
    concert_date: new Date(concert.concert_date).toISOString(),
    time_kind: concertTimeKind(concert),
    latitude: concert.latitude,
    longitude: concert.longitude,
    distance_km: concert.distance_km,
    match: concert.match,
    url: concert.url ?? null,
    ticket_state: ticketState(concert, now),
    price_min: concert.price_min ?? null,
    price_max: concert.price_max ?? null,
    price_currency: concert.price_currency ?? null,
    bands: concert.bands
      .map((b) => ({ id: b.band_rel.id, name: b.band_rel.name, tier: tiers.get(b.band_rel.id) ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

module.exports = { concertTimeKind, nearbyConcerts, nearbyConcertOut };
