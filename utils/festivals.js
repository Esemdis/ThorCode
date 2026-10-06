/**
 * The Festivals page: every festival still to come, one entry each however
 * many rows it is stored as.
 *
 * A festival rarely arrives as one row. Bandsintown gives every act its own
 * page, named "<act> @ <festival>", and Songkick lists the same event as
 * "Nova Rock 2027" on one page and "Nova Rock Festival 2027" on another, a
 * couple of days apart. Ingest merges some of these, but not all of them, and
 * to anyone reading the list they are one festival.
 */
const { billForConcert } = require('./concertBill');
const { canonicalBandName } = require('./lineupNames');
const { haversineKm } = require('./concertDedup');
const { ticketState, saleDay } = require('./ticketState');

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
const DAY_MS = 24 * 60 * 60 * 1000;

// Days apart two rows of one festival can be: a long weekend, filed on
// different days by different sources.
const SAME_FESTIVAL_DAYS = 7;
// How far apart two names for one festival's grounds can be placed. The
// sources geocode the grounds, the town or the nearest city.
const SAME_FESTIVAL_KM = 30;

// Words that say a thing is a festival rather than which one it is. "Nova
// Rock" and "Nova Rock Festival" are one event, as are "Wacken Open Air" and
// "Wacken Festival".
const GENERIC_WORDS = new Set(['festival', 'fest', 'open', 'air', 'openair', 'the']);

const plain = (text) => String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** The words a festival is known by: no year, none of the generic ones. */
function nameWords(name) {
  return new Set(plain(name).split(/[^a-z0-9]+/).filter((w) => w && !/^\d{4}$/.test(w) && !GENERIC_WORDS.has(w)));
}

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

/** Whether a's words are all among b's, and there is at least one. */
const within = (a, b) => a.size > 0 && [...a].every((w) => b.has(w));

// Songkick's festival pages are a series and an edition of it:
// /festivals/3808399-hollywood-undead-euuk/id/43451186-hollywood-undead-euuk-2027.
const seriesOf = (url) => (typeof url === 'string' ? url.match(/songkick\.com\/festivals\/(\d+)/i)?.[1] ?? null : null);

const words = (text) => plain(text).split(/[^a-z0-9]+/).filter(Boolean);

// "Hollywood Undead: EU/UK 2027" opens with an act on its own bill. Word by
// word, so the band Hell does not make Hellfest a tour.
function namedAfterAnAct(concert) {
  const { name, proper } = festivalName(concert);
  if (!proper) return false;
  const title = words(name);
  return (concert.bands ?? []).some((b) => {
    const act = words(b.band_rel?.name);
    return act.length > 0 && act.length <= title.length && act.every((w, i) => title[i] === w);
  });
}

/**
 * The rows a Songkick festival link is all that marks, which are a tour.
 *
 * Songkick lets a tour be filed as a festival, and a page under /festivals/
 * says no more than that. A festival is held in one place, so one series with
 * dates in several towns is a tour; and a festival is never named after an act
 * on its own bill, which a tour usually is.
 *
 * @param {Array<{id: number, url: string|null, city: string|null}>} concerts
 * @returns {Set<number>} the ids of those rows
 */
function touringRows(concerts) {
  const towns = new Map();
  for (const concert of concerts) {
    const series = seriesOf(concert.url);
    if (!series) continue;
    if (!towns.has(series)) towns.set(series, new Set());
    towns.get(series).add(plain(concert.city));
  }
  return new Set(concerts.filter((concert) => {
    const series = seriesOf(concert.url);
    return (series && towns.get(series).size > 1) || namedAfterAnAct(concert);
  }).map((concert) => concert.id));
}

/**
 * Whether two rows are one festival: one name is the other with words added,
 * in one country, within a week, at one place.
 *
 * Containment rather than similarity, because what the sources add is words:
 * "Festival", a sponsor, the genre. Hurricane and Southside share a weekend
 * and a promoter, and are kept apart by their names and by 600 km.
 */
function sameFestival(a, b) {
  if ((a.concert.country ?? '') !== (b.concert.country ?? '')) return false;
  if (Boolean(a.day) !== Boolean(b.day)) return false;
  if (a.day && Math.abs(Date.parse(a.day) - Date.parse(b.day)) > SAME_FESTIVAL_DAYS * DAY_MS) return false;
  if (!within(a.words, b.words) && !within(b.words, a.words)) return false;

  const [latA, lngA, latB, lngB] = [a.concert.latitude, a.concert.longitude, b.concert.latitude, b.concert.longitude].map(parseFloat);
  if ([latA, lngA, latB, lngB].every(Number.isFinite) && haversineKm(latA, lngA, latB, lngB) <= SAME_FESTIVAL_KM) return true;
  return Boolean(a.concert.city) && plain(a.concert.city) === plain(b.concert.city);
}

/**
 * Every act we know of on a row, most of the bill first: the scraped lineup
 * in the order the source gives it, which is usually billing order, then any
 * linked act it does not name. A linked act goes by its Band row's name.
 */
