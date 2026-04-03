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
   * Check for duplicate concerts using the following priority:
   * 1. Coordinate-based: same coordinates (±0.001°) + within 3 days + >4 bands = festival duplicate
   * 2. For festivals: deduplicate by concert_date + venue + city
   * 3. For non-festivals: deduplicate by concert_date + venue + band combination
   *
   * If duplicate found, merge additional bands into existing concert
   *
   * Returns: { isDuplicate: boolean, existingConcert: concert object or null }
   */
  let existingConcert = null;
  const lat = parseFloat(concert.latitude);
  const lng = parseFloat(concert.longitude);
  if (!isNaN(lat) && !isNaN(lng) && concert.concert_date && concert.festival === true) {
    const concertDate = new Date(concert.concert_date);
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
    const coordTolerance = 0.001;
    existingConcert = await tx.concert.findFirst({
      where: {
        concert_date: {
          gte: new Date(concertDate.getTime() - threeDaysMs),
          lte: new Date(concertDate.getTime() + threeDaysMs),
        },
        latitude: {
          gte: String(lat - coordTolerance),
          lte: String(lat + coordTolerance),
        },
        longitude: {
          gte: String(lng - coordTolerance),
          lte: String(lng + coordTolerance),
        },
      },
      include: { bands: true },
    });
  }
  
  if (!existingConcert) {
    if (concert.festival) {
      // For festivals, check by date + venue + city (looser matching)
      existingConcert = await tx.concert.findFirst({
        where: {
          concert_date: concert.concert_date
            ? new Date(concert.concert_date)
            : null,
          venue: concert.venue,
          city: concert.city,
          festival: true,
        },
        include: { bands: true },
      });
    } 
  } else if (concert.concert_date && bandIds.length > 0){
    existingConcert = await tx.concert.findFirst({
      where: {
        concert_date: new Date(concert.concert_date),
        venue: concert.venue,
        bands: { some: { band: { in: bandIds } } },
      },
      include: { bands: true },
    });
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

