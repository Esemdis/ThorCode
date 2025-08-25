const express = require("express");
const router = express.Router();
const { validationResult, param, body } = require("express-validator");
const axios = require("axios");
const { addConcert, findConcert, addToExistingConcert, removeDuplicateEvents, handleError } = require("./helpers");

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const { rateLimiter } = require("../../utils/rateLimiter");
const prisma = require("../../prisma/client");

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
  { name: "United Kingdom", iso: "GB" },
];

router.get(
  "/wishlists",
  [auth, roleCheck(["ADMIN"])],
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
      const payload = handleError("wishlist", 500);
      return res.status(500).json(payload);
    }
  }
);

router.get(
  "/wishlists/:id",
  [auth, roleCheck(["ADMIN"]), param("id").isInt().withMessage("Wishlist ID must be an integer")],
  async (req, res) => {
    try {
      const wishlistId = parseInt(req.params.id, 10);

      // Get date range filter parameters
      const { start_date, end_date, countries } = req.query;

      // Get the wishlist with band references
      const wishlist = await prisma.wishlist.findUnique({
        where: { id: wishlistId },
        include: {
          bands: {
            include: {
              band_rel: true,
            },
          },
        },
      });

      if (!wishlist) {
        const payload = handleError("wishlist", 404);
        return res.status(404).json(payload);
      }

      // Get band IDs from the wishlist
      const bandIds = wishlist.bands.map((ref) => ref.band_id);

      // Get bands with all their concerts and details
      const bandsWithConcerts = await prisma.band.findMany({
        where: {
          id: { in: bandIds },
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
                  festival: true,
                  url: true,
                  bands: {
                    include: {
                      band_rel: {
                        select: {
                          name: true,
                          id: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });

      // Format the response with detailed concert information
      const formattedBands = bandsWithConcerts.map((band) => {
        // First, create a map to store unique concerts by ID
        const concertsMap = new Map();

        band.concerts.forEach((concertRef) => {
          const concert = concertRef.concert_rel;
          const eventId = concert.id;

          // Apply date range filtering
          if (start_date && end_date) {
            const concertDate = new Date(concert.concert_date);
            const startDate = new Date(start_date);
            const endDate = new Date(end_date);

            // Skip if concert is outside the date range
            if (concertDate < startDate || concertDate > endDate) {
              return;
            }
          }

          // Apply country filtering if provided
          if (countries) {
            const countryList = countries.split(",");
            if (!countryList.includes(concert.country)) {
              return;
            }
          }

          if (!concertsMap.has(eventId)) {
            const wishlistBands = concert.bands
              .map((b) => ({
                id: b.band_rel.id,
                name: b.band_rel.name,
              }))
              .filter((band) => bandIds.includes(band.id)); // Only include bands that are in the wishlist

            concertsMap.set(eventId, {
              id: concert.id,
              name: concert.name,
              metadata: concert.metadata,
              country: concert.country,
              city: concert.city,
              venue: concert.venue,
              longitude: concert.longitude,
              latitude: concert.latitude,
              concert_date: concert.concert_date,
              festival: concert.festival,
              url: concert.url,
              participating_bands: wishlistBands,
              wishlist_band_count: wishlistBands.length,
            });
          }
        });

        // Convert map values to array
        const concertsList = Array.from(concertsMap.values());

        return {
          id: band.id,
          name: band.name,
          concerts: concertsList,
          concertCount: concertsList.length,
        };
      });

      // Create a simplified bands array with minimal info
      const simplifiedBands = formattedBands.map((band) => ({
        id: band.id,
        name: band.name,
        concertCount: band.concerts.length,
      }));

      // Create a consolidated concerts array with all unique concerts
      const allConcerts = new Map();

      // Populate with all concerts from all bands
      formattedBands.forEach((band) => {
        band.concerts.forEach((concert) => {
          if (!allConcerts.has(concert.id)) {
            // Store the complete concert object, not just the ID
            allConcerts.set(concert.id, concert);
          }
        });
      });

      // Convert to array
      const concertsArray = Array.from(allConcerts.values());

      // Return the restructured data
      res.json({
        id: wishlist.id,
        name: wishlist.name,
        user_id: wishlist.user_id,
        bands: simplifiedBands,
        concerts: concertsArray,
      });
    } catch (error) {
      console.error("Error fetching wishlist:", error);
      const payload = handleError("wishlist", 500);
      return res.status(500).json(payload);
    }
  }
);

// Create a new wishlist
router.post(
  "/wishlists",
  [
    auth,
    roleCheck(["ADMIN"]),
    body("name").trim().isLength({ min: 1, max: 100 }).withMessage("Wishlist name must be between 1 and 100 characters"),
  ],
  rateLimit,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          error: "Validation failed",
          details: errors.array(),
        });
      }

      const { name } = req.body;

      // Create the new wishlist
      const newWishlist = await prisma.wishlist.create({
        data: {
          name: name.trim(),
          user_id: req.user.id,
        },
        include: {
          bands: true,
        },
      });

      res.status(201).json(newWishlist);
    } catch (error) {
      console.error("Error creating wishlist:", error);
      const payload = handleError("wishlist", 500);
      return res.status(500).json(payload);
    }
  }
);

