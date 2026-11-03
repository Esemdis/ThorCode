// What GET /data/concerts/nearby decides about a concert, as pure functions so
// the decisions are tested without a database (THO-667).

const { haversineKm, hasTimeOfDay } = require('./concertDedup');
const { storesRealInstant } = require('./ics');
const { ticketState } = require('./ticketState');
const { countryName } = require('./countries');

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
 * Known edge, deliberately not changed: midnight UTC means "no time", so a
 * Songkick instant at exactly 00:00Z is classified `date_only` too (the same
 * stopgap as ics.js). A US evening show whose UTC time falls on the next day at
 * 00:00Z is read as a show with no start, on the UTC date.
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
 * whatever a scraper wrote, so "" , "null", hex ("0x10"), exponent ("1e1") and
 * out-of-range values all count as no coordinate rather than as a point in the
 * Gulf of Guinea. Plain decimals only.
 */
const DECIMAL = /^-?\d+(\.\d+)?$/;
function coordinate(value, limit) {
  if (value == null || value === '') return null;
  if (typeof value === 'string' && !DECIMAL.test(value.trim())) return null;
  const n = typeof value === 'number' ? value : Number(value.trim());
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

/** A pair of coordinates, or null for either missing or exactly 0/0, which is a scraper's blank, not a venue. */
function point(latitude, longitude) {
  const lat = coordinate(latitude, 90);
  const lng = coordinate(longitude, 180);
  return lat == null || lng == null || (lat === 0 && lng === 0) ? null : { lat, lng };
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
 * @param {{lat?: number|null, lng?: number|null, radiusKm: number, city?: string|null, country?: string|null}} where
 * @returns {Array<object>} the concerts with `latitude`/`longitude` as numbers
 *   or null, `distance_km` (one decimal, null when not measured) and `match`
 */
function nearbyConcerts(concerts, {
  lat = null, lng = null, radiusKm, city = null, country = null,
}) {
  const hasPoint = Number.isFinite(lat) && Number.isFinite(lng);
  const wanted = cityKey(city);
  const wantedCountry = country ? cityKey(countryName(country)) : '';
  // Same name, and the same country when both sides have one: Birmingham AL is
  // not Birmingham, and Cambridge MA is not Cambridge.
  const sameCity = (c) => {
    if (!wanted || ![c.city, c.city_rel?.name].some((n) => n && cityKey(n) === wanted)) return false;
    const theirs = c.country || c.city_rel?.country;
    return !wantedCountry || !theirs || cityKey(countryName(theirs)) === wantedCountry;
  };
  const out = [];
  for (const concert of concerts) {
    const where = point(concert.latitude, concert.longitude);
    const latitude = where?.lat ?? null;
    const longitude = where?.lng ?? null;
    if (where && hasPoint) {
      const distance = haversineKm(lat, lng, latitude, longitude);
      if (distance > radiusKm) continue;
      out.push({ ...concert, latitude, longitude, distance_km: Math.round(distance * 10) / 10, match: 'distance' });
    } else if ((!where || !hasPoint) && sameCity(concert)) {
      // Not measurable: the show has no usable coordinates, or the caller sent
      // no point. Either way it is the name that matched, and it says so.
      out.push({ ...concert, latitude, longitude, distance_km: null, match: 'city_name' });
    }
  }
  return out;
}

/**
 * Whether a show's day is inside the asked window. A `wall_clock` or `date_only`
 * row stores the venue's own date, so it is cut exactly to [from, to]. An
 * `instant` row's UTC date can be a day either side of the venue's, so it is
 * kept (the query is already a day wider each side) and the caller, who has the
 * zone, makes the exact cut.
 *
 * @param {object} concert
 * @param {string} from YYYY-MM-DD
 * @param {string} to YYYY-MM-DD
 */
function inWindow(concert, from, to) {
  if (concertTimeKind(concert) === 'instant') return true;
  const day = new Date(concert.concert_date).toISOString().slice(0, 10);
  return day >= from && day <= to;
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

module.exports = { concertTimeKind, inWindow, nearbyConcerts, nearbyConcertOut };
