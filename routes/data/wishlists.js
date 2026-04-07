const express = require("express");
const router = express.Router();
const { validationResult, param, body } = require("express-validator");
const axios = require("axios");
const { handleError } = require("./helpers");

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const { rateLimiter } = require("../../utils/rateLimiter");
const prisma = require("../../prisma/client");

const rateLimit = rateLimiter({
  message: "Too many requests to the Ticketmaster data route, please try again later.",
});

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
                  on_sale: true,
                  ticket_sale_start: true,
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
              on_sale: concert.on_sale,
              ticket_sale_start: concert.ticket_sale_start,
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
    body("discord_webhook").optional({ nullable: true }).isURL().withMessage("Discord webhook must be a valid URL"),
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

      const { name, discord_webhook } = req.body;

      // Create the new wishlist
      const newWishlist = await prisma.wishlist.create({
        data: {
          name: name.trim(),
          user_id: req.user.id,
          discord_webhook: discord_webhook || null,
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
    body("discord_webhook").optional({ nullable: true }).isURL().withMessage("Discord webhook must be a valid URL"),
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
      const { name, discord_webhook } = req.body;

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

      const updateData = { name: name.trim() };
      if (discord_webhook !== undefined) updateData.discord_webhook = discord_webhook || null;

      // Update the wishlist
      const updatedWishlist = await prisma.wishlist.update({
        where: { id: wishlistId },
        data: updateData,
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


      // If band doesn't exist, create it via the POST /data/bands route
      let band;
        try {
          const bandPayload = {};
          if (ticketmasterId) bandPayload.ticketmaster_id = ticketmasterId;
          if (bandName) bandPayload.name = bandName;
          const createResponse = await axios.post(
            `http://${process.env.API_BASE_URL}/data/concerts/bands`,
            bandPayload,
            { headers: { Authorization: req.headers.authorization } },
          );
          band = createResponse.data.band;
          if (!band) {
            console.error('Band creation response missing band object:', createResponse.data);
            return res.status(500).json({ error: 'Band creation failed: no band returned' });
          }
        } catch (error) {
          if (error.response?.status === 409) {
            // Band already exists — look it up directly
            band = ticketmasterId
              ? await prisma.band.findUnique({ where: { ticketmaster_id: ticketmasterId } })
              : await prisma.band.findUnique({ where: { name: bandName } });
            if (!band) {
              console.error('Band reported as existing but not found in DB');
              return res.status(500).json({ error: 'Band lookup failed after conflict' });
            }
          } else {
            console.error('Error creating band:', error.response?.data ?? error.message);
            const status = error.response?.status || 500;
            const payload = handleError('band', status);
            return res.status(status).json(payload);
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
        message: "Band added to wishlist successfully",
        band: {
          id: band.id,
          name: band.name,
          ticketmaster_id: band.ticketmaster_id,
        },
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

router.post(
  "/wishlists/notify",
  [auth, roleCheck(["ADMIN", "SYSTEM"]), body("bands").isArray({ min: 1 }).withMessage("bands must be a non-empty array")],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: "Validation failed", details: errors.array() });

      const { bands } = req.body;
      // bands: [{ ticketmaster_id, name, concerts: [...] }]

      // Find all wishlists that contain any of these bands and have a webhook set
      const wishlists = await prisma.wishlist.findMany({
        where: { discord_webhook: { not: null } },
        include: {
          bands: {
            include: { band_rel: { select: { id: true, name: true, ticketmaster_id: true } } },
          },
        },
      });

      // Group new concert data by wishlist
      const notifications = wishlists
        .map((wishlist) => {
          const matchedBands = bands.filter((b) =>
            wishlist.bands.some((ref) => ref.band_rel.ticketmaster_id === b.ticketmaster_id),
          );
          return { wishlist, matchedBands };
        })
        .filter(({ matchedBands }) => matchedBands.length > 0);

      // Fire Discord webhooks
      await Promise.all(
        notifications.map(async ({ wishlist, matchedBands }) => {
          const embeds = buildDiscordEmbeds(wishlist.name, matchedBands);
          for (const embed of embeds) {
            await axios.post(wishlist.discord_webhook, { embeds: [embed] });
          }
        }),
      );

      res.json({ notified: notifications.length });
    } catch (error) {
      console.error("Error sending Discord notifications:", error);
      res.status(500).json({ error: "Failed to send notifications" });
    }
  },
);

function buildDiscordEmbeds(wishlistName, bands) {
  const fields = [];

  for (const band of bands) {
    for (const concert of band.concerts) {
      const date = concert.concert_date
        ? new Date(concert.concert_date).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
        : "TBA";
      const location = [concert.city, concert.country].filter(Boolean).join(", ");
      const venue = concert.venue || "Unknown venue";
      const label = `${band.name} — ${date}, ${location}`;
      const value = concert.url ? `[${venue}](${concert.url})` : venue;

      let lineup = [];
      try { lineup = JSON.parse(concert.metadata || "[]"); } catch {}
      const lineupStr = lineup.length ? `\n${lineup.join(", ")}` : "";

      fields.push({ name: label, value: value + lineupStr, inline: false });
    }
  }

  // Chunk into groups of 25 (Discord embed field limit)
  const embeds = [];
  for (let i = 0; i < Math.max(fields.length, 1); i += 25) {
    embeds.push({
      title: `New concerts on wishlist: ${wishlistName}`,
      color: 0x5865f2,
      fields: fields.slice(i, i + 25),
      footer: { text: `${fields.length} new concert${fields.length !== 1 ? "s" : ""}` },
    });
  }
  return embeds;
}

module.exports = router;