// Update a wishlist name
router.put(
  "/wishlists/:id",
  [
    auth,
    roleCheck(["ADMIN"]),
    param("id").isInt().withMessage("Wishlist ID must be an integer"),
    body("name").trim().isLength({ min: 1, max: 100 }).withMessage("Wishlist name must be between 1 and 100 characters"),
  ],
  rateLimit,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          error: "Validation failed",
          details: errors.array(),
        });
      }

      const wishlistId = parseInt(req.params.id, 10);
      const { name } = req.body;

      // Check if wishlist exists and belongs to the user
      const existingWishlist = await prisma.wishlist.findUnique({
        where: { id: wishlistId },
      });

      if (!existingWishlist) {
        const payload = handleError("wishlist", 404);
        return res.status(404).json(payload);
      }

      if (existingWishlist.user_id !== req.user.id) {
        const payload = handleError("wishlist", 403);
        return res.status(403).json(payload);
      }

      // Update the wishlist
      const updatedWishlist = await prisma.wishlist.update({
        where: { id: wishlistId },
        data: { name: name.trim() },
        include: {
          bands: true,
        },
      });

      res.json(updatedWishlist);
    } catch (error) {
      console.error("Error updating wishlist:", error);
      const payload = handleError("wishlist", 500);
      return res.status(500).json(payload);
    }
  }
);

// Add a band to a wishlist (create band if it doesn't exist)
router.post(
  "/wishlists/:id/bands",
  [
    auth,
    roleCheck(["ADMIN"]),
    param("id").isInt().withMessage("Wishlist ID must be an integer"),
    body("name").optional().isString().notEmpty().withMessage("Band name must be a non-empty string"),
    body("ticketmaster_id").optional().isString().notEmpty().withMessage("Ticketmaster ID must be a non-empty string"),
  ],
  rateLimit,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          error: "Validation failed",
          details: errors.array(),
        });
      }

      const wishlistId = parseInt(req.params.id, 10);
      const { name, ticketmaster_id } = req.body;

      // Validate that either name or ticketmaster_id is provided
      if (!name && !ticketmaster_id) {
        return res.status(400).json({
          error: "Either 'name' or 'ticketmaster_id' must be provided",
        });
      }

      // Sanitize inputs
      const bandName = name ? name.trim() : null;
      const ticketmasterId = ticketmaster_id ? ticketmaster_id.trim() : null;

      // Check if wishlist exists and belongs to the user
      const existingWishlist = await prisma.wishlist.findUnique({
        where: { id: wishlistId },
      });

      if (!existingWishlist) {
        const payload = handleError("wishlist", 404);
        return res.status(404).json(payload);
      }

      if (existingWishlist.user_id !== req.user.id) {
        const payload = handleError("wishlist", 403);
        return res.status(403).json(payload);
      }

      // Check if band already exists in the database
      let band = null;

      if (ticketmasterId) {
        // Search by Ticketmaster ID first if provided
        band = await prisma.band.findUnique({
          where: { ticketmaster_id: ticketmasterId },
          select: { id: true, name: true, ticketmaster_id: true },
        });
      } else if (bandName) {
        // Search by name if no Ticketmaster ID provided
        band = await prisma.band.findUnique({
          where: { name: bandName },
          select: { id: true, name: true, ticketmaster_id: true },
        });
      }

      let newBandCreated = false;

      // If band doesn't exist, create it
      if (!band) {
        try {
          let foundBand;

          if (ticketmasterId) {
            // Fetch band data by Ticketmaster ID
            foundBand = await axios.get(`${ticketmasterURL}attractions/${ticketmasterId}.json`, {
              params: {
                apikey: process.env.TICKETMASTER_KEY,
              },
            });

            if (!foundBand.data) {
              const payload = handleError("band", 404);
              return res.status(404).json(payload);
            }

            // For ID-based search, the response structure is different
            foundBand.data._embedded = { attractions: [foundBand.data] };
          } else {
            // Fetch band data by name (existing logic)
            foundBand = await axios.get(`${ticketmasterURL}attractions.json`, {
              params: {
                apikey: process.env.TICKETMASTER_KEY,
                keyword: bandName,
              },
            });

            if (!foundBand.data._embedded || !foundBand.data._embedded.attractions || foundBand.data._embedded.attractions.length === 0) {
              const payload = handleError("band", 404);
              return res.status(404).json(payload);
            }
          }

          const bandData = foundBand.data._embedded.attractions[0];

          // Create band in database
          band = await prisma.band.create({
            data: {
              name: bandData.name,
              ticketmaster_id: bandData.id,
            },
          });

          newBandCreated = true;

          // Fetch and add concerts for the new band
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

            const events = await axios.get(`${ticketmasterURL}events.json`, {
              params: eventParams,
            });

            if (events.data._embedded && events.data._embedded.events && events.data._embedded.events.length > 0) {
              const uniqueEvents = await removeDuplicateEvents(events.data._embedded.events);

              for (const event of uniqueEvents) {
                const existingConcert = await findConcert({ event });
                if (!existingConcert) {
                  await addConcert({ band, event });
                } else {
                  await addToExistingConcert({
                    concert: existingConcert,
                    band,
                    event,
                  });
                }
              }
            }
          } catch (eventError) {
            console.warn("Could not fetch events for band, but band was created:", eventError.message);
            // Continue anyway - band was created successfully
          }
        } catch (error) {
          console.error("Error fetching band from Ticketmaster:", error);
          const payload = handleError("band", (error.response && error.response.status) || 500);
          return res.status((error.response && error.response.status) || 500).json(payload);
        }
      }

      // Check if band is already in the wishlist
      const existingReference = await prisma.wishlistBandReference.findFirst({
        where: {
          wishlist_id: wishlistId,
          band_id: band.id,
        },
      });

      if (existingReference) {
        const payload = handleError("wishlist", 409);
        return res.status(409).json(payload);
      }

      // Add band to wishlist
      await prisma.wishlistBandReference.create({
        data: {
          wishlist_id: wishlistId,
          band_id: band.id,
        },
      });

      // Return success response
      res.status(201).json({
        message: newBandCreated ? "Band created and added to wishlist successfully" : "Band added to wishlist successfully",
        band: {
          id: band.id,
          name: band.name,
          ticketmaster_id: band.ticketmaster_id,
        },
        newBandCreated,
      });
    } catch (error) {
      console.error("Error adding band to wishlist:", error);
      const payload = handleError("wishlist", 500);
      return res.status(500).json(payload);
    }
  }
);

