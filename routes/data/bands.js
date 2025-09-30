const express = require('express');
const router = express.Router();
const { validationResult, body, query } = require('express-validator');
const axios = require('axios');
const {
  addConcert,
  findConcert,
  addToExistingConcert,
  removeDuplicateEvents,
  handleError,
} = require('./helpers');

const auth = require('../../auth/verifyJWT');
const roleCheck = require('../../middlewares/roleCheck');
const { rateLimiter } = require('../../utils/rateLimiter');
const prisma = require('../../prisma/client');

// Defaults to 5 requests per 15 minutes per IP
const ticketmasterURL = 'https://app.ticketmaster.com/discovery/v2/';
const rateLimit = rateLimiter({
  message:
    'Too many requests to the Ticketmaster data route, please try again later.',
});
const countries = [
  { name: 'Germany', iso: 'DE' },
  { name: 'Austria', iso: 'AT' },
  { name: 'Netherlands', iso: 'NL' },
  { name: 'Denmark', iso: 'DK' },
  { name: 'Belgium', iso: 'BE' },
  { name: 'Norway', iso: 'NO' },
  { name: 'Switzerland', iso: 'CH' },
  { name: 'Spain', iso: 'ES' },
  { name: 'Sweden', iso: 'SE' },
  { name: 'Finland', iso: 'FI' },
  { name: 'Poland', iso: 'PL' },
  { name: 'United Kingdom', iso: 'GB' },
];

