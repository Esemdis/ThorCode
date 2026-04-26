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

const VALID_TIERS = ["LOVE", "LIKE", "FOLLOW"];

// Helper: trigger Python service to recompute scores for a wishlist
async function triggerScoreRecompute(wishlistId) {
  const pythonUrl = process.env.PYTHON_SERVICE_URL;
  if (!pythonUrl) return;
  try {
    await axios.post(`${pythonUrl}/recompute/${wishlistId}`, {}, { timeout: 5000 });
  } catch (e) {
    // Non-blocking — scoring will recompute on next full sync if this fails
    console.warn(`[Scoring] Failed to trigger recompute for wishlist ${wishlistId}:`, e.message);
  }
}

// GET /wishlists — list the user's single wishlist
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

// GET /wishlists/raw — returns all wishlists with raw band+concert data (SYSTEM only, for Python scoring)
router.get(
  "/wishlists/raw",
  [auth, roleCheck(["SYSTEM"])],
  async (_req, res) => {
    try {
      const wishlists = await prisma.wishlist.findMany({
        include: {
          bands: {
            select: {
              band_id: true,
              tier: true,
              times_seen: true,
            },
          },
        },
      });

      const result = await Promise.all(
        wishlists.map(async (wishlist) => {
          const bandIds = wishlist.bands.map((b) => b.band_id);

          // Get all concerts for all bands in this wishlist
          const concertRefs = await prisma.concertBandReference.findMany({
            where: { band: { in: bandIds } },
            include: {
              concert_rel: {
                select: {
                  id: true,
                  city: true,
                  country: true,
                  concert_date: true,
                  latitude: true,
                  longitude: true,
                  bands: {
                    select: { band: true },
                  },
                },
              },
            },
          });

          // Deduplicate concerts and collect band_ids per concert
          const concertMap = new Map();
          for (const ref of concertRefs) {
            const c = ref.concert_rel;
            if (!concertMap.has(c.id)) {
              concertMap.set(c.id, {
                id: c.id,
                city: c.city,
                country: c.country,
                concert_date: c.concert_date,
                latitude: c.latitude,
                longitude: c.longitude,
                band_ids: c.bands.map((b) => b.band),
              });
            }
          }

          return {
            id: wishlist.id,
            bands: wishlist.bands,
            concerts: Array.from(concertMap.values()),
          };
        })
      );

      res.json(result);
    } catch (error) {
      console.error("Error fetching raw wishlists:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// GET /wishlists/:id/new — concerts added since the user's last visit (cross-device)
router.get(
  "/wishlists/:id/new",
  [auth, roleCheck(["ADMIN", "USER"]), param("id").isInt().withMessage("Wishlist ID must be an integer")],
  async (req, res) => {
    try {
      const wishlistId = parseInt(req.params.id, 10);

      const wishlist = await prisma.wishlist.findUnique({
        where: { id: wishlistId },
        include: { bands: true },
      });

      if (!wishlist) return res.status(404).json({ error: "Not found" });
      if (wishlist.user_id !== req.user.id) return res.status(403).json({ error: "Forbidden" });

      const sinceDate = wishlist.last_active_at ?? new Date(0);

      // Update last_active_at before returning so any device hitting this endpoint moves the cursor
      await prisma.wishlist.update({
        where: { id: wishlistId },
        data: { last_active_at: new Date() },
      });

      const bandIds = wishlist.bands.map((b) => b.band_id);

      const refs = await prisma.concertBandReference.findMany({
        where: {
          band: { in: bandIds },
          concert_rel: { created_at: { gt: sinceDate } },
        },
        include: {
          band_rel: { select: { name: true } },
          concert_rel: {
            select: {
              id: true,
              name: true,
              city: true,
              country: true,
              venue: true,
              latitude: true,
              longitude: true,
              concert_date: true,
              on_sale: true,
              ticket_sale_start: true,
              url: true,
              festival: true,
              bands: {
                include: { band_rel: { select: { name: true, id: true } } },
              },
            },
          },
        },
      });

      const concertMap = new Map();
      for (const ref of refs) {
        const c = ref.concert_rel;
        if (!concertMap.has(c.id)) {
          concertMap.set(c.id, {
            ...c,
            participating_bands: c.bands.map((b) => b.band_rel),
          });
        }
      }

      // Write NEW_CONCERTS activity log entry when there's something to report
      if (concertMap.size > 0) {
        const bandConcertMap = new Map();
        for (const ref of refs) {
          const name = ref.band_rel?.name || "Unknown";
          if (!bandConcertMap.has(name)) bandConcertMap.set(name, { ids: new Set(), countries: new Set() });
          bandConcertMap.get(name).ids.add(ref.concert_rel.id);
          if (ref.concert_rel.country) bandConcertMap.get(name).countries.add(ref.concert_rel.country);
        }
        const byBand = [...bandConcertMap.entries()]
          .map(([name, { ids, countries }]) => ({ name, count: ids.size, countries: [...countries] }))
          .sort((a, b) => b.count - a.count);

        await prisma.activityLog.create({
          data: {
            wishlist_id: wishlistId,
            type: "NEW_CONCERTS",
            data: JSON.stringify({ total: concertMap.size, by_band: byBand }),
          },
        });
        const old = await prisma.activityLog.findMany({
          where: { wishlist_id: wishlistId },
          orderBy: { created_at: "desc" },
          skip: 15,
          select: { id: true },
        });
        if (old.length > 0) {
          await prisma.activityLog.deleteMany({ where: { id: { in: old.map((e) => e.id) } } });
        }
      }

      const concerts = Array.from(concertMap.values()).sort(
        (a, b) => new Date(a.concert_date || 0) - new Date(b.concert_date || 0),
      );

      res.json({ concerts });
    } catch (error) {
      console.error("Error fetching new concerts:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// GET /wishlists/:id/activity — last 15 activity log entries for this wishlist
router.get(
  "/wishlists/:id/activity",
  [auth, roleCheck(["ADMIN", "USER"]), param("id").isInt().withMessage("Wishlist ID must be an integer")],
  async (req, res) => {
    try {
      const wishlistId = parseInt(req.params.id, 10);
      const wishlist = await prisma.wishlist.findUnique({ where: { id: wishlistId } });
      if (!wishlist) return res.status(404).json({ error: "Not found" });
      if (wishlist.user_id !== req.user.id) return res.status(403).json({ error: "Forbidden" });

      const logs = await prisma.activityLog.findMany({
        where: { wishlist_id: wishlistId },
        orderBy: { created_at: "desc" },
        take: 15,
      });

      res.json({
        activity: logs.map((log) => ({ ...log, data: JSON.parse(log.data) })),
      });
    } catch (error) {
      console.error("Error fetching activity log:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// GET /wishlists/:id — wishlist with concerts, bands (with tiers), and precomputed scores
router.get(
  "/wishlists/:id",
  [auth, roleCheck(["ADMIN"]), param("id").isInt().withMessage("Wishlist ID must be an integer")],
  async (req, res) => {
    try {
      const wishlistId = parseInt(req.params.id, 10);
      const { start_date, end_date, countries } = req.query;

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

      const bandIds = wishlist.bands.map((ref) => ref.band_id);
      const bandTierMap = new Map(wishlist.bands.map((ref) => [ref.band_id, ref.tier]));

      const bandsWithConcerts = await prisma.band.findMany({
        where: { id: { in: bandIds } },
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
                  source: true,
                  url: true,
                  bands: {
                    include: {
                      band_rel: {
                        select: { name: true, id: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });

      // Parse precomputed concert scores from stored JSON
      let concertScoreMap = new Map();
      if (wishlist.concert_scores) {
        try {
          const stored = JSON.parse(wishlist.concert_scores);
          concertScoreMap = new Map(Object.entries(stored).map(([k, v]) => [parseInt(k, 10), v]));
        } catch (_) {}
      }

      const formattedBands = bandsWithConcerts.map((band) => {
        const concertsMap = new Map();

        band.concerts.forEach((concertRef) => {
          const concert = concertRef.concert_rel;
          const eventId = concert.id;

          if (start_date && end_date) {
            const concertDate = new Date(concert.concert_date);
            const startDate = new Date(start_date);
            const endDate = new Date(end_date);
            endDate.setHours(23, 59, 59, 999);
            if (concertDate < startDate || concertDate > endDate) return;
          }

          if (countries) {
            const countryList = countries.split(",");
            if (!countryList.includes(concert.country)) return;
          }

          if (!concertsMap.has(eventId)) {
            const wishlistBands = concert.bands
              .map((b) => ({
                id: b.band_rel.id,
                name: b.band_rel.name,
                tier: bandTierMap.get(b.band_rel.id) ?? null,
              }))
              .filter((b) => bandIds.includes(b.id));

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
              source: concert.source,
              url: concert.url,
              participating_bands: wishlistBands,
              wishlist_band_count: wishlistBands.length,
              concert_score: concertScoreMap.get(concert.id) ?? 0,
            });
          }
        });

        const concertsList = Array.from(concertsMap.values());
        return { id: band.id, name: band.name, concerts: concertsList, concertCount: concertsList.length };
      });

      // Simplified bands array with tier and seen count
      const simplifiedBands = wishlist.bands.map((ref) => ({
        id: ref.band_rel.id,
        name: ref.band_rel.name,
        concertCount: formattedBands.find((b) => b.id === ref.band_id)?.concertCount ?? 0,
        tier: ref.tier,
        times_seen: ref.times_seen,
        songkick_url: ref.band_rel.songkick_url ?? null,
        bandsintown_url: ref.band_rel.bandsintown_url ?? null,
      }));

      // Deduplicated concerts across all bands
      const allConcerts = new Map();
      formattedBands.forEach((band) => {
        band.concerts.forEach((concert) => {
          if (!allConcerts.has(concert.id)) allConcerts.set(concert.id, concert);
        });
      });
      const concertsArray = Array.from(allConcerts.values());

      // Parse precomputed city rankings
      let cityRankings = [];
      if (wishlist.city_rankings) {
        try {
          cityRankings = JSON.parse(wishlist.city_rankings);
          // Apply date range filter to city rankings if provided
          if ((start_date || end_date) && concertsArray.length > 0) {
            // Re-filter city rankings based on which concerts are visible in this date range
              const visibleCities = new Set(concertsArray.map((c) => `${c.city}|||${c.country}`));
            cityRankings = cityRankings.filter((r) => visibleCities.has(`${r.city}|||${r.country}`));
          }
        } catch (_) {}
      }

      res.json({
        id: wishlist.id,
        name: wishlist.name,
        user_id: wishlist.user_id,
        discord_webhook: wishlist.discord_webhook,
        bands: simplifiedBands,
        concerts: concertsArray,
        city_rankings: cityRankings,
        scores_computed_at: wishlist.scores_computed_at,
      });
    } catch (error) {
      console.error("Error fetching wishlist:", error);
      const payload = handleError("wishlist", 500);
      return res.status(500).json(payload);
    }
  }
);

// PATCH /wishlists/:id/scores — store precomputed scores from Python (SYSTEM only)
router.patch(
  "/wishlists/:id/scores",
  [auth, roleCheck(["SYSTEM"]), param("id").isInt().withMessage("Wishlist ID must be an integer")],
  async (req, res) => {
    try {
      const wishlistId = parseInt(req.params.id, 10);
      const { concert_scores, city_rankings } = req.body;

      await prisma.wishlist.update({
        where: { id: wishlistId },
        data: {
          concert_scores: JSON.stringify(concert_scores),
          city_rankings: JSON.stringify(city_rankings),
          scores_computed_at: new Date(),
        },
      });

      res.json({ ok: true });
    } catch (error) {
      console.error("Error storing computed scores:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// PATCH /wishlists/:id/bands/:bandId — update tier and/or times_seen for a band
router.patch(
  "/wishlists/:id/bands/:bandId",
  [
    auth,
    roleCheck(["ADMIN"]),
    param("id").isInt().withMessage("Wishlist ID must be an integer"),
    param("bandId").isInt().withMessage("Band ID must be an integer"),
    body("tier").optional().isIn(VALID_TIERS).withMessage("tier must be LOVE, LIKE, or FOLLOW"),
    body("times_seen").optional().isInt({ min: 0 }).withMessage("times_seen must be a non-negative integer"),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: "Validation failed", details: errors.array() });
      }

      const wishlistId = parseInt(req.params.id, 10);
      const bandId = parseInt(req.params.bandId, 10);
      const { tier, times_seen } = req.body;

      if (tier === undefined && times_seen === undefined) {
        return res.status(400).json({ error: "Provide at least one of: tier, times_seen" });
      }

      // Verify ownership
      const wishlist = await prisma.wishlist.findUnique({ where: { id: wishlistId } });
      if (!wishlist) return res.status(404).json(handleError("wishlist", 404));
      if (wishlist.user_id !== req.user.id) return res.status(403).json(handleError("wishlist", 403));

      const updateData = {};
      if (tier !== undefined) updateData.tier = tier;
      if (times_seen !== undefined) updateData.times_seen = times_seen;

      const updated = await prisma.wishlistBandReference.update({
        where: { band_wishlist: { band_id: bandId, wishlist_id: wishlistId } },
        data: updateData,
      });

      // Trigger async score recompute — non-blocking
      triggerScoreRecompute(wishlistId);

      res.json(updated);
    } catch (error) {
      console.error("Error updating band in wishlist:", error);
      const payload = handleError("wishlist", 500);
      return res.status(500).json(payload);
    }
  }
);

// POST /wishlists — create wishlist (returns existing one if user already has one)
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
        return res.status(400).json({ error: "Validation failed", details: errors.array() });
      }

      // Return existing wishlist if user already has one
      const existing = await prisma.wishlist.findUnique({ where: { user_id: req.user.id }, include: { bands: true } });
      if (existing) return res.status(200).json(existing);

      const { name, discord_webhook } = req.body;

      const newWishlist = await prisma.wishlist.create({
        data: {
          name: name.trim(),
          user_id: req.user.id,
          discord_webhook: discord_webhook || null,
        },
        include: { bands: true },
      });

      res.status(201).json(newWishlist);
    } catch (error) {
      console.error("Error creating wishlist:", error);
      const payload = handleError("wishlist", 500);
      return res.status(500).json(payload);
    }
  }
);

// PUT /wishlists/:id — update wishlist name/webhook
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
        return res.status(400).json({ error: "Validation failed", details: errors.array() });
      }

      const wishlistId = parseInt(req.params.id, 10);
      const { name, discord_webhook } = req.body;

      const existingWishlist = await prisma.wishlist.findUnique({ where: { id: wishlistId } });
      if (!existingWishlist) return res.status(404).json(handleError("wishlist", 404));
      if (existingWishlist.user_id !== req.user.id) return res.status(403).json(handleError("wishlist", 403));

      const updateData = { name: name.trim() };
      if (discord_webhook !== undefined) updateData.discord_webhook = discord_webhook || null;

      const updatedWishlist = await prisma.wishlist.update({
        where: { id: wishlistId },
        data: updateData,
        include: { bands: true },
      });

      res.json(updatedWishlist);
    } catch (error) {
      console.error("Error updating wishlist:", error);
      const payload = handleError("wishlist", 500);
      return res.status(500).json(payload);
    }
  }
);

// POST /wishlists/:id/bands — add a band to the wishlist (with tier)
router.post(
  "/wishlists/:id/bands",
  [
    auth,
    roleCheck(["ADMIN"]),
    param("id").isInt().withMessage("Wishlist ID must be an integer"),
    body("name").optional().isString().notEmpty().withMessage("Band name must be a non-empty string"),
    body("ticketmaster_id").optional().isString().notEmpty().withMessage("Ticketmaster ID must be a non-empty string"),
    body("tier").optional().isIn(VALID_TIERS).withMessage("tier must be LOVE, LIKE, or FOLLOW"),
  ],
  rateLimit,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: "Validation failed", details: errors.array() });
      }

      const wishlistId = parseInt(req.params.id, 10);
      const { name, ticketmaster_id, tier = "FOLLOW" } = req.body;

      if (!name && !ticketmaster_id) {
        return res.status(400).json({ error: "Either 'name' or 'ticketmaster_id' must be provided" });
      }

      const bandName = name ? name.trim() : null;
      const ticketmasterId = ticketmaster_id ? ticketmaster_id.trim() : null;

      const existingWishlist = await prisma.wishlist.findUnique({ where: { id: wishlistId } });
      if (!existingWishlist) return res.status(404).json(handleError("wishlist", 404));
      if (existingWishlist.user_id !== req.user.id) return res.status(403).json(handleError("wishlist", 403));

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
          console.error("Band creation response missing band object:", createResponse.data);
          return res.status(500).json({ error: "Band creation failed: no band returned" });
        }
      } catch (error) {
        if (error.response?.status === 409) {
          band = ticketmasterId
            ? await prisma.band.findUnique({ where: { ticketmaster_id: ticketmasterId } })
            : await prisma.band.findUnique({ where: { name: bandName } });
          if (!band) {
            console.error("Band reported as existing but not found in DB");
            return res.status(500).json({ error: "Band lookup failed after conflict" });
          }
        } else {
          console.error("Error creating band:", error.response?.data ?? error.message);
          const status = error.response?.status || 500;
          return res.status(status).json(handleError("band", status));
        }
      }

      const existingReference = await prisma.wishlistBandReference.findFirst({
        where: { wishlist_id: wishlistId, band_id: band.id },
      });

      if (existingReference) return res.status(409).json(handleError("wishlist", 409));

      await prisma.wishlistBandReference.create({
        data: { wishlist_id: wishlistId, band_id: band.id, tier },
      });

      // Trigger score recompute after adding a new band
      triggerScoreRecompute(wishlistId);

      res.status(201).json({
        message: "Band added to wishlist successfully",
        band: { id: band.id, name: band.name, ticketmaster_id: band.ticketmaster_id },
      });
    } catch (error) {
      console.error("Error adding band to wishlist:", error);
      const payload = handleError("wishlist", 500);
      return res.status(500).json(payload);
    }
  }
);

