const express = require("express");
const router = express.Router();
const { validationResult, param, body } = require("express-validator");
const axios = require("axios");
const { addConcert, findConcert, addToExistingConcert } = require("./helpers");

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const { rateLimiter } = require("../../utils/rateLimiter");
// Defaults to 5 requests per 15 minutes per IP
const ticketmasterURL = "https://app.ticketmaster.com/discovery/v2/";
const rateLimit = rateLimiter({
  message: "Too many requests to the Ticketmaster data route, please try again later.",
});
const countries = [
  { name: "Germany", iso: "DE" },
  { name: "Austria", iso: "AT" },
  { name: "Netherlands", iso: "NL" },
  { name: "Denmark", iso: "DK" },
  { name: "Belgium", iso: "BE" },
  { name: "Norway", iso: "NO" },
  { name: "Switzerland", iso: "CH" },
  { name: "Spain", iso: "ES" },
  { name: "Sweden", iso: "SE" },
  { name: "Finland", iso: "FI" },
  { name: "Poland", iso: "PL" },
  { name: "United Kingdom", iso: "GB" }
]
const prisma = require("../../prisma/client");
// List all bands in the DB
router.get("/bands", async (req, res) => {
  try {
    const bands = await prisma.band.findMany({
      select: {
        id: true,
        name: true,
      },
    });
    res.json(bands);
  } catch (error) {
    console.error("Error fetching bands:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post(
  "/bands",
  rateLimit,
  auth,
  body("name").isString().notEmpty().withMessage("Band name is required"),
  body("wishlistId").optional().isInt().withMessage("Wishlist ID must be an integer"),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const bandName = req.body.name;
      const band = await prisma.band.findUnique({
        where: { name: bandName },
        select: { name: true },
      });

      if (band) {
        return res.status(409).json({ error: "Band already exists." });
      }

      // Fetch events from Ticketmaster API
      const response = await axios.get(`${ticketmasterURL}events.json`, {
        params: {
          countryCode: countries.map(country => country.iso),
          apikey: process.env.TICKETMASTER_KEY,
          keyword: bandName,
        },
      });

      if (response.status !== 200) {
        return res.status(500).json({ error: "Failed to fetch data from Ticketmaster." });
      }

      if (!response.data._embedded || !response.data._embedded.events || response.data._embedded.events.length === 0) {
        return res.status(404).json({ error: "No events found for this band." });
      }

      // Deduplicate events by venue and date
      const uniqueEvents = [];
      const seenVenueDates = new Map();

      response.data._embedded.events.forEach(event => {
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
            ticket_sale_start: new Date(event.sales?.public?.startDateTime),
            concert_date: dates.start.dateTime ? new Date(dates.start.dateTime) : null,
            on_sale: dates.status.code === 'onsale',
            created_at: new Date(),
            url: event.url,
            metadata: `${performingBands[0]} in ${location.city.name} performing with ${performingBands.join(", ")}`
          });
        }
      });

      // Save band to the database
      const newBand = await prisma.band.create({
        data: {
          name: bandName,
          ticketmaster_id: response?.data?._embedded.events[0].id,
        },
      });

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

      if (req.body.wishlistId) {
        await prisma.wishlistBandReference.create({
          data: {
            wishlist_id: req.body.wishlistId,
            band_id: newBand.id
          }
        });
      }

      res.json(response.data);
    } catch (error) {
      console.error("Error fetching Ticketmaster data:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);
router.post(
  "/wishlist",
  [
    auth,
    roleCheck(["ADMIN"]),
    body("name").isString().notEmpty().withMessage("Wishlist name is required"),
    body("bandIds").isArray().withMessage("Band IDs must be an array").optional(),
  ],
  rateLimit,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const wishlistName = req.body.name;
      const existingWishlist = await prisma.wishlist.findFirst({
        where: {
          name: wishlistName,
          user_id: req.user.id  // Changed from user_rel to user_id
        },
      });

      if (existingWishlist) {
        return res.status(409).json({ error: "Wishlist already exists." });
      }

      // Create the new wishlist
      const newWishlist = await prisma.wishlist.create({
        data: {
          name: wishlistName,
          user_id: req.user.id,
        },
      });

      // Add bands to the wishlist
      if (req.body.bandIds && req.body.bandIds.length > 0) {
        await prisma.wishlistBandReference.createMany({
          data: req.body.bandIds.map(bandId => ({
            wishlist_id: newWishlist.id,
            band_id: bandId,
          })),
        },
        );
      }

      res.json(newWishlist);
    } catch (error) {
      console.error("Error fetching Ticketmaster data:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);
router.patch(
  "/wishlist/:id",
  [
    auth,
    roleCheck(["ADMIN"]),
    param("id").isInt().withMessage("Wishlist ID must be an integer"),
    body("bandIds").isArray().withMessage("Band IDs must be an array"),
  ],
  rateLimit,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const wishlistId = parseInt(req.params.id, 10);
      const existingWishlist = await prisma.wishlist.findUnique({
        where: { id: wishlistId },
      });

      if (!existingWishlist) {
        return res.status(404).json({ error: "Wishlist not found." });
      }

      // First, validate that all band IDs exist in the database
      if (req.body.bandIds && req.body.bandIds.length > 0) {
        const existingBands = await prisma.band.findMany({
          where: {
            id: {
              in: req.body.bandIds
            }
          },
          select: { id: true }
        });

        const existingBandIds = existingBands.map(band => band.id);
        const invalidBandIds = req.body.bandIds.filter(id => !existingBandIds.includes(id));

        if (invalidBandIds.length > 0) {
          return res.status(400).json({
            error: "Some band IDs don't exist",
            invalidBandIds
          });
        }
      }

      // Delete existing references
      await prisma.wishlistBandReference.deleteMany({
        where: {
          wishlist_id: wishlistId
        }
      });

      // Create new references with validated band IDs
      if (req.body.bandIds && req.body.bandIds.length > 0) {
        await prisma.wishlistBandReference.createMany({
          data: req.body.bandIds.map(bandId => ({
            wishlist_id: wishlistId,
            band_id: bandId,
          })),
        });
      }

      // Get the updated wishlist with bands
      const updatedWishlist = await prisma.wishlist.findUnique({
        where: { id: wishlistId },
        include: {
          bands: {
            include: {
              band_rel: true
            }
          }
        }
      });

      res.json(updatedWishlist);
    } catch (error) {
      console.error("Error updating wishlist:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);
router.get(
  "/wishlists",
  [
    auth,
    roleCheck(["ADMIN"]),
  ],
  rateLimit,
  async (req, res) => {
    try {
      const wishlists = await prisma.wishlist.findMany({
        where: { user_id: req.user.id },
        include: { bands: true },
      });
      res.json(wishlists);
    } catch (error) {
      console.error("Error fetching wishlists:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);
router.get("/wishlist/:id",
  [
    // auth,
    // roleCheck(["ADMIN"]),
    param("id").isInt().withMessage("Wishlist ID must be an integer"),
  ],
  rateLimit,
  async (req, res) => {
    try {
      const wishlistId = parseInt(req.params.id, 10);

      // Get the wishlist with band references
      const wishlist = await prisma.wishlist.findUnique({
        where: { id: wishlistId },
        include: {
          bands: {
            include: {
              band_rel: true
            }
          }
        }
      });

      if (!wishlist) {
        return res.status(404).json({ error: "Wishlist not found." });
      }

      // Get band IDs from the wishlist
      const bandIds = wishlist.bands.map(ref => ref.band_id);

      // Get bands with all their concerts and details
      const bandsWithConcerts = await prisma.band.findMany({
        where: {
          id: { in: bandIds }
        },
        select: {
          id: true,
          name: true,
          concerts: {
            include: {
              concert_rel: {
                select: {
                  id: true,
                  name: true,
                  metadata: true,
                  country: true,
                  city: true,
                  venue: true,
                  longitude: true,
                  latitude: true,
                  concert_date: true,
                  url: true,
                  bands: {
                    include: {
                      band_rel: {
                        select: {
                          name: true,
                          id: true
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      });

      // Format the response with detailed concert information
      const formattedBands = bandsWithConcerts.map(band => {
        const concertsList = band.concerts.map(concertRef => {
          const concert = concertRef.concert_rel;
          return {
            id: concert.id,
            name: concert.name,
            metadata: concert.metadata,
            country: concert.country,
            city: concert.city,
            venue: concert.venue,
            longitude: concert.longitude,
            latitude: concert.latitude,
            concert_date: concert.concert_date,
            url: concert.url,
            participating_bands: concert.bands.map(b => ({
              id: b.band_rel.id,
              name: b.band_rel.name
            }))
          };
        });

        return {
          id: band.id,
          name: band.name,
          concerts: concertsList,
          concertCount: concertsList.length
        };
      });

      // Return the enhanced wishlist with detailed concert information
      res.json({
        id: wishlist.id,
        name: wishlist.name,
        user_id: wishlist.user_id,
        bands: formattedBands
      });
    } catch (error) {
      console.error("Error fetching wishlist:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);
router.delete(
  "/wishlist/:id",
  [
    auth,
    roleCheck(["ADMIN"]),
    param("id").isInt().withMessage("Wishlist ID must be an integer"),
  ],
  rateLimit,
  async (req, res) => {
    try {
      const wishlistId = parseInt(req.params.id, 10);
      const existingWishlist = await prisma.wishlist.findUnique({
        where: { id: wishlistId },
      });

      if (!existingWishlist) {
        return res.status(404).json({ error: "Wishlist not found." });
      }

      // Delete the wishlist
      await prisma.wishlist.delete({
        where: { id: wishlistId },
      });

      res.json({ message: "Wishlist deleted successfully." });
    } catch (error) {
      console.error("Error deleting wishlist:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

module.exports = router;