function actsOf(concert) {
  const linked = (concert.bands ?? []).map((b) => b.band_rel).filter(Boolean);
  const byCanonical = new Map(linked.map((b) => [canonicalBandName(b.name), b]));
  const bill = billForConcert({ bands: [], metadata: concert.metadata }).map((act) => {
    const band = byCanonical.get(canonicalBandName(act.name));
    return band ? { id: band.id, name: band.name } : { id: null, name: act.name };
  });
  return [...bill, ...linked.map((b) => ({ id: b.id, name: b.name }))];
}

/**
 * One entry per festival.
 *
 * @param {Array<{id: number, name: string|null, venue: string|null, city: string|null,
 *   country: string|null, concert_date: Date|null, url: string|null, metadata: string|null,
 *   latitude: string|null, longitude: string|null,
 *   bands: {band_rel: {id: number, name: string}}[]}>} concerts
 * @param {object} options
 * @param {Map<number, string>} options.tiers - your wishlist's band ids, to their tier
 * @param {(concert: object) => boolean} [options.watched] - whether one of your
 *   festival watches names this row
 * @returns {Array<{key: string, name: string|null, first: string|null, last: string|null,
 *   city: string|null, country: string|null, url: string|null, acts: number,
 *   bands: {id: number, name: string, tier: string}[], lineup: string[],
 *   watched: boolean, concert_id: number, tickets: string, sale_date: string|null}>}
 *   soonest first; `lineup` is everyone else on the bill, `concert_id` the row
 *   to follow it by, and `tickets` that row's ticketState
 */
function groupFestivals(concerts, { tiers, watched = () => false }) {
  const rows = concerts.map((concert) => {
    const { name, proper } = festivalName(concert);
    return { concert, name, proper, day: dayOf(concert.concert_date), words: nameWords(name), acts: actsOf(concert) };
  });

  // Rows joined pairwise, so a festival's Friday and Sunday rows meet through
  // its Saturday one. A few hundred rows at most.
  const parent = rows.map((_, i) => i);
  const root = (i) => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (root(i) !== root(j) && sameFestival(rows[i], rows[j])) parent[root(j)] = root(i);
    }
  }
  const groups = new Map();
  rows.forEach((row, i) => {
    if (!groups.has(root(i))) groups.set(root(i), []);
    groups.get(root(i)).push(row);
  });

  return [...groups.values()].map((group) => {
    const byDay = [...group].sort((a, b) => (a.day ?? '9999').localeCompare(b.day ?? '9999'));
    const first = byDay[0];
    const days = byDay.map((r) => r.day).filter(Boolean);

    // Its own name over a page label, and Songkick's festival page's name over
    // another's: that page is the festival's, where an act's page is the act's.
    const rank = (r) => (r.proper ? 2 : 0) + (isSongkickFestival(r.concert.url) ? 1 : 0);
    const named = byDay.reduce((best, r) => (rank(r) > rank(best) ? r : best), first);
    // Songkick's festival page lists the whole event; an act's own page, the
    // first day's of them, is the fallback.
    const linked = byDay.find((r) => isSongkickFestival(r.concert.url)) ?? byDay.find((r) => r.concert.url);
    // The row a festival is followed by, and the one its tickets are read
    // from: the page that lists the whole event when there is one.
    const anchor = (linked ?? first).concert;
    const tickets = ticketState(anchor);

    // The fullest scraped lineup sets the order, since it is the one most
    // likely to be in billing order; the others add who it does not name.
    const fullest = [...group].sort((a, b) => b.acts.length - a.acts.length);
    const acts = new Map();
    for (const row of fullest) {
      for (const act of row.acts) {
        const canonical = canonicalBandName(act.name);
        if (!canonical) continue;
        // One row's lineup names an act another row has linked: the linked one
        // wins, in the place the name had, so your bands are found among them.
        const seen = acts.get(canonical);
        if (!seen || (seen.id == null && act.id != null)) acts.set(canonical, act);
      }
    }
    const yours = [...acts.values()].filter((a) => a.id != null && tiers.has(a.id));
    const others = [...acts.values()].filter((a) => !(a.id != null && tiers.has(a.id)));

    return {
      // Each row is in one entry, so its lowest row id is the entry's own.
      key: String(Math.min(...group.map((r) => r.concert.id))),
      name: named.name,
      first: days[0] ?? null,
      last: days[days.length - 1] ?? null,
      // Where the festival starts, which is the town it is known by.
      city: first.concert.city ?? null,
      country: first.concert.country ?? null,
      url: linked?.concert.url ?? null,
      concert_id: anchor.id,
      tickets,
      sale_date: tickets === 'on_sale_soon' ? saleDay(anchor) : null,
      watched: group.some((r) => watched(r.concert)),
      acts: acts.size,
      bands: yours.map((a) => ({ id: a.id, name: a.name, tier: tiers.get(a.id) })),
      lineup: others.map((a) => a.name),
    };
  }).sort((a, b) => {
    if (a.first !== b.first) {
      if (!a.first) return 1;
      if (!b.first) return -1;
      return a.first < b.first ? -1 : 1;
    }
    return String(a.name ?? '').localeCompare(String(b.name ?? ''));
  });
}

module.exports = { MIN_ACTS, SONGKICK_FESTIVAL, festivalName, touringRows, groupFestivals };