// Remove a band from a wishlist
router.delete(
  "/wishlists/:id/bands/:bandId",
  [
    auth,
    roleCheck(["ADMIN"]),
    param("id").isInt().withMessage("Wishlist ID must be an integer"),
    param("bandId").isInt().withMessage("Band ID must be an integer"),
  ],
  rateLimit,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          error: "Validation failed",
          details: errors.array(),
        });
      }

      const wishlistId = parseInt(req.params.id, 10);
      const bandId = parseInt(req.params.bandId, 10);

      // Check if wishlist exists and belongs to the user
      const existingWishlist = await prisma.wishlist.findUnique({
        where: { id: wishlistId },
      });

      if (!existingWishlist) {
        const payload = handleError("wishlist", 404);
        return res.status(404).json(payload);
      }

      if (existingWishlist.user_id !== req.user.id) {
        const payload = handleError("wishlist", 403);
        return res.status(403).json(payload);
      }

      // Check if the band is in the wishlist
      const existingReference = await prisma.wishlistBandReference.findFirst({
        where: {
          wishlist_id: wishlistId,
          band_id: bandId,
        },
      });

      if (!existingReference) {
        const payload = handleError("wishlist", 404);
        return res.status(404).json(payload);
      }

      // Remove the band from the wishlist
      await prisma.wishlistBandReference.delete({
        where: {
          id: existingReference.id,
        },
      });

      res.json({ message: "Band removed from wishlist successfully" });
    } catch (error) {
      console.error("Error removing band from wishlist:", error);
      const payload = handleError("wishlist", 500);
      return res.status(500).json(payload);
    }
  }
);

router.delete(
  "/wishlists/:id",
  [auth, roleCheck(["ADMIN"]), param("id").isInt().withMessage("Wishlist ID must be an integer")],
  rateLimit,
  async (req, res) => {
    try {
      const wishlistId = parseInt(req.params.id, 10);
      const existingWishlist = await prisma.wishlist.findUnique({
        where: { id: wishlistId },
      });

      if (!existingWishlist) {
        const payload = handleError("wishlist", 404);
        return res.status(404).json(payload);
      }

      if (existingWishlist.user_id !== req.user.id) {
        const payload = handleError("wishlist", 403);
        return res.status(403).json(payload);
      }

      // Delete related wishlist_band_references first
      await prisma.wishlistBandReference.deleteMany({
        where: { wishlist_id: wishlistId },
      });

      // Then delete the wishlist
      await prisma.wishlist.delete({
        where: { id: wishlistId },
      });

      res.json({ message: "Wishlist deleted successfully." });
    } catch (error) {
      console.error("Error deleting wishlist:", error);
      const payload = handleError("wishlist", 500);
      return res.status(500).json(payload);
    }
  }
);

module.exports = router;
