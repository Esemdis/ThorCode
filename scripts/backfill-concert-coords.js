// Gives coordinates to concerts that have none, so they stop being invisible.
//
// A concert with no latitude/longitude is filtered out of the map entirely —
// buildCityGroups drops it — while still appearing in the list, with nothing to
// say why. All of them come in through paths that never carried coordinates:
// the setlist.fm history import, which knows only venue, city and country, and a
// handful of Songkick rows.
//
// Nothing is geocoded here. The coordinates are borrowed from concerts we
// already hold, which costs no API calls and cannot invent a location:
//
//   1. Same venue, matched exactly or at 90% similarity within the same city.
//      As precise as the row it came from.
//   2. setlist.fm's own venue search, which returns coordinates for the venue's
//      city. These rows were imported from setlist.fm without them, so this is
//      asking the same source for what it already knew.
//   3. The City row for that city and country. Puts the pin in the right city
//      rather than nowhere, which for a past show in a history view is the whole
//      point. It is a city centre, not a venue — approximate by construction.
//
// Anything no pass can place is left alone and reported.
//
//   doppler run -c prd -- node scripts/backfill-concert-coords.js --dry-run
//   doppler run -c prd -- node scripts/backfill-concert-coords.js

const axios = require('axios');
const prisma = require('../prisma/client');
const { stringSimilarity } = require('../utils/concertDedup');

const VENUE_SIMILARITY = 0.9;
// setlist.fm asks for one request per second.
const SETLIST_GAP_MS = 1100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Coordinates for a venue from setlist.fm, or null. Cached per venue+city. */
const venueLookupCache = new Map();
async function fromSetlistFm(venue, city) {
  if (!venue || !process.env.SETLIST_API_KEY) return null;
  const key = `${venue}|${city}`.toLowerCase();
  if (venueLookupCache.has(key)) return venueLookupCache.get(key);

  let found = null;
  try {
    const { data } = await axios.get('https://api.setlist.fm/rest/1.0/search/venues', {
      headers: { 'x-api-key': process.env.SETLIST_API_KEY, Accept: 'application/json' },
      params: { name: venue, ...(city ? { cityName: city } : {}), p: 1 },
      timeout: 15000,
    });
    for (const candidate of data?.venue ?? []) {
      const coords = candidate?.city?.coords;
      if (!coords?.lat || !coords?.long) continue;
      // Same guard as everywhere else: only accept a venue that is the one asked
      // for, not merely the first thing the search returned.
      if (stringSimilarity(candidate.name ?? '', venue) < VENUE_SIMILARITY) continue;
      found = { latitude: coords.lat, longitude: coords.long };
      break;
    }
  } catch (error) {
    if (error.response?.status !== 404) {
      console.error(`  setlist.fm lookup failed for ${venue}: ${error.response?.status ?? error.message}`);
    }
  }

  venueLookupCache.set(key, found);
  await sleep(SETLIST_GAP_MS);
  return found;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const missing = await prisma.concert.findMany({
    where: { OR: [{ latitude: null }, { longitude: null }] },
    select: {
      id: true, name: true, venue: true, city: true, country: true,
      source: true, concert_date: true, city_id: true,
    },
    orderBy: { id: 'asc' },
  });

  if (missing.length === 0) {
    console.log('Every concert already has coordinates.');
    return;
  }

  const [donors, cities] = await Promise.all([
    prisma.concert.findMany({
      where: { latitude: { not: null }, longitude: { not: null } },
      select: { venue: true, city: true, latitude: true, longitude: true },
    }),
    prisma.city.findMany({
      where: { latitude: { not: null }, longitude: { not: null } },
      select: { id: true, name: true, country: true, latitude: true, longitude: true },
    }),
  ]);

  const cityKey = (name, country) => `${(name || '').toLowerCase()}|${country || ''}`;
  const cityByKey = new Map(cities.map((c) => [cityKey(c.name, c.country), c]));

  const fromVenue = (concert) => {
    if (!concert.venue) return null;
    let best = null;
    let bestScore = 0;
    for (const donor of donors) {
      if (!donor.venue) continue;
      // Same city as well as same venue name: plenty of countries have an
      // "Arena" and a "Forum".
      if ((donor.city || '').toLowerCase() !== (concert.city || '').toLowerCase()) continue;
      const score = stringSimilarity(concert.venue, donor.venue);
      if (score > bestScore) { bestScore = score; best = donor; }
    }
    return bestScore >= VENUE_SIMILARITY ? best : null;
  };

  let precise = 0;
  let approximate = 0;
  const unplaced = [];

  for (const concert of missing) {
    const venueDonor = fromVenue(concert);
    const city = cityByKey.get(cityKey(concert.city, concert.country));
    // Only ask setlist.fm when the free passes came up empty, so a run costs one
    // request per venue it could not already place.
    const looked = venueDonor || city ? null : await fromSetlistFm(concert.venue, concert.city);
    const source = venueDonor ?? looked ?? city;

    if (!source) {
      unplaced.push(concert);
      continue;
    }

    const how = venueDonor ? 'venue' : looked ? 'setlist.fm' : 'city centre';
    const day = concert.concert_date?.toISOString().slice(0, 10) ?? '—';
    console.log(`[${concert.id}] ${concert.venue ?? '?'}, ${concert.city ?? '?'} ${day} → ${how}`);

    if (!dryRun) {
      await prisma.concert.update({
        where: { id: concert.id },
        data: {
          latitude: String(source.latitude),
          longitude: String(source.longitude),
          // The city link is worth having whether or not it supplied the
          // coordinates: it is what carries reachability.
          ...(concert.city_id == null && city ? { city_id: city.id } : {}),
        },
      });
    }

    if (venueDonor || looked) precise++; else approximate++;
  }

  for (const concert of unplaced) {
    console.log(`[${concert.id}] no venue or city match — ${concert.venue ?? '?'}, ${concert.city ?? '?'}, ${concert.country ?? '?'}`);
  }

  console.log(
    `\n${dryRun ? 'Would place' : 'Placed'} ${precise + approximate} of ${missing.length}: ` +
    `${precise} from a known venue, ${approximate} at their city centre. ` +
    `${unplaced.length} left without coordinates.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