// Search bands by name for autocomplete
router.get('/bands/search', async (req, res) => {
  try {
    const { q, limit = 10 } = req.query;

    if (!q || q.trim().length < 2) {
      return res.json([]);
    }

    const searchTerm = q.trim();

    const bands = await prisma.band.findMany({
      where: {
        name: {
          contains: searchTerm,
          mode: 'insensitive',
        },
      },
      select: {
        id: true,
        name: true,
      },
      orderBy: [
        {
          name: 'asc',
        },
      ],
      take: parseInt(limit, 10),
    });

    // Sort results to prioritize matches that start with the search term
    const sortedBands = bands.sort((a, b) => {
      const aStartsWith = a.name
        .toLowerCase()
        .startsWith(searchTerm.toLowerCase());
      const bStartsWith = b.name
        .toLowerCase()
        .startsWith(searchTerm.toLowerCase());

      if (aStartsWith && !bStartsWith) return -1;
      if (!aStartsWith && bStartsWith) return 1;
      return a.name.localeCompare(b.name);
    });

    res.json(sortedBands);
  } catch (error) {
    console.error('Error searching bands:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// List all bands with concert counts (number of ConcertBandReferences)
router.get('/bands', async (req, res) => {
  try {
    const bands = await prisma.band.findMany({
      select: {
        id: true,
        name: true,
        _count: { select: { concerts: true } }, // concerts relation name in Band model
      },
      orderBy: { name: 'asc' },
    });

    const mapped = bands.map((b) => ({
      id: b.id,
      name: b.name,
      concertCount: b._count.concerts,
    }));

    // Enrich with next upcoming concert (date & country)
    const now = new Date();
    await Promise.all(
      mapped.map(async (b) => {
        try {
          const next = await prisma.concert.findFirst({
            where: {
              concert_date: { gte: now },
              bands: { some: { band: b.id } }, // concerts having this band
            },
            select: { concert_date: true, country: true },
            orderBy: { concert_date: 'asc' },
          });
          if (next) {
            b.nextConcertDate = next.concert_date; // raw Date; frontend can format
            b.nextConcertCountry = next.country;
          } else {
            b.nextConcertDate = null;
            b.nextConcertCountry = null;
          }
        } catch (e) {
          // On error, fail gracefully for that band only
          b.nextConcertDate = null;
          b.nextConcertCountry = null;
        }
      }),
    );

    res.json(mapped);
  } catch (error) {
    console.error('Error fetching bands:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post(
  '/bands/:bandId/sync-concerts',
  rateLimit,
  auth,
  roleCheck(['ADMIN', 'SYSTEM']),
  async (req, res) => {
    const { bandId } = req.params;
    try {
      // Fetch the band from the database
      const band = await prisma.band.findUnique({
        where: { id: parseInt(bandId) },
      });

      if (!band) {
        return res.status(404).json({ error: 'Band not found' });
      }
      let newConcerts = 0;

      // Fetch concerts from Ticketmaster API using the correct endpoint
      const eventParams = {
        countryCode: countries.map((country) => country.iso),
        apikey: process.env.TICKETMASTER_KEY,
        attractionId: band.ticketmaster_id,
      };

      const response = await axios.get(`${ticketmasterURL}events.json`, {
        params: eventParams,
      });

      if (
        !response.data._embedded ||
        !response.data._embedded.events ||
        response.data._embedded.events.length === 0
      ) {
        return res
          .status(200)
          .json({ error: 'No events found for this band.' });
      }

      const events = response.data._embedded.events;

      const uniqueEvents = await removeDuplicateEvents(events);

      for (const event of uniqueEvents) {
        const existingConcert = await findConcert({ event });
        if (!existingConcert) {
          await addConcert({ band, event });
          newConcerts++;
        } else {
          await addToExistingConcert({
            concert: existingConcert,
            band,
            event,
          });
        }
      }

      res.status(200).json({
        message:
          `Concerts for ${band.name} synced successfully` +
          (newConcerts ? ` (${newConcerts} new)` : ''),
        newConcerts,
        band: { id: band.id, name: band.name },
      });
    } catch (error) {
      if (error.response?.status === 404) {
        return res
          .status(404)
          .json({ error: 'No events found for this band.' });
      } else if (error.response?.status === 429) {
        return res
          .status(429)
          .json({ error: 'Too many requests, please try again later.' });
      }
      console.error('Error syncing concerts:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.post(
  '/bands',
  rateLimit,
  auth,
  roleCheck(['ADMIN']),
  body('name')
    .optional()
    .isString()
    .notEmpty()
    .withMessage('Band name must be a non-empty string'),
  body('ticketmaster_id')
    .optional()
    .isString()
    .notEmpty()
    .withMessage('Ticketmaster ID must be a non-empty string'),
  body('wishlistId')
    .optional()
    .isInt()
    .withMessage('Wishlist ID must be an integer'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, ticketmaster_id, wishlistId } = req.body;

      // Validate that either name or ticketmaster_id is provided
      if (!name && !ticketmaster_id) {
        return res.status(400).json({
          error: "Either 'name' or 'ticketmaster_id' must be provided",
        });
      }

      const bandName = name ? name.trim() : null;
      const ticketmasterId = ticketmaster_id ? ticketmaster_id.trim() : null;

      // Check if band already exists in the database
      let band = null;

      if (ticketmasterId) {
        band = await prisma.band.findUnique({
          where: { ticketmaster_id: ticketmasterId },
          select: { name: true },
        });
      } else if (bandName) {
        band = await prisma.band.findUnique({
          where: { name: bandName },
          select: { name: true },
        });
      }

      if (band) {
        return res.status(409).json({ error: 'Band already exists.' });
      }

      let foundBand;
      try {
        if (ticketmasterId) {
          // Fetch band data by Ticketmaster ID
          foundBand = await axios.get(
            `${ticketmasterURL}attractions/${ticketmasterId}.json`,
            {
              params: {
                apikey: process.env.TICKETMASTER_KEY,
              },
            },
          );

          if (!foundBand.data) {
            return res
              .status(404)
              .json({ error: 'Band not found with that Ticketmaster ID' });
          }

          // For ID-based search, the response structure is different
          foundBand.data._embedded = { attractions: [foundBand.data] };
        } else {
          // Fetch band data from Ticketmaster API by name
          foundBand = await axios.get(`${ticketmasterURL}attractions.json`, {
            params: {
              apikey: process.env.TICKETMASTER_KEY,
              keyword: bandName,
            },
          });

          if (foundBand.data._embedded.attractions.length === 0) {
            return res.status(404).json({ error: 'No band found.' });
          }
        }
      } catch (error) {
        if (error.status === 404) {
          return res
            .status(404)
            .json({ error: 'No events found for this band.' });
        } else if (error.response && error.response.status === 429) {
          return res
            .status(429)
            .json({ error: 'Too many requests, please try again later.' });
        }
        console.error('Error fetching events from Ticketmaster:', error);
        return res.status(500).json({ error: 'Internal server error' });
      }

      const bandData = foundBand.data._embedded.attractions[0];

      // Save band to the database
      const newBand = await prisma.band.create({
        data: {
          name: bandData.name,
          ticketmaster_id: bandData.id,
        },
      });

      let events;
      // Fetch events from Ticketmaster API
      try {
        const eventParams = {
          countryCode: countries.map((country) => country.iso),
          apikey: process.env.TICKETMASTER_KEY,
        };

        // Use attractionId if we have a ticketmaster_id, otherwise use keyword
        if (ticketmasterId) {
          eventParams.attractionId = bandData.id;
        } else {
          eventParams.keyword = bandData.name;
        }

        events = await axios.get(`${ticketmasterURL}events.json`, {
          params: eventParams,
        });
      } catch (error) {
        const payload = handleError('events', error.status || 500);
        return res.status(error.status || 500).json(payload);
      }

      if (events.status !== 200) {
        const payload = handleError('events', events.status);
        return res.status(events.status).json(payload);
      }

      if (
        !events.data._embedded ||
        !events.data._embedded.events ||
        events.data._embedded.events.length === 0
      ) {
        const payload = handleError('events', 404);
        return res.status(404).json(payload);
      }

      const uniqueEvents = await removeDuplicateEvents(
        events.data._embedded.events,
      );

      for (const event of uniqueEvents) {
        const existingConcert = await findConcert({ event });
        if (!existingConcert) {
          await addConcert({ band: newBand, event });
        } else {
          await addToExistingConcert({
            concert: existingConcert,
            band: newBand,
            event,
          });
        }
      }

      if (wishlistId) {
        await prisma.wishlistBandReference.create({
          data: {
            wishlist_id: wishlistId,
            band_id: newBand.id,
          },
        });
      }

      res.json({
        id: newBand.id,
        name: newBand.name,
        ticketmaster_id: newBand.ticketmaster_id,
        concerts: uniqueEvents.map((event) => ({
          name: event.name,
          concert_date: event.concert_date
            ? new Date(event.concert_date).toLocaleString('en-GB', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                timeZone: 'Europe/Stockholm',
              })
            : '',
          venue: event.venue,
          city: event.city,
          country: event.country,
          url: event.url,
          on_sale: event.on_sale,
          id: event.id,
        })),
      });
    } catch (error) {
      console.error('Error fetching Ticketmaster data:', error);
      const payload = handleError('events', 500);
      return res.status(500).json(payload);
    }
  },
);

// Delete a band and all related references; remove orphan concerts
router.delete(
  '/bands/:bandId',
  auth,
  roleCheck(['ADMIN']),
  async (req, res) => {
    try {
      const bandId = parseInt(req.params.bandId, 10);
      if (Number.isNaN(bandId)) {
        return res.status(400).json({ error: 'Invalid band id' });
      }

      // Fetch band & related concert references first
      const band = await prisma.band.findUnique({
        where: { id: bandId },
        include: { concerts: { select: { concert: true } } },
      });

      if (!band) {
        return res.status(404).json({ error: 'Band not found' });
      }

      const concertIds = band.concerts.map((r) => r.concert);

      const result = await prisma.$transaction(async (tx) => {
        const wishlistRefsDeleted = await tx.wishlistBandReference.deleteMany({
          where: { band_id: bandId },
        });

        const concertRefsDeleted = await tx.concertBandReference.deleteMany({
          where: { band: bandId },
        });

        // Delete the band itself
        await tx.band.delete({ where: { id: bandId } });

        let orphanConcertIds = [];
        if (concertIds.length) {
          // Find concerts that now have zero bands
          const orphans = await tx.concert.findMany({
            where: {
              id: { in: concertIds },
              bands: { none: {} },
            },
            select: { id: true },
          });
          orphanConcertIds = orphans.map((c) => c.id);
          if (orphanConcertIds.length) {
            await tx.concert.deleteMany({
              where: { id: { in: orphanConcertIds } },
            });
          }
        }

        return {
          deletedBandId: bandId,
          removedWishlistReferences: wishlistRefsDeleted.count,
          removedConcertReferences: concertRefsDeleted.count,
          removedConcerts: orphanConcertIds,
        };
      });

      res.json(result);
    } catch (error) {
      console.error('Error deleting band:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Search bands on Ticketmaster to get their IDs (helpful for disambiguation)
router.get('/bands/ticketmaster-search', async (req, res) => {
  try {
    const { q, limit = 10 } = req.query;

    if (!q || q.trim().length < 2) {
      return res.json([]);
    }

    const searchTerm = q.trim();

    try {
      const response = await axios.get(`${ticketmasterURL}attractions.json`, {
        params: {
          apikey: process.env.TICKETMASTER_KEY,
          keyword: searchTerm,
          size: Math.min(parseInt(limit, 10), 20), // Cap at 20 for API limits
        },
      });

      if (!response.data._embedded || !response.data._embedded.attractions) {
        return res.json([]);
      }

      const bands = response.data._embedded.attractions.map((attraction) => ({
        id: attraction.id,
        name: attraction.name,
        url: attraction.url || null,
        // Include image if available
        image:
          attraction.images && attraction.images.length > 0
            ? attraction.images[0].url
            : null,
        // Include genre if available
        classifications: attraction.classifications
          ? attraction.classifications
              .map((c) => ({
                genre: c.genre?.name || null,
                subGenre: c.subGenre?.name || null,
              }))
              .filter((c) => c.genre || c.subGenre)
          : [],
      }));

      res.json(bands);
    } catch (error) {
      if (error.response?.status === 404) {
        return res.json([]);
      } else if (error.response?.status === 429) {
        const payload = handleError('wishlist', 429);
        return res.status(429).json(payload);
      }
      console.error('Error searching Ticketmaster:', error);
      const payload = handleError('wishlist', 500);
      return res.status(500).json(payload);
    }
  } catch (error) {
    console.error('Error in Ticketmaster search:', error);
    const payload = handleError('wishlist', 500);
    return res.status(500).json(payload);
  }
});

module.exports = router;
