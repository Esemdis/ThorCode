const express = require("express");
const router = express.Router();
const { validationResult, param, body } = require("express-validator");
const axios = require("axios");
const { addConcert, findConcert, addToExistingConcert, removeDuplicateEvents } = require("./helpers");

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

// Search bands by name for autocomplete
router.get("/bands/search", async (req, res) => {
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
          mode: 'insensitive'
        }
      },
      select: {
        id: true,
        name: true,
      },
      orderBy: [
        // Prioritize exact matches at the beginning
        {
          name: 'asc'
        }
      ],
      take: parseInt(limit, 10)
    });

    // Sort results to prioritize matches that start with the search term
    const sortedBands = bands.sort((a, b) => {
      const aStartsWith = a.name.toLowerCase().startsWith(searchTerm.toLowerCase());
      const bStartsWith = b.name.toLowerCase().startsWith(searchTerm.toLowerCase());

      if (aStartsWith && !bStartsWith) return -1;
      if (!aStartsWith && bStartsWith) return 1;
      return a.name.localeCompare(b.name);
    });

    res.json(sortedBands);
  } catch (error) {
    console.error("Error searching bands:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

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

      let foundBand;
      try {
        // Fetch band data from Ticketmaster API
        foundBand = await axios.get(`${ticketmasterURL}attractions.json`, {
          params: {
            apikey: process.env.TICKETMASTER_KEY,
            keyword: bandName,
          },
        });

        if (foundBand.data._embedded.attractions.length === 0) {
          return res.status(404).json({ error: "No band found." });
        }
      } catch (error) {
        if (error.status === 404) {
          return res.status(404).json({ error: "No events found for this band." });
        } else if (error.response.status === 429) {
          return res.status(429).json({ error: "Too many requests, please try again later." });
        }
        console.error("Error fetching events from Ticketmaster:", error);
        return res.status(500).json({ error: "Internal server error" });
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
        events = await axios.get(`${ticketmasterURL}events.json`, {
          params: {
            countryCode: countries.map(country => country.iso),
            apikey: process.env.TICKETMASTER_KEY,
            keyword: bandName,
          },
        });
      } catch (error) {
        if (error.status === 404) {
          return res.status(404).json({ error: "No events found for this band." });
        } else if (error.response.status === 429) {
          return res.status(429).json({ error: "Too many requests, please try again later." });
        }
        console.error("Error fetching events from Ticketmaster:", error);
        return res.status(500).json({ error: "Internal server error" });
      }

      if (events.status !== 200) {
        return res.status(500).json({ error: "Failed to fetch data from Ticketmaster." });
      }

      if (!events.data._embedded || !events.data._embedded.events || events.data._embedded.events.length === 0) {
        return res.status(404).json({ error: "No events found for this band." });
      }

      const uniqueEvents = await removeDuplicateEvents(events.data._embedded.events);


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

      res.json({
        id: newBand.id,
        name: newBand.name,
        ticketmaster_id: newBand.ticketmaster_id,
        concerts: uniqueEvents.map(event => ({
          name: event.name,
          concert_date: event.concert_date ? new Date(event.concert_date).toLocaleString() : "",
          venue: event.venue,
          city: event.city,
          country: event.country,
          url: event.url,
          on_sale: event.on_sale,
          id: event.id,
        })),
      });
    } catch (error) {
      console.error("Error fetching Ticketmaster data:", error);
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
router.get("/wishlists/:id",
  [
    auth,
    roleCheck(["ADMIN"]),
    param("id").isInt().withMessage("Wishlist ID must be an integer"),
  ],
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
        // First, create a map to store unique concerts by ID
        const concertsMap = new Map();

        band.concerts.forEach(concertRef => {
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
            const countryList = countries.split(',');
            if (!countryList.includes(concert.country)) {
              return;
            }
          }

          if (!concertsMap.has(eventId)) {
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
              participating_bands: concert.bands
                .map(b => ({
                  id: b.band_rel.id,
                  name: b.band_rel.name
                }))
                .filter(band => bandIds.includes(band.id)) // Only include bands that are in the wishlist
            });
          }
        });

        // Convert map values to array
        const concertsList = Array.from(concertsMap.values());

        return {
          id: band.id,
          name: band.name,
          concerts: concertsList,
          concertCount: concertsList.length
        };
      });

      // Create a simplified bands array with minimal info
      const simplifiedBands = formattedBands.map(band => ({
        id: band.id,
        name: band.name,
        concertCount: band.concerts.length
      }));

      // Create a consolidated concerts array with all unique concerts
      const allConcerts = new Map();

      // Populate with all concerts from all bands
      formattedBands.forEach(band => {
        band.concerts.forEach(concert => {
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
        concerts: concertsArray
      });
    } catch (error) {
      console.error("Error fetching wishlist:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Create a new wishlist
router.post(
  "/wishlists",
  [
    auth,
    roleCheck(["ADMIN"]),
    body("name")
      .trim()
      .isLength({ min: 1, max: 100 })
      .withMessage("Wishlist name must be between 1 and 100 characters"),
  ],
  rateLimit,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          error: "Validation failed",
          details: errors.array()
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
      res.status(500).json({ error: "Internal server error" });
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
    body("name")
      .trim()
      .isLength({ min: 1, max: 100 })
      .withMessage("Wishlist name must be between 1 and 100 characters"),
  ],
  rateLimit,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          error: "Validation failed",
          details: errors.array()
        });
      }

      const wishlistId = parseInt(req.params.id, 10);
      const { name } = req.body;

      // Check if wishlist exists and belongs to the user
      const existingWishlist = await prisma.wishlist.findUnique({
        where: { id: wishlistId },
      });

      if (!existingWishlist) {
        return res.status(404).json({ error: "Wishlist not found" });
      }

      if (existingWishlist.user_id !== req.user.id) {
        return res.status(403).json({ error: "Access denied" });
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
      res.status(500).json({ error: "Internal server error" });
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
    body("name").isString().notEmpty().withMessage("Band name is required"),
  ],
  rateLimit,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          error: "Validation failed",
          details: errors.array()
        });
      }

      const wishlistId = parseInt(req.params.id, 10);
      const bandName = req.body.name.trim();

      // Check if wishlist exists and belongs to the user
      const existingWishlist = await prisma.wishlist.findUnique({
        where: { id: wishlistId },
      });

      if (!existingWishlist) {
        return res.status(404).json({ error: "Wishlist not found" });
      }

      if (existingWishlist.user_id !== req.user.id) {
        return res.status(403).json({ error: "Access denied" });
      }

      // Check if band already exists in the database
      let band = await prisma.band.findUnique({
        where: { name: bandName },
        select: { id: true, name: true, ticketmaster_id: true },
      });

      let newBandCreated = false;

      // If band doesn't exist, create it
      if (!band) {
        try {
          // Fetch band data from Ticketmaster API
          const foundBand = await axios.get(`${ticketmasterURL}attractions.json`, {
            params: {
              apikey: process.env.TICKETMASTER_KEY,
              keyword: bandName,
            },
          });

          if (!foundBand.data._embedded || !foundBand.data._embedded.attractions || foundBand.data._embedded.attractions.length === 0) {
            return res.status(404).json({ error: "Band not found on Ticketmaster" });
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
            const events = await axios.get(`${ticketmasterURL}events.json`, {
              params: {
                countryCode: countries.map(country => country.iso),
                apikey: process.env.TICKETMASTER_KEY,
                keyword: bandName,
              },
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
          if (error.response?.status === 404) {
            return res.status(404).json({ error: "Band not found on Ticketmaster" });
          } else if (error.response?.status === 429) {
            return res.status(429).json({ error: "Too many requests to Ticketmaster, please try again later" });
          }
          console.error("Error fetching band from Ticketmaster:", error);
          return res.status(500).json({ error: "Failed to fetch band information" });
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
        return res.status(409).json({ error: "Band is already in this wishlist" });
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
        message: newBandCreated
          ? "Band created and added to wishlist successfully"
          : "Band added to wishlist successfully",
        band: {
          id: band.id,
          name: band.name,
          ticketmaster_id: band.ticketmaster_id,
        },
        newBandCreated,
      });

    } catch (error) {
      console.error("Error adding band to wishlist:", error);
      res.status(500).json({ error: "Internal server error" });
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
          details: errors.array()
        });
      }

      const wishlistId = parseInt(req.params.id, 10);
      const bandId = parseInt(req.params.bandId, 10);

      // Check if wishlist exists and belongs to the user
      const existingWishlist = await prisma.wishlist.findUnique({
        where: { id: wishlistId },
      });

      if (!existingWishlist) {
        return res.status(404).json({ error: "Wishlist not found" });
      }

      if (existingWishlist.user_id !== req.user.id) {
        return res.status(403).json({ error: "Access denied" });
      }

      // Check if the band is in the wishlist
      const existingReference = await prisma.wishlistBandReference.findFirst({
        where: {
          wishlist_id: wishlistId,
          band_id: bandId,
        },
      });

      if (!existingReference) {
        return res.status(404).json({ error: "Band not found in this wishlist" });
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
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

router.delete(
  "/wishlists/:id",
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

      if (existingWishlist.user_id !== req.user.id) {
        return res.status(403).json({ error: "Access denied" });
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
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

module.exports = router;