// DELETE /wishlists/:id/bands/:bandId — remove a band from the wishlist
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
        return res.status(400).json({ error: "Validation failed", details: errors.array() });
      }

      const wishlistId = parseInt(req.params.id, 10);
      const bandId = parseInt(req.params.bandId, 10);

      const existingWishlist = await prisma.wishlist.findUnique({ where: { id: wishlistId } });
      if (!existingWishlist) return res.status(404).json(handleError("wishlist", 404));
      if (existingWishlist.user_id !== req.user.id) return res.status(403).json(handleError("wishlist", 403));

      const existingReference = await prisma.wishlistBandReference.findFirst({
        where: { wishlist_id: wishlistId, band_id: bandId },
      });

      if (!existingReference) return res.status(404).json(handleError("wishlist", 404));

      await prisma.wishlistBandReference.delete({ where: { id: existingReference.id } });

      // Trigger score recompute after removing a band
      triggerScoreRecompute(wishlistId);

      res.json({ message: "Band removed from wishlist successfully" });
    } catch (error) {
      console.error("Error removing band from wishlist:", error);
      const payload = handleError("wishlist", 500);
      return res.status(500).json(payload);
    }
  }
);

// DELETE /wishlists/:id
router.delete(
  "/wishlists/:id",
  [auth, roleCheck(["ADMIN"]), param("id").isInt().withMessage("Wishlist ID must be an integer")],
  rateLimit,
  async (req, res) => {
    try {
      const wishlistId = parseInt(req.params.id, 10);
      const existingWishlist = await prisma.wishlist.findUnique({ where: { id: wishlistId } });
      if (!existingWishlist) return res.status(404).json(handleError("wishlist", 404));
      if (existingWishlist.user_id !== req.user.id) return res.status(403).json(handleError("wishlist", 403));

      await prisma.wishlistBandReference.deleteMany({ where: { wishlist_id: wishlistId } });
      await prisma.wishlist.delete({ where: { id: wishlistId } });

      res.json({ message: "Wishlist deleted successfully." });
    } catch (error) {
      console.error("Error deleting wishlist:", error);
      const payload = handleError("wishlist", 500);
      return res.status(500).json(payload);
    }
  }
);

