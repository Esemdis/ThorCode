const prisma = require("../../prisma/client");

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

module.exports = {
  addConcert,
  findConcert,
  addToExistingConcert,
};