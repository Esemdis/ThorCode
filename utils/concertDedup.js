/**
 * Deciding when two concert listings are one show.
 *
 * The same night reaches us in several shapes: Songkick's "Zenith de Nancy" is
 * Bandsintown's "Amphitheatre Plein Air", a festival is one page per artist, a
 * late set is filed as the next morning. Three places need an answer, and they
 * all read the rules in this file:
 *
 *   deduplicateByCoords    one /bulk payload against itself, before any DB work
 *   checkDuplicateConcert  one incoming concert against the stored rows
 *   deduplicateConcerts    stored rows against each other, on the way out
 *
 * They share one bias, deliberately: a merge that does not happen leaves two
 * rows for one night, which is visible and can be fixed, where a merge that
 * should not have happened destroys a concert nobody will know was there.
 */
const { canonicalBandName, cleanLineupJson, lineupGrew } = require('./lineupNames');
const { mergeTicketFields } = require('./ticketState');

const DAY_MS = 24 * 60 * 60 * 1000;

// How far apart two rows can be and still be one place. AREA_KM is a city and
// its outskirts, the line nothing is merged across; GROUND_KM is the tighter
// one for two festival rows whose grounds are named differently.
const AREA_KM = 20;
const GROUND_KM = 8;

// Dice coefficients, 0–1. VENUE_SAME is "the same room, spelled the same way".
const NAME_SIM = 0.8;
const VENUE_SIM = 0.7;
const VENUE_SAME = 0.95;
const CITY_SIM = 0.7;

// The window of stored rows a merge may reach across: a festival's days. A
// named event with no festival about it reaches NAMED_DAYS, one source dating
// the same show differently from another reaches SLIP_DAYS.
const WINDOW_DAYS = 7;
const NAMED_DAYS = 3;
const SLIP_DAYS = 1;

// Below this, a normalized event name ("fest", "live") is too generic to
// cluster rows on.
const MIN_EVENT_NAME = 6;

// What a bill shared across rows under one event name has to add up to before
// it is a festival rather than a support act.
const CLUSTER_BANDS = 5;

// Three or more acts on one row is a bill, not a tour date.
const MULTI_BAND = 3;

// ─── Place, time and text ────────────────────────────────────────────────────

