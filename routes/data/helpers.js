const prisma = require('../../prisma/client');
const axios = require('axios');

const ticketmasterURL = 'https://app.ticketmaster.com/discovery/v2/';

const errorMessages = {
  events: {
    404: { error: 'No events found for this band.' },
    429: { error: 'Too many requests, please try again later.' },
    500: { error: 'Internal server error' },
  },
  band: {
    404: { error: 'Band not found with that Ticketmaster ID' },
    409: { error: 'Band already exists.' },
    500: { error: 'Internal server error' },
  },
  wishlist: {
    404: { error: 'Wishlist not found.' },
    500: { error: 'Internal server error' },
  },
};

module.exports = {
  handleError,
  checkDuplicateConcert,
  getTicketmasterId
};

// Normalize a date to midnight UTC on its calendar day
function toUtcDay(date) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// Bigram Dice coefficient — returns 0.0–1.0. Unicode-safe: keeps all letters/numbers.
function stringSimilarity(a, b) {
  const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const na = norm(a), nb = norm(b);
  if (na === nb) return 1;
  if (!na || !nb) return 0;
  const bigrams = (s) => Array.from({ length: Math.max(s.length - 1, 0) }, (_, i) => s.slice(i, i + 2));
  const ba = bigrams(na), bb = bigrams(nb);
  if (!ba.length || !bb.length) return 0;
  const bbCount = new Map();
  for (const g of bb) bbCount.set(g, (bbCount.get(g) || 0) + 1);
  let matches = 0;
  for (const g of ba) if (bbCount.get(g) > 0) { matches++; bbCount.set(g, bbCount.get(g) - 1); }
  return (2 * matches) / (ba.length + bb.length);
}

