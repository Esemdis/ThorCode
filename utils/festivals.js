/**
 * The Updates panel's Festivals list: every festival still to come, one entry
 * each however many rows it is stored as.
 *
 * A festival rarely arrives as one row. Bandsintown gives every act its own
 * page, named "<act> @ <festival>", and Songkick lists the same event as
 * "Copenhell 2027". Ingest merges most of these, but not all of them: rows on
 * other days, or ones the dedup windows kept apart, are still the same
 * festival to anyone reading the list.
 */
const { billForConcert } = require('./concertBill');
const { canonicalBandName } = require('./lineupNames');
const { normalizeEventName } = require('./concertDedup');

// Five acts on one bill: the line detectFestivalCluster draws across rows,
// drawn here on a single row. An act merged into a festival's row never sets
// its festival flag, so a festival only Bandsintown lists can grow to a dozen
// acts unflagged.
const MIN_ACTS = 5;

// Songkick files a festival under /festivals/ and a concert under /concerts/.
const SONGKICK_FESTIVAL = 'songkick.com/festivals/';

const isSongkickFestival = (url) => typeof url === 'string' && url.toLowerCase().includes(SONGKICK_FESTIVAL);

// The calendar day concert_date is filed under, as everywhere in the app.
const dayOf = (date) => (date ? new Date(date).toISOString().slice(0, 10) : null);

/**
 * What a festival row is called.
 *
 * "<act> @ <festival>" is a Bandsintown act page; the festival is after the
 * "@". A row named after an act on its own bill is a Songkick concert page,
 * and its venue is the festival's grounds, which is the better name.
 *
 * @param {{name: string|null, venue: string|null, bands?: {band_rel: {name: string}}[]}} concert
 * @returns {{name: string|null, proper: boolean}} proper is false for a name
 *   pieced together from a page label or a venue, which an entry gives up for
 *   a proper one when any of its rows has one
 */
function festivalName(concert) {
  const name = (concert.name ?? '').trim();
  const at = name.match(/^[^@]+@\s*(.+)$/);
  if (at) return { name: at[1].trim(), proper: false };
  const canonical = canonicalBandName(name);
  const namedForAnAct = canonical && (concert.bands ?? []).some((b) => canonicalBandName(b.band_rel?.name) === canonical);
  if (!name || namedForAnAct) return { name: concert.venue?.trim() || name || null, proper: false };
  return { name, proper: true };
}

/**
 * The rows that are one festival: its name with any act prefix and year taken
 * off, in one country, in one year. The year keeps next summer's edition apart
 * from this one once both are announced.
 */
function festivalKey(concert, name) {
  const normalized = name ? normalizeEventName(name) : '';
  if (!normalized) return `row|${concert.id}`;
  const day = dayOf(concert.concert_date);
  return `${normalized}|${concert.country ?? ''}|${day ? day.slice(0, 4) : ''}`;
}

/**
 * One entry per festival.
 *
 * @param {Array<{id: number, name: string|null, venue: string|null, city: string|null,
 *   country: string|null, concert_date: Date|null, url: string|null, metadata: string|null,
 *   bands: {band_rel: {id: number, name: string}}[]}>} concerts
 * @param {object} options
 * @param {Map<number, string>} options.tiers - your wishlist's band ids, to their tier
 * @param {(concert: object) => boolean} [options.watched] - whether one of your
 *   festival watches names this row
 * @returns {Array<{key: string, name: string|null, first: string|null, last: string|null,
 *   city: string|null, country: string|null, url: string|null, acts: number,
 *   bands: {id: number, name: string, tier: string}[], watched: boolean}>} soonest first
 */
function groupFestivals(concerts, { tiers, watched = () => false }) {
  const entries = new Map();

  for (const concert of concerts) {
    const { name, proper } = festivalName(concert);
    const key = festivalKey(concert, name);
    const day = dayOf(concert.concert_date);
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        key, name, proper, first: day, last: day, city: concert.city ?? null, country: concert.country ?? null,
        url: null, urlDay: null, acts: new Set(), bands: new Map(), watched: false,
      };
      entries.set(key, entry);
    }

    if (proper && !entry.proper) Object.assign(entry, { name, proper });
    if (day && (!entry.first || day < entry.first)) {
      entry.first = day;
      // Where the festival starts, which is the town it is known by.
      entry.city = concert.city ?? entry.city;
    }
    if (day && (!entry.last || day > entry.last)) entry.last = day;

    // Songkick's festival page lists the whole event; an act's own page, the
    // first day's of them, is the fallback.
    const url = concert.url || null;
    if (url) {
      const better = !entry.url
        || (isSongkickFestival(url) && !isSongkickFestival(entry.url))
        || (isSongkickFestival(url) === isSongkickFestival(entry.url) && day && (!entry.urlDay || day < entry.urlDay));
      if (better) Object.assign(entry, { url, urlDay: day });
    }

    const linked = (concert.bands ?? []).map((b) => b.band_rel).filter(Boolean);
    for (const act of billForConcert({ bands: linked, metadata: concert.metadata })) {
      const canonical = canonicalBandName(act.name);
      if (canonical) entry.acts.add(canonical);
    }
    for (const band of linked) {
      if (tiers.has(band.id)) entry.bands.set(band.id, { id: band.id, name: band.name, tier: tiers.get(band.id) });
    }
    if (watched(concert)) entry.watched = true;
  }

  return [...entries.values()]
    .map(({ proper: _p, urlDay: _u, acts, bands, ...entry }) => ({
      ...entry,
      acts: acts.size,
      bands: [...bands.values()],
    }))
    .sort((a, b) => {
      if (a.first !== b.first) {
        if (!a.first) return 1;
        if (!b.first) return -1;
        return a.first < b.first ? -1 : 1;
      }
      return String(a.name ?? '').localeCompare(String(b.name ?? ''));
    });
}

module.exports = { MIN_ACTS, SONGKICK_FESTIVAL, festivalName, groupFestivals };
