const prisma = require("../../prisma/client");
module.exports = {
  addConcert,
  findConcert,
  removeDuplicateEvents,
  addToExistingConcert,
  handleError,
};
async function addConcert({ band, event }) {

  const concert = await prisma.concert.create({
    data: {
      ...event
    },
  });

  // Create the band-concert relationship
  await prisma.concertBandReference.create({
    data: {
      concert: concert.id,
      band: band.id,
    },
  });

  return concert;
}

async function findConcert({ event }) {
  const concert = await prisma.concert.findFirst({
    where: {
      OR: [
        {
          event_id: event.id,
        },
        {
          AND: [
            {
              concert_date: event.concert_date ? new Date(event.concert_date) : null,
            },
            {
              venue: event.venue,
            },
          ],
        },
      ],
    },
  });
  return concert
}

async function addToExistingConcert({ concert, band, event }) {
  const existingBands = await prisma.concertBandReference.findMany({
    where: {
      concert: concert.id,
    },
  });

  if (existingBands.some(b => b.band === band.id)) {
    return;
  }

  await prisma.concertBandReference.create({
    data: {
      concert: concert.id,
      band: band.id,
    },
  });
}
async function removeDuplicateEvents(events) {
  // Deduplicate events by venue and date
  const uniqueEvents = [];
  const seenVenueDates = new Map();

  events.forEach(event => {
    const venue = event._embedded?.venues?.[0]?.name || 'unknown';
    const location = event._embedded?.venues?.[0];
    const performingBands = event._embedded?.attractions?.map(a => a.name) || [];
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
        concert_date: dates.start.dateTime ? new Date(dates.start.dateTime) : null,
        on_sale: dates.status.code === 'onsale',
        created_at: new Date(),
        url: event.url,
        metadata: `${performingBands.join(", ")} performing in ${location.city.name}`
      });
    }
  });

  return uniqueEvents;
}
const errorMessages = {
  events: {
    404: { error: "No events found for this band." },
    429: { error: "Too many requests, please try again later." },
    500: { error: "Internal server error" },
  },
  band: {
    404: { error: "Band not found with that Ticketmaster ID" },
    409: { error: "Band already exists." },
    500: { error: "Internal server error" },
  },
  wishlist: {
    404: { error: "Wishlist not found." },
    500: { error: "Internal server error" },
  },
};

function handleError(module, status) {
  const moduleErrors = errorMessages[module];
  if (moduleErrors && moduleErrors[status]) {
    return moduleErrors[status];
  }
  return { error: "An unknown error occurred." };
}