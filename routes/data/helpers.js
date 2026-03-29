const prisma = require('../../prisma/client');
module.exports = {
  addConcert,
  findConcert,
  removeDuplicateEvents,
  addToExistingConcert,
  handleError,
  checkDuplicateConcert,
  stringSimilarity,
  deduplicateEventsByName,
};
async function addConcert({ band, event }) {
  let concert;
  try {
    concert = await prisma.concert.create({
      data: {
        ...event,
      },
    });
  } catch (e) {
    // Handle race condition / duplicate creation gracefully
    if (e.code === 'P2002' && e.meta?.target?.includes('event_id')) {
      concert = await prisma.concert.findUnique({
        where: { event_id: event.event_id },
      });
      if (!concert) throw e; // If still not found, rethrow
    } else {
      throw e;
    }
  }

  // Create the band-concert relationship if not already existing
  const existingRel = await prisma.concertBandReference.findFirst({
    where: { concert: concert.id, band: band.id },
  });
  if (!existingRel) {
    await prisma.concertBandReference.create({
      data: {
        concert: concert.id,
        band: band.id,
      },
    });
  }

  return concert;
}

async function findConcert({ event }) {
  const concert = await prisma.concert.findFirst({
    where: {
      OR: [
        {
          event_id: event.event_id, // Correct property from transformed event object
        },
        {
          AND: [
            {
              concert_date: event.concert_date
                ? new Date(event.concert_date)
                : null,
            },
            {
              venue: event.venue,
            },
          ],
        },
      ],
    },
  });
  return concert;
}

async function addToExistingConcert({ concert, band, event }) {
  const existingBands = await prisma.concertBandReference.findMany({
    where: {
      concert: concert.id,
    },
  });

  if (existingBands.some((b) => b.band === band.id)) {
    return;
  }

  await prisma.concertBandReference.create({
    data: {
      concert: concert.id,
      band: band.id,
    },
  });
}

async function checkDuplicateConcert({ concert, bandIds, tx }) {
  /**
   * Check for duplicate concerts based on festival status:
   * - For festivals: deduplicate by concert_date + venue + city
   * - For non-festivals: deduplicate by concert_date + venue + band combination
   * 
   * If duplicate found, merge additional bands into existing concert
   * 
   * Returns: { isDuplicate: boolean, existingConcert: concert object or null }
   */
  let existingConcert = null;

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
  } else {
    // For non-festivals, use concert_date + venue + band combination
    if (concert.concert_date && bandIds.length > 0) {
      for (const bandId of bandIds) {
        existingConcert = await tx.concert.findFirst({
          where: {
            concert_date: concert.concert_date
              ? new Date(concert.concert_date)
              : null,
            venue: concert.venue,
            bands: { some: { band: bandId } },
          },
          include: { bands: true },
        });
        if (existingConcert) break;
      }
    }
  }

  // If duplicate found, merge any new bands into existing concert
  if (existingConcert) {
    for (const bandId of bandIds) {
      const existingRef = await tx.concertBandReference.findFirst({
        where: { concert: existingConcert.id, band: bandId },
      });
      if (!existingRef) {
        await tx.concertBandReference.create({
          data: { concert: existingConcert.id, band: bandId },
        });
      }
    }
  }

  return {
    isDuplicate: !!existingConcert,
    existingConcert,
  };
}