// POST /wishlists/notify — Discord notifications for new concerts (SYSTEM/ADMIN)
router.post(
  "/wishlists/notify",
  [auth, roleCheck(["ADMIN", "SYSTEM"]), body("bands").isArray({ min: 1 }).withMessage("bands must be a non-empty array")],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: "Validation failed", details: errors.array() });

      const { bands } = req.body;

      // All wishlists — needed for activity logs regardless of webhook
      const allWishlists = await prisma.wishlist.findMany({
        include: {
          bands: {
            include: { band_rel: { select: { id: true, name: true, ticketmaster_id: true } } },
          },
        },
      });

      // Discord notifications — only wishlists with a webhook
      const notifications = allWishlists
        .filter((w) => w.discord_webhook)
        .map((wishlist) => {
          const matchedBands = bands.filter((b) =>
            wishlist.bands.some((ref) => ref.band_rel.id === b.band_id),
          );
          return { wishlist, matchedBands };
        })
        .filter(({ matchedBands }) => matchedBands.length > 0);

      await Promise.all(
        notifications.map(async ({ wishlist, matchedBands }) => {
          for (const band of matchedBands) {
            const embeds = buildDiscordEmbeds(band);
            for (const embed of embeds) {
              await axios.post(wishlist.discord_webhook, { embeds: [embed] });
            }
          }
        }),
      );

      // Activity logs — all wishlists that have the band, only when concerts were inserted
      for (const wishlist of allWishlists) {
        const matchedBands = bands.filter(
          (b) => b.inserted > 0 && wishlist.bands.some((ref) => ref.band_rel.id === b.band_id),
        );
        for (const band of matchedBands) {
          const countries = [...new Set((band.concerts || []).map((c) => c.country).filter(Boolean))];
          await prisma.activityLog.create({
            data: {
              wishlist_id: wishlist.id,
              type: "BAND_ADDED",
              data: JSON.stringify({ band_name: band.name, band_id: band.band_id, inserted: band.inserted, countries }),
            },
          });
          const old = await prisma.activityLog.findMany({
            where: { wishlist_id: wishlist.id },
            orderBy: { created_at: "desc" },
            skip: 15,
            select: { id: true },
          });
          if (old.length > 0) {
            await prisma.activityLog.deleteMany({ where: { id: { in: old.map((e) => e.id) } } });
          }
        }
      }

      res.json({ notified: notifications.length });
    } catch (error) {
      console.error("Error sending Discord notifications:", error);
      res.status(500).json({ error: "Failed to send notifications" });
    }
  },
);

