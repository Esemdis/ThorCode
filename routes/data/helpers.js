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

async function checkDuplicateConcert({ concert, bandIds, tx }) {
  /**
   * A concert is a duplicate if ANY of the following are true (date = same day ±12h):
   * 1. Same venue + same day
   * 2. Same city + same day
   *
   * If duplicate found, merge additional bands into existing concert.
   * Returns: { isDuplicate: boolean, existingConcert: concert object or null }
   */
  let existingConcert = null;

  if (concert.concert_date) {
    const concertDate = new Date(concert.concert_date);
    const halfDayMs = 12 * 60 * 60 * 1000;
    const dateRange = {
      gte: new Date(concertDate.getTime() - halfDayMs),
      lte: new Date(concertDate.getTime() + halfDayMs),
    };

    // 1. Same venue + same day
    if (concert.venue) {
      existingConcert = await tx.concert.findFirst({
        where: {
          concert_date: dateRange,
          venue: { equals: concert.venue, mode: 'insensitive' },
        },
        include: { bands: true },
      });
    }

    // 2. Same city + same day
    if (!existingConcert && concert.city) {
      existingConcert = await tx.concert.findFirst({
        where: {
          concert_date: dateRange,
          city: { equals: concert.city, mode: 'insensitive' },
        },
        include: { bands: true },
      });
    }
  }

  

  // If duplicate found, merge any new bands into existing concert
  if (existingConcert) {
    // If the incoming concert has more bands, update the existing record's
    // details to reflect the fuller (likely weekend) ticket
    if (bandIds.length > existingConcert.bands.length) {
      await tx.concert.update({
        where: { id: existingConcert.id },
        data: {
          name: concert.name || existingConcert.name,
          url: concert.url || existingConcert.url,
          metadata: concert.metadata || existingConcert.metadata,
          concert_date: concert.concert_date
            ? new Date(concert.concert_date)
            : existingConcert.concert_date,
          on_sale: concert.on_sale !== undefined ? concert.on_sale : existingConcert.on_sale,
          ticket_sale_start: concert.ticket_sale_start
            ? new Date(concert.ticket_sale_start)
            : existingConcert.ticket_sale_start,
          festival: concert.festival || existingConcert.festival,
        },
      });
    }

    // Fetch all existing refs in one query, then batch create missing ones
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

  return {
    isDuplicate: !!existingConcert,
    existingConcert,
  };
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