/** Haversine distance in km between two lat/lng points. */
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Midnight UTC on a date's calendar day, as ms. NaN for no date, or a bad one. */
function dayOf(value) {
  if (!value) return NaN;
  const d = new Date(value);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** `YYYY-MM-DD`, or 'undated'. */
function dayKey(value) {
  const day = dayOf(value);
  return Number.isNaN(day) ? 'undated' : new Date(day).toISOString().slice(0, 10);
}

/**
 * Whole days between two calendar days, either way round. NaN when either date
 * is missing, which fails every comparison made against it.
 */
function dayGap(a, b) {
  return Math.abs(dayOf(a) - dayOf(b)) / DAY_MS;
}

/** Accents off, down to a-z0-9, for comparing names as labels. */
function flatten(value) {
  return (value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * An event name with the "Artist @ " prefix and any year stripped, so
 * "Resurrection Fest 2026" and "Imminence @ Resurrection Fest" are one name.
 */
function normalizeEventName(value) {
  return flatten((value || '').replace(/^[^@]+@\s*/i, '').replace(/\b\d{4}\b/g, ''));
}

/** Bigram Dice coefficient, 0–1. Unicode-safe: keeps letters and digits of any script. */
function stringSimilarity(a, b) {
  const squeeze = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const na = squeeze(a), nb = squeeze(b);
  if (na === nb) return na ? 1 : 0;
  if (!na || !nb) return 0;
  const bigrams = (s) => Array.from({ length: s.length - 1 }, (_, i) => s.slice(i, i + 2));
  const ba = bigrams(na), bb = bigrams(nb);
  if (!ba.length || !bb.length) return 0;
  const counts = new Map();
  for (const g of bb) counts.set(g, (counts.get(g) || 0) + 1);
  let matches = 0;
  for (const g of ba) if (counts.get(g) > 0) { matches++; counts.set(g, counts.get(g) - 1); }
  return (2 * matches) / (ba.length + bb.length);
}

/**
 * Whether one venue name is substantially contained in the other — "Zenith De
 * Nancy - Amphitheatre Plein Air" holds "Amphitheatre Plein Air". The shorter
 * fragment must be 10 characters or more, or every "The Hall" matches.
 */
function venueContains(a, b) {
  const na = flatten(a), nb = flatten(b);
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  return shorter.length >= 10 && longer.includes(shorter);
}

/**
 * How far two venue names agree, 0–1: containment counts as agreement, since
 * one source names the room and another the building it is in.
 */
function venueSimilarity(a, b) {
  if (!a || !b) return 0;
  return venueContains(a, b) ? 1 : stringSimilarity(a, b);
}

/** Both rows carry coordinates, and they are within `km` of each other. */
function withinKm(a, b, km) {
  const [aLat, aLng, bLat, bLng] = [a.latitude, a.longitude, b.latitude, b.longitude].map(parseFloat);
  if (![aLat, aLng, bLat, bLng].every(Number.isFinite)) return false;
  return haversineKm(aLat, aLng, bLat, bLng) <= km;
}

/**
 * One place: close enough by position, or the same city by name.
 *
 * Every rule below is confined to this. A venue brand with a room in each city
 * — "O2 Academy", "Zenith" — otherwise matched on its name alone, and a tour
 * playing two of them on consecutive nights lost one of the two concerts.
 */
function nearby(a, b) {
  return withinKm(a, b, AREA_KM)
    || (!!a.city && !!b.city && stringSimilarity(a.city, b.city) >= CITY_SIM);
}

/**
 * Whether a concert date carries a time of day rather than just a day. A show
 * scraped with no start time is stored at exactly midnight UTC, so midnight
 * reads as "no time published" rather than a show at 00:00.
 */
function hasTimeOfDay(value) {
  if (!value) return false;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return false;
  return d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0 || d.getUTCSeconds() !== 0;
}

/**
 * Whether a name is the "Band @ Venue" shape a scraper falls back to when the
 * event published none. A row carrying a real event name is the better record.
 */
function isFallbackName(name) {
  const s = name || '';
  return s.includes(' @ ') || / at /i.test(s);
}

/**
 * The better of two event names: a real one over a scraper's fallback, and
 * between two real ones the shorter, which is the festival rather than the
 * festival plus a day number. Two fallbacks say the same thing, so the stored
 * one stays — a festival row would otherwise be renamed after whichever of its
 * acts was scraped last, every sync.
 */
function bestEventName(current, incoming) {
  if (!incoming) return current;
  if (!current) return incoming;
  if (isFallbackName(current) !== isFallbackName(incoming)) {
    return isFallbackName(current) ? incoming : current;
  }
  if (isFallbackName(current)) return current;
  return incoming.length < current.length ? incoming : current;
}

// ─── What a row is an event of ───────────────────────────────────────────────

/**
 * The event a row is listed under, or null when it names none.
 *
 * Bandsintown's fallback title is "<band> @ <venue>", and stripping the "@"
 * prefix off that leaves the venue — so two tour stops in one room on
 * different nights would read as one multi-day event. Three titles are
 * therefore dropped: one whose "@" leads back to the row's own venue, one with
 * " at " in it (a real "Live at Leeds" is left to the scraper's own bill-length
 * rule), and one named after an act on the bill, which is a band's own show.
 * "Slipknot @ Graspop Metal Meeting 2025" survives all three.
 */
function eventLabel(row, bandNames = []) {
  if (!row.name || / at /i.test(row.name)) return null;
  const label = row.name.replace(/^[^@]+@\s*/i, '').trim();
  if (!label) return null;
  if (row.venue && venueSimilarity(label, row.venue) >= VENUE_SIM) return null;
  const canonical = canonicalBandName(label);
  if (canonical && bandNames.some((name) => canonicalBandName(name) === canonical)) return null;
  return label;
}

/** The band names on a stored row, for eventLabel. */
function storedBandNames(row) {
  return (row.bands ?? []).map((ref) => ref.band_rel?.name).filter(Boolean);
}

/**
 * Whether a row is a festival, read from the stored rows around it rather than
 * from the row itself.
 *
 * Bandsintown files a festival as one page per artist, so a stage-specific
 * "Artist @ Graspop Metal Meeting" page lists that one act and the scraper's
 * own rule — a bill over six — never fires for it. What no single page can
 * show is what the rows sharing its event name add up to: more than one
 * calendar day, or five bands between them.
 *
 * @param {object} concert - the incoming concert (name, venue, concert_date, city, coords)
 * @param {number[]} bandIds - its resolved band ids
 * @param {object[]} candidates - stored rows for the date window, each carrying
 *   its bands as `bands[].band` and their names as `bands[].band_rel.name`
 * @param {string[]} bandNames - the incoming concert's own band names
 * @returns {{isFestival: boolean, matches: object[]}} matches are the rows
 *   sharing the name; the caller flags those too, since each is just as blind
 *   to this on its own.
 */
function detectFestivalCluster(concert, bandIds, candidates, bandNames = []) {
  const label = eventLabel(concert, bandNames);
  const name = normalizeEventName(label);
  if (name.length < MIN_EVENT_NAME) return { isFestival: false, matches: [] };

  const matches = candidates.filter((row) => {
    const other = eventLabel(row, storedBandNames(row));
    return other
      && stringSimilarity(name, normalizeEventName(other)) >= NAME_SIM
      && nearby(concert, row);
  });

  const days = new Set([concert, ...matches].map((row) => dayOf(row.concert_date)));
  const bands = new Set([...bandIds, ...matches.flatMap((row) => (row.bands ?? []).map((ref) => ref.band))]);
  return { isFestival: days.size >= 2 || bands.size >= CLUSTER_BANDS, matches };
}

// ─── One payload against itself ──────────────────────────────────────────────

/**
 * One of two same-day, same-place rows from different sources, carrying what
 * the other knew that it did not.
 *
 * Both scrapers file a show with the one band whose page they were reading, so
 * the bill length that picks a survivor is usually a tie, and a tie goes to
 * whichever source ran first — Songkick. What the dropped row knew went with
 * it: Bandsintown is the source that lists a festival's bill, and either can
 * be the only one to have seen a show sold out or name the day its sale opens.
 * None of that reached the stored row's merge in checkDuplicateConcert,
 * because the row holding it was gone before the payload got there.
 *
 * Deliberately not merged: concert_date and source. A date means a true UTC
 * instant from one source and the venue's wall clock from another, and which
 * it is is read back off `source`, so taking the other row's time would
 * relabel it. event_id likewise stays the survivor's — it is that source's
 * handle on the show, and the dropped row's own sync finds the stored row
 * again through the duplicate check.
 *
 * @param {object} keep - the row the bucket keeps
 * @param {object} drop - the row being dropped into it
 * @returns {object} a copy of `keep`, nothing mutated in place
 */
function foldSourceInto(keep, drop) {
  const merged = { ...keep };

  // What the tickets are doing is the state of the world, not something one
  // row owns: whatever either source saw of them counts, and only silence is
  // overruled. Said by neither stays unsaid — null is not "no", and both sites
  // mark a listing in stock by default, so a scraper with nothing specific to
  // report sends nothing and the stored row keeps what it had.
  const either = (a, b) => {
    if (a || b) return true;
    return (a == null && b == null) ? null : false;
  };
  merged.sold_out = either(keep.sold_out, drop.sold_out);
  merged.on_sale = merged.sold_out === true ? false : either(keep.on_sale, drop.on_sale);
  merged.ticket_sale_start = keep.ticket_sale_start ?? drop.ticket_sale_start ?? null;

  // The price trio moves as a unit. A minimum from one source beside a
  // currency from the other reads as a price in money nobody quoted.
  if (keep.price_min == null && drop.price_min != null) {
    Object.assign(merged, {
      price_min: drop.price_min,
      price_max: drop.price_max ?? null,
      price_currency: drop.price_currency ?? null,
    });
  }

  // The longer bill, counted on the names it holds rather than on how many of
  // them have a Band row — see lineupGrew. Cleaned, as every other writer of
  // this column cleans.
  const dropLineup = cleanLineupJson(drop.metadata);
  if (lineupGrew(cleanLineupJson(keep.metadata), dropLineup)) merged.metadata = dropLineup;
  merged.festival = Boolean(keep.festival || drop.festival);

  // The better event name, by the same preference the stored row's merge
  // makes: the festival rules read these names, and a fallback name tells
  // them nothing.
  merged.name = bestEventName(keep.name, drop.name);
  if (!keep.url && drop.url) merged.url = drop.url;
  if (!keep.venue && drop.venue) merged.venue = drop.venue;

  return merged;
}

/**
 * Collapses an incoming /bulk payload by position and day before any DB work,
 * keeping the entry with the most bands and folding what the others knew into
 * it — see foldSourceInto. Concerts with no usable position pass through for
 * the rules below to match on venue, city and bill instead.
 *
 * The day is part of the key: keyed on position alone, a band's second night in
 * one room was dropped here, before any of those rules saw it.
 */
function deduplicateByCoords(concerts) {
  // Coordinates are read as numbers, not merely tested for null: they arrive
  // as strings, and anything in them that is not a number — "", "N/A", a venue
  // name — divided to NaN and rounded to the literal key "NaN:NaN", which
  // every such row shared. Two unrelated shows on one day, in cities neither
  // row placed, were collapsed to one here on a position neither of them has.
  // parseFloat for the same reading withinKm makes, so a bucket holds what
  // that would call one place.
  const key = (concert) => {
    const [lat, lng] = [concert.latitude, concert.longitude].map(parseFloat);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return `${Math.round(lat / 0.001)}:${Math.round(lng / 0.001)}@${dayKey(concert.concert_date)}`;
  };

  const byCell = new Map();
  const noCoords = [];
  for (const concert of concerts) {
    const cell = key(concert);
    if (!cell) { noCoords.push(concert); continue; }
    const kept = byCell.get(cell);
    if (!kept) { byCell.set(cell, concert); continue; }
    const incomingWins = (concert.bands?.length ?? 0) > (kept.bands?.length ?? 0);
    byCell.set(cell, incomingWins ? foldSourceInto(concert, kept) : foldSourceInto(kept, concert));
  }
  return [...byCell.values(), ...noCoords];
}

// ─── One concert against the stored rows ─────────────────────────────────────

// Everything the rules and the merge below read off a stored row, plus what
// routes/data/bands/ingest.js reports back to the scraper. Selected rather than
// included: this runs once per incoming concert and would otherwise pull every
// column of every row in a fifteen-day window.
const CANDIDATE_FIELDS = {
  id: true, event_id: true, name: true, venue: true, city: true, country: true,
  latitude: true, longitude: true, concert_date: true, festival: true, source: true,
  metadata: true, url: true, on_sale: true, sold_out: true, ticket_sale_start: true,
  price_min: true, price_max: true, price_currency: true, notify_pending: true,
  // Band names ride along for eventLabel, which has to know whether a row is
  // named after one of its own acts.
  bands: { select: { band: true, band_rel: { select: { name: true } } } },
};

/**
 * The stored row an incoming concert belongs to, or null.
 *
 * Four rules, tried in order of how much they take on trust, each one confined
 * to candidates in the same place. Within a rule the longest bill wins, and the
 * lowest id breaks a tie, so the answer does not depend on the order Postgres
 * happened to return the rows in.
 *
 * @param {Set<number>} [upgraded] - ids the cluster check has just found to be
 *   a festival, which the rows themselves do not say yet
 */
function findStoredMatch(concert, bandIds, candidates, upgraded = new Set()) {
  const gap = (row) => dayGap(concert.concert_date, row.concert_date);
  const sharesABand = (row) => row.bands.some((ref) => bandIds.includes(ref.band));
  const isFestival = (row) => !!row.festival || upgraded.has(row.id);
  const isBill = (row) => isFestival(row) || row.bands.length >= MULTI_BAND;
  const incomingIsBill = concert.festival || bandIds.length >= MULTI_BAND;
  const eitherIsBill = (row) => incomingIsBill || isBill(row);
  const venueAgrees = (row) => venueSimilarity(concert.venue, row.venue);

  /**
   * One source never lists the same show on two days, so when both sides name
   * the same source and the days differ, that is a second night at the same
   * room and merging it would lose a real concert. The day-apart windows below
   * exist for one show that two sources date differently — a late set filed as
   * the next morning, a timezone slip. Days of one festival are exempt:
   * `oneEvent` is for the rows that say so without the flag being set yet.
   */
  const separateNight = (row, oneEvent = false) =>
    !!concert.source && concert.source === row.source && gap(row) > 0
    && !oneEvent && !(concert.festival && isFestival(row));

  const rules = [
    // The same band cannot be in two places on one night.
    (row) => gap(row) === 0 && sharesABand(row),

    // One named event, by either spelling of its name.
    (row) => {
      if (!concert.name || !row.name) return false;
      const raw = stringSimilarity(concert.name, row.name);
      const normalized = normalizeEventName(concert.name);
      const norm = normalized.length >= MIN_EVENT_NAME
        ? stringSimilarity(normalized, normalizeEventName(row.name))
        : 0;
      if (Math.max(raw, norm) < NAME_SIM) return false;
      // Only the normalized forms matching means two "Artist @ Festival" pages
      // of one event, which spans its days — where two nights of one tour carry
      // the identical fallback name and score 1.0 on the raw one.
      const oneEvent = norm >= NAME_SIM && raw < NAME_SIM;
      if (separateNight(row, oneEvent)) return false;
      return gap(row) <= (oneEvent ? WINDOW_DAYS : NAMED_DAYS);
    },

    // One venue.
    (row) => {
      const venue = venueAgrees(row);
      if (venue < VENUE_SIM || separateNight(row)) return false;
      // The same room spelled the same way on one day is one show whether the
      // bills overlap or not, and so are two days of one festival on one
      // ground. Anything softer than that has to share a band.
      const certain = venue >= VENUE_SAME
        && (gap(row) === 0 || (concert.festival && isFestival(row)));
      if (bandIds.length > 0 && !sharesABand(row) && !certain) return false;
      return gap(row) <= SLIP_DAYS || eitherIsBill(row) || certain;
    },

    // One city, for rows that name no venue in common.
    (row) => {
      if (separateNight(row)) return false;
      const bill = eitherIsBill(row);
      if (bandIds.length > 0 && !sharesABand(row) && !bill) return false;
      if (gap(row) > (bill ? WINDOW_DAYS : SLIP_DAYS)) return false;
      // Two rooms that clearly disagree are two events — unless both rows are
      // festivals, where each source names the same ground differently
      // ("Wacken Open Air" against "Wacken Festivalgelände"), and then only
      // within a few kilometres of each other.
      if (concert.venue && row.venue && venueAgrees(row) < VENUE_SIM) {
        return incomingIsBill && isBill(row) && withinKm(concert, row, GROUND_KM);
      }
      return true;
    },
  ];

  const here = candidates.filter((row) => nearby(concert, row));
  for (const rule of rules) {
    const [best] = here.filter(rule).sort((a, b) => b.bands.length - a.bands.length || a.id - b.id);
    if (best) return best;
  }
  return null;
}

/**
 * The fields to write when a scrape merges into a stored row: only those it
 * actually changes, since this runs for every row of every sync, twice a day,
 * and a write that changes nothing still looks like news to anything watching.
 *
 * Used by both merge paths — the one that matched on an event id and the one
 * that matched on the rules above — so a show already stored is updated the
 * same way however it was recognised.
 *
 * @param {object} stored - the row as it is
 * @param {object} incoming - the scraped concert
 * @param {Date} [now]
 * @returns {object} fields for concert.update, which may be none
 */
function mergedFields(stored, incoming, now = new Date()) {
  const lineup = cleanLineupJson(incoming.metadata);
  // The price a row shows belongs to a listing, so only that listing's own
  // source may change it. Any source may fill one in where there is none.
  const ownsListing = !stored.source || stored.source === incoming.source;

  const wanted = {
    name: bestEventName(stored.name, incoming.name),
    // On the length of the bill it names rather than on how many of those
    // names have a Band row: an act joining a festival mostly has none, and
    // the bill is what a follower's lineup alert is measured against.
    ...(lineupGrew(stored.metadata, lineup) && { metadata: lineup }),
    // A flag is only ever raised. detectFestivalCluster can tell a festival
    // from the rows around it that none of them could tell alone.
    ...(incoming.festival && { festival: true }),
    ...adoptedTime(stored, incoming),
  };
  for (const key of ['price_min', 'price_max', 'price_currency']) {
    if (incoming[key] != null && (stored[key] == null || ownsListing)) wanted[key] = incoming[key];
  }

  const changed = ([key, value]) => {
    const was = stored[key];
    if (value === undefined) return false;
    if (value instanceof Date) return !(was && new Date(was).getTime() === value.getTime());
    return (was ?? null) !== value;
  };
  return {
    ...Object.fromEntries(Object.entries(wanted).filter(changed)),
    // Already narrowed to what is new, and to what a source is entitled to say
    // — a listing marked in stock by default must not clear a sale day.
    ...mergeTicketFields(stored, incoming, now),
  };
}

/**
 * A start time for a row that has only a day, or a date for one that has none.
 *
 * Songkick leaves 182 of its rows at midnight, so whether a show has a time at
 * all comes down to which scraper reached it first. The source and the ticket
 * link come along with the time, because `source` is what says whether a
 * stored time is a real instant or the venue's wall clock (utils/ics.js): read
 * under the wrong one, the show renders hours out.
 *
 * Only ever the same day. A show moved to another date is a different thing,
 * and only the path that matched on an event id knows the listing well enough
 * to follow it there.
 */
function adoptedTime(stored, incoming) {
  if (!incoming.concert_date) return null;
  const when = new Date(incoming.concert_date);
  if (Number.isNaN(when.getTime())) return null;
  if (stored.concert_date) {
    if (dayGap(stored.concert_date, when) !== 0) return null;
    if (hasTimeOfDay(stored.concert_date) || !hasTimeOfDay(when)) return null;
  }
  return {
    concert_date: when,
    ...(incoming.source && { source: incoming.source }),
    ...(incoming.url && { url: incoming.url }),
  };
}

/**
 * Whether an incoming concert is already stored, merging it in if it is.
 *
 * Mutates `concert.festival`: the cluster check can tell a festival that the
 * scrape itself could not, and the caller goes on to use the flag — for the
 * insert, if this turns out not to be a duplicate, and to say which kind of
 * duplicate it was.
 *
 * @returns {{isDuplicate: boolean, existingConcert: object|null, linked: number[], merged: object}}
 *   `linked` is the band ids this merge put on the stored row's bill and
 *   `merged` the fields it wrote to the row. With `notify` set, those links and
 *   the row are flagged as owed a notification.
 */
async function checkDuplicateConcert({ concert, bandIds, bandNames = [], tx, notify = false }) {
  const nothing = { isDuplicate: false, existingConcert: null, linked: [], merged: {} };
  if (!concert.concert_date) return nothing;

  const day = dayOf(concert.concert_date);
  const candidates = await tx.concert.findMany({
    where: {
      concert_date: {
        gte: new Date(day - WINDOW_DAYS * DAY_MS),
        lte: new Date(day + WINDOW_DAYS * DAY_MS),
      },
    },
    select: CANDIDATE_FIELDS,
  });

  // Before the rules run, so an upgrade here widens this concert's own windows
  // too. The flag is written back to the rows that could not see it either,
  // and carried to the rules below, which it tells that these are the days of
  // one festival rather than separate nights at one place.
  const { isFestival, matches } = detectFestivalCluster(concert, bandIds, candidates, bandNames);
  const upgraded = new Set();
  if (isFestival) {
    concert.festival = true;
    for (const row of matches) upgraded.add(row.id);
    const stale = matches.filter((row) => !row.festival).map((row) => row.id);
    if (stale.length > 0) {
      await tx.concert.updateMany({ where: { id: { in: stale } }, data: { festival: true } });
    }
  }

  const stored = findStoredMatch(concert, bandIds, candidates, upgraded);
  if (!stored) return nothing;

  const data = mergedFields(stored, concert);
  if (Object.keys(data).length > 0) {
    await tx.concert.update({ where: { id: stored.id }, data });
  }

  const alreadyOnBill = await tx.concertBandReference.findMany({
    where: { concert: stored.id, band: { in: bandIds } },
    select: { band: true },
  });
  const linked = [...new Set(bandIds)].filter(
    (id) => !alreadyOnBill.some((ref) => ref.band === id),
  );
  if (linked.length > 0) {
    // skipDuplicates because this runs inside /bulk's transaction, where a
    // unique violation is not one failed statement but an aborted transaction
    // for everything after it.
    await tx.concertBandReference.createMany({
      data: linked.map((band) => ({ concert: stored.id, band, notify_pending: notify })),
      skipDuplicates: true,
    });
    // This is how a festival's acts after the first arrive: each one its own
    // scrape, merged into the row the first one made. Flagged, the act is
    // announced like a new show; unflagged, it reached no one.
    if (notify && !stored.notify_pending) {
      await tx.concert.update({ where: { id: stored.id }, data: { notify_pending: true } });
    }
  }

  return { isDuplicate: true, existingConcert: stored, linked, merged: data };
}

// ─── Stored rows against each other, on the way out ──────────────────────────

/** A lineup column as an array of names. Anything else in it counts as none. */
function billNames(json) {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((name) => typeof name === 'string') : [];
  } catch {
    return [];
  }
}

/** Two rows that are one event: one name, one room, one place, inside a week. */
function sameEvent(a, b) {
  if (!a.name || !b.name || !a.venue || !b.venue) return false;
  if (!(dayGap(a.concert_date, b.concert_date) <= WINDOW_DAYS)) return false;
  return venueSimilarity(a.venue, b.venue) >= VENUE_SIM
    && stringSimilarity(a.name, b.name) >= NAME_SIM
    && nearby(a, b);
}

/**
 * Two rows that are one night: one day, one place, a band on both bills. Named
 * differently and in different rooms — a support act's own listing beside the
 * headline show it belongs to.
 *
 * Festivals are left out. Two of them on one weekend share bands as a matter of
 * course, and folding them together would lose one whole festival.
 */
function sameNight(a, b) {
  if (a.festival || b.festival) return false;
  if (dayGap(a.concert_date, b.concert_date) !== 0) return false;
  if (!nearby(a, b)) return false;
  const ids = new Set((a.participating_bands ?? []).map((band) => band.id));
  return (b.participating_bands ?? []).some((band) => ids.has(band.id));
}

/**
 * Two rows folded into one.
 *
 * Which of them survives cannot be left to arrival order, which is whatever
 * the caller's wishlist iteration produced: a support act's own Bandsintown
 * listing — "As December Falls @ SWG3 Garden", the room next door — arriving
 * first used to title the gig after the support act and move it to the wrong
 * room. A row carrying a real event name is the better record of the two.
 */
function mergeRows(base, other) {
  const winner = isFallbackName(base.name) && !isFallbackName(other.name) ? other : base;
  const loser = winner === base ? other : base;

  const bands = [...(winner.participating_bands ?? [])];
  const seen = new Set(bands.map((band) => band.id));
  for (const band of loser.participating_bands ?? []) {
    if (!seen.has(band.id)) { seen.add(band.id); bands.push(band); }
  }

  const names = [...new Set([...billNames(winner.metadata), ...billNames(loser.metadata)])];
  const merged = {
    ...winner,
    participating_bands: bands,
    metadata: names.length > 0 ? JSON.stringify(names) : winner.metadata ?? loser.metadata ?? null,
  };

  // A published time beats no time, and brings its source with it for the same
  // reason the insert-time merge does — see adoptedTime.
  if (!hasTimeOfDay(merged.concert_date) && hasTimeOfDay(loser.concert_date)) {
    merged.concert_date = loser.concert_date;
    merged.source = loser.source;
  }
  return merged;
}

/**
 * Folds the stored rows of one response together.
 *
 * Input: concerts already deduplicated by DB id. A row is merged into the first
 * kept row it is one event or one night with, rather than dropped, so a band
 * linked only to the row that loses still appears on the bill.
 */
function deduplicateConcerts(concerts) {
  const kept = [];
  // Indexed by day, since nothing merges across more than WINDOW_DAYS of them.
  const byDay = new Map();
  const around = (key) => {
    if (key === 'undated') return [];
    const day = Date.parse(key);
    const out = [];
    for (let offset = -WINDOW_DAYS; offset <= WINDOW_DAYS; offset++) {
      out.push(...(byDay.get(dayKey(day + offset * DAY_MS)) ?? []));
    }
    return out;
  };

  for (const concert of concerts) {
    const key = dayKey(concert.concert_date);
    const at = around(key).find((index) => sameEvent(kept[index], concert) || sameNight(kept[index], concert));
    if (at !== undefined) {
      kept[at] = mergeRows(kept[at], concert);
      continue;
    }
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(kept.length);
    kept.push({ ...concert });
  }
  return kept;
}

module.exports = {
  // Shared by other modules for fuzzy matching
  haversineKm,
  stringSimilarity,
  venueContains,
  venueSimilarity,
  detectFestivalCluster,
  // Insert-time
  deduplicateByCoords,
  checkDuplicateConcert,
  mergedFields,
  // Response-time
  deduplicateConcerts,
};