async function checkDuplicateConcert({ concert, bandIds, tx }) {
  /**
   * Duplicate detection rules:
   * 1. Venue similarity ≥ 70% within date window
   * 2. City similarity ≥ 70% within date window
   * 3. Any incoming band already linked to a concert in the same city on the same day
   *
   * Date window:
   * - Always fetch 7 days around the incoming date.
   * - A candidate is eligible if EITHER the incoming or the existing event has 3+ bands
   *   (festival/multi-band), OR both are within ±1.5 days of each other.
   *
   * When merging, the concert with more bands wins: its date, metadata, and URL become
   * the canonical record. The loser's bands are merged in.
   */
  let existingConcert = null;

  if (concert.concert_date) {
    const dayStart = toUtcDay(concert.concert_date);
    const oneDayMs = 24 * 60 * 60 * 1000;
    const incomingIsMultiBand = concert.festival || bandIds.length >= 3;

    // Always fetch 7 days — we filter per-candidate below
    const candidates = await tx.concert.findMany({
      where: {
        concert_date: {
          gte: new Date(dayStart.getTime() - 7 * oneDayMs),
          lte: new Date(dayStart.getTime() + 7 * oneDayMs),
        },
      },
      include: { bands: true },
    });

    const diffDays = (c) => Math.abs(toUtcDay(c.concert_date).getTime() - dayStart.getTime()) / oneDayMs;
    const isMultiBand = (c) => c.festival || c.bands.length >= 3;
    const sharesABand = (c) => c.bands.some((ref) => bandIds.includes(ref.band));

    // 1. Venue fuzzy match — within 1.5 days always; within 7 days if multi-band or shares a band
    if (concert.venue) {
      const venueMatches = candidates
        .filter((c) => c.venue)
        .map((c) => ({ c, sim: stringSimilarity(concert.venue, c.venue) }))
        .filter(({ c, sim }) => {
          if (sim < 0.7) return false;
          const d = diffDays(c);
          return d <= 1.5 || incomingIsMultiBand || isMultiBand(c) || sharesABand(c);
        })
        .filter(({ c }) => diffDays(c) <= 7)
        .sort((a, b) => b.c.bands.length - a.c.bands.length || b.sim - a.sim);
      existingConcert = venueMatches[0]?.c ?? null;
    }

    // 2. City fuzzy match fallback — only within 1.5 days or multi-band window
    if (!existingConcert && concert.city) {
      const cityMatches = candidates
        .filter((c) => {
          const d = diffDays(c);
          return d <= (incomingIsMultiBand || isMultiBand(c) ? 7 : 1.5);
        })
        .filter((c) => c.city)
        .map((c) => ({ c, sim: stringSimilarity(concert.city, c.city) }))
        .filter(({ sim }) => sim >= 0.7)
        .sort((a, b) => b.c.bands.length - a.c.bands.length || b.sim - a.sim);
      existingConcert = cityMatches[0]?.c ?? null;
    }

    // 3. Band-schedule conflict — a band can't play two events in the same city on the same day.
    //    Use ±1.5 day window regardless of multi-band status.
    if (!existingConcert && concert.city && bandIds.length > 0) {
      const cityNorm = concert.city.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      for (const c of candidates) {
        if (diffDays(c) > 1.5 || !c.city) continue;
        const cNorm = c.city.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
        if (stringSimilarity(cityNorm, cNorm) < 0.7) continue;
        if (sharesABand(c)) { existingConcert = c; break; }
      }
    }
  }

  if (existingConcert) {
    // The concert with more bands wins — its date/metadata become canonical
    const incomingWins = bandIds.length > existingConcert.bands.length;

    const existingIsAtFormat = (existingConcert.name || '').includes(' @ ');
    const incomingIsAtFormat = (concert.name || '').includes(' @ ');
    const bestName = (concert.name && existingIsAtFormat && !incomingIsAtFormat)
      ? concert.name
      : concert.name || existingConcert.name;
    const hasBetterName = bestName !== existingConcert.name;

    if (incomingWins || hasBetterName) {
      await tx.concert.update({
        where: { id: existingConcert.id },
        data: {
          name: bestName,
          ...(incomingWins && {
            concert_date: concert.concert_date ? new Date(concert.concert_date) : existingConcert.concert_date,
            url: concert.url || existingConcert.url,
            metadata: concert.metadata || existingConcert.metadata,
            on_sale: concert.on_sale !== undefined ? concert.on_sale : existingConcert.on_sale,
            ticket_sale_start: concert.ticket_sale_start ? new Date(concert.ticket_sale_start) : existingConcert.ticket_sale_start,
            festival: concert.festival || existingConcert.festival,
          }),
        },
      });
    }

    const existingRefs = await tx.concertBandReference.findMany({
      where: { concert: existingConcert.id, band: { in: bandIds } },
      select: { band: true },
    });
    const linkedBandIds = new Set(existingRefs.map((r) => r.band));
    const toLink = bandIds.filter((id) => !linkedBandIds.has(id));
    if (toLink.length > 0) {
      await tx.concertBandReference.createMany({
        data: toLink.map((band) => ({ concert: existingConcert.id, band })),
      });
    }
  }

  return { isDuplicate: !!existingConcert, existingConcert };
}

function handleError(module, status) {
  const moduleErrors = errorMessages[module];
  if (moduleErrors && moduleErrors[status]) {
    return moduleErrors[status];
  }
  return { error: 'An unknown error occurred.' };
}

async function getTicketmasterId(bandIdentifier) {
  // If identifier looks like a Ticketmaster ID (numeric), check DB first
  if (bandIdentifier && /^\d+$/.test(bandIdentifier)) {
    const band = await prisma.band.findUnique({
      where: { ticketmaster_id: bandIdentifier },
      select: { ticketmaster_id: true },
    });
    if (band) return band.ticketmaster_id;
    
    // If not in DB but looks like valid TM ID, return it (it's probably valid)
    return bandIdentifier;
  }
  
  // Try finding by name in DB
  const band = await prisma.band.findUnique({
    where: { name: bandIdentifier },
    select: { ticketmaster_id: true },
  });
  if (band?.ticketmaster_id) return band.ticketmaster_id;
  
  // Fall back to API search to get the Ticketmaster ID
  try {
    const response = await axios.get(`${ticketmasterURL}attractions.json`, {
      params: {
        apikey: process.env.TICKETMASTER_KEY,
        keyword: bandIdentifier,
        size: 1,
      },
    });

    if (response.data._embedded?.attractions?.[0]?.id) {
      return response.data._embedded.attractions[0].id;
    }
    
    throw new Error('Band not found on Ticketmaster');
  } catch (error) {
    if (error.response?.status === 429) {
      throw new Error('Rate limited by Ticketmaster API');
    }
    throw new Error(`Could not find Ticketmaster ID for band "${bandIdentifier}"`);
  }
}