async function removeDuplicateEvents(events) {
  // Deduplicate events by venue and date
  const uniqueEvents = [];
  const seenVenueDates = new Map();

  events.forEach((event) => {
    const venue = event._embedded?.venues?.[0]?.name || 'unknown';
    const location = event._embedded?.venues?.[0];
    const performingBands =
      event._embedded?.attractions?.map((a) => a.name) || [];
    const eventDate = event.dates?.start?.dateTime
      ? new Date(event.dates.start.dateTime).toISOString().split('T')[0]
      : 'unknown';
    const dates = event.dates || {};

    const key = `${venue}_${eventDate}`;

    if (!seenVenueDates.has(key)) {
      seenVenueDates.set(key, true);
      uniqueEvents.push({
        country: location.country.name,
        city: location.city.name,
        venue: location.name || 'unknown',
        event_id: event.id,
        longitude: location.location?.longitude || null,
        latitude: location.location?.latitude || null,
        name: event.name,
        festival: performingBands.length > 6,
        ticket_sale_start: new Date(event.sales?.public?.startDateTime),
        concert_date: dates.start.dateTime
          ? new Date(dates.start.dateTime)
          : null,
        on_sale: dates.status.code === 'onsale',
        created_at: new Date(),
        url: event.url,
        metadata: `${performingBands.join(', ')} performing in ${
          location.city.name
        }`,
      });
    }
  });

  return uniqueEvents;
}
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

function handleError(module, status) {
  const moduleErrors = errorMessages[module];
  if (moduleErrors && moduleErrors[status]) {
    return moduleErrors[status];
  }
  return { error: 'An unknown error occurred.' };
}

function stringSimilarity(s1, s2) {
  /**
   * Calculate similarity between two strings using character overlap.
   * Returns 0-1 where 1 is identical.
   */
  if (!s1 || !s2) return 0.0;
  
  const s1Lower = s1.toLowerCase();
  const s2Lower = s2.toLowerCase();
  
  // Count matching characters at same positions
  let matches = 0;
  for (let i = 0; i < Math.min(s1Lower.length, s2Lower.length); i++) {
    if (s1Lower[i] === s2Lower[i]) matches++;
  }
  
  // Normalize by longer string length
  const maxLen = Math.max(s1Lower.length, s2Lower.length);
  return maxLen > 0 ? matches / maxLen : 0.0;
}

function deduplicateEventsByName(concerts, similarityThreshold = 0.25, daysThreshold = 5) {
  /**
   * Remove duplicate concerts based on name similarity AND date proximity.
   * Prefers to keep concerts with "weekend" in the name.
   * 
   * @param {Array} concerts - Array of concert objects to deduplicate
   * @param {Number} similarityThreshold - Name similarity threshold (0-1)
   * @param {Number} daysThreshold - Days threshold for date proximity
   * @returns {Array} Deduplicated concerts
   */
  if (!concerts || concerts.length === 0) return [];
  
  const getEventDate = (concert) => {
    if (concert.concert_date) {
      return new Date(concert.concert_date);
    }
    return null;
  };
  
  const seenIndices = new Set();
  const result = [];
  
  for (let i = 0; i < concerts.length; i++) {
    if (seenIndices.has(i)) continue;
    
    const name1 = (concerts[i].name || '').toLowerCase();
    const isWeekend1 = name1.includes('weekend') || name1.includes('combi');
    const date1 = getEventDate(concerts[i]);
    
    for (let j = i + 1; j < concerts.length; j++) {
      if (seenIndices.has(j)) continue;
      
      const name2 = (concerts[j].name || '').toLowerCase();
      const similarity = stringSimilarity(name1, name2);
      
      if (similarity > similarityThreshold) {
        const date2 = getEventDate(concerts[j]);
        
        // Check date proximity
        if (date1 && date2) {
          const daysDiff = Math.abs(Math.floor((date1 - date2) / (1000 * 60 * 60 * 24)));
          if (daysDiff > daysThreshold) continue;
        } else if (!date1 || !date2) {
          continue; // Can't determine if duplicates without dates
        }
        
        // Prefer weekend events
        const isWeekend2 = name2.includes('weekend') || name2.includes('combi');
        if (isWeekend2 && !isWeekend1) {
          seenIndices.add(i);
          break;
        } else {
          seenIndices.add(j);
        }
      }
    }
    
    if (!seenIndices.has(i)) {
      result.push(concerts[i]);
    }
  }
  
  return result;
}