function buildDiscordEmbeds(band) {
  const EMBED_CHAR_LIMIT = 5800;
  const FIELD_VALUE_LIMIT = 1024;
  const FIELD_NAME_LIMIT = 256;
  const MAX_FIELDS = 25;

  const fields = [];

  for (const concert of band.concerts) {
    const date = concert.concert_date
      ? new Date(concert.concert_date).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
      : "TBA";
    const location = [concert.city, concert.country].filter(Boolean).join(", ");
    const venue = concert.venue || "Unknown venue";
    const rawLabel = `${date} — ${location}`;
    const label = rawLabel.length > FIELD_NAME_LIMIT ? rawLabel.slice(0, FIELD_NAME_LIMIT - 1) + "…" : rawLabel;
    const venueStr = concert.url ? `[${venue}](${concert.url})` : venue;

    let lineup = [];
    try { lineup = JSON.parse(concert.metadata || "[]"); } catch {}
    const fullLineup = lineup.length ? `\n${lineup.join(", ")}` : "";
    const maxLineup = FIELD_VALUE_LIMIT - venueStr.length - 1;
    const lineupStr = fullLineup.length > maxLineup ? fullLineup.slice(0, maxLineup) + "…" : fullLineup;

    fields.push({ name: label, value: venueStr + lineupStr, inline: false });
  }

  const title = `New concerts: ${band.name}`;
  const footer = `${fields.length} new concert${fields.length !== 1 ? "s" : ""}`;
  const baseChars = title.length + footer.length;

  const embeds = [];
  let current = [];
  let currentChars = baseChars;

  for (const field of fields) {
    const fieldChars = field.name.length + field.value.length;
    if (current.length > 0 && (currentChars + fieldChars > EMBED_CHAR_LIMIT || current.length >= MAX_FIELDS)) {
      embeds.push({ title, color: 0x5865f2, fields: current, footer: { text: footer } });
      current = [];
      currentChars = baseChars;
    }
    current.push(field);
    currentChars += fieldChars;
  }

  if (current.length > 0 || embeds.length === 0) {
    embeds.push({ title, color: 0x5865f2, fields: current, footer: { text: footer } });
  }

  return embeds;
}

module.exports = router;
