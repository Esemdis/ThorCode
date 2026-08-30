/**
 * Adding, re-tiering and removing the bands on a wishlist.
 *
 * Split out of routes/data/wishlists.js, which had grown to 1473 lines and
 * twenty-one endpoints. wishlists.js mounts this and its siblings in their
 * original declaration order — the manifest test in wishlists.test.js pins
 * the resulting surface.
 */
const express = require("express");
const router = express.Router();
const { validationResult, param, body } = require("express-validator");
const axios = require("axios");
const { handleError } = require("../helpers");
const auth = require("../../../auth/verifyJWT");
const roleCheck = require("../../../middlewares/roleCheck");
const prisma = require("../../../prisma/client");
const { rateLimit } = require("./shared");

const VALID_TIERS = ["LOVE", "LIKE", "FOLLOW"];

// Discord's own webhook host+path shape — anything else lets a user aim the
// server's outbound POST at an internal address (SSRF) via /wishlists/notify.
const DISCORD_WEBHOOK_RE = /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/;
function validateDiscordWebhook(value) {
  if (!DISCORD_WEBHOOK_RE.test(value)) {
    throw new Error("Discord webhook must be a valid https://discord.com/api/webhooks/... URL");
  }
  return true;
}

// Helper: compute per-band seen counts from past attendance.
// Deduplicates by date+venue+city (same logic as the Attended tab display),
// preferring sfm_ records so a TM + sfm_ pair for the same show counts as 1.

// PATCH /weather/bulk — store precomputed weather blobs from Python (SYSTEM only)
router.patch(
  "/weather/bulk",
  [auth, roleCheck(["SYSTEM"])],
  async (req, res) => {
    try {
      const updates = req.body; // [{ id, weather }]
      if (!Array.isArray(updates) || updates.length === 0) {
        return res.status(400).json({ error: "Expected non-empty array of { id, weather }" });
      }

      await Promise.all(
        updates.map(({ id, weather }) =>
          prisma.concert.update({
            where: { id },
            data: { weather },
          })
        )
      );

      res.json({ ok: true, updated: updates.length });
    } catch (error) {
      console.error("Error storing concert weather:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// PATCH /wishlists/:id/bands/:bandId — update tier for a band
router.patch(
  "/wishlists/:id/bands/:bandId",
  [
    auth,
    roleCheck(["ADMIN", "USER"]),
    param("id").isInt().withMessage("Wishlist ID must be an integer"),
    param("bandId").isInt().withMessage("Band ID must be an integer"),
    body("tier").optional().isIn(VALID_TIERS).withMessage("tier must be LOVE, LIKE, or FOLLOW"),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: "Validation failed", details: errors.array() });
      }

      const wishlistId = parseInt(req.params.id, 10);
      const bandId = parseInt(req.params.bandId, 10);
      const { tier } = req.body;

      if (tier === undefined) {
        return res.status(400).json({ error: "Provide tier" });
      }

      // Verify ownership
      const wishlist = await prisma.wishlist.findUnique({ where: { id: wishlistId } });
      if (!wishlist) return res.status(404).json(handleError("wishlist", 404));
      if (wishlist.user_id !== req.user.id) return res.status(403).json(handleError("wishlist", 403));

      const updated = await prisma.wishlistBandReference.update({
        where: { band_wishlist: { band_id: bandId, wishlist_id: wishlistId } },
        data: { tier },
      });


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
    roleCheck(["ADMIN", "USER"]),
    body("name").trim().isLength({ min: 1, max: 100 }).withMessage("Wishlist name must be between 1 and 100 characters"),
    body("discord_webhook").optional({ nullable: true }).custom(validateDiscordWebhook),
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
    body("discord_webhook").optional({ nullable: true }).custom(validateDiscordWebhook),
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
    roleCheck(["ADMIN", "USER"]),
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
          `${process.env.CALLBACK_URL}/data/concerts/bands`,
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
          // Creating the band is this API calling itself over HTTP at
          // CALLBACK_URL, so a stale value there answers with a stranger's 404
          // — which was reported as "Band not found with that Ticketmaster ID"
          // and sent people hunting for a band that was on Ticketmaster all
          // along. Only a JSON { error } body is our own answer and safe to
          // forward; anything else is the call itself failing, not a verdict on
          // the band.
          const upstreamMessage = error.response?.data?.error;
          const status = error.response?.status;
          console.error(
            `Error creating band via ${process.env.CALLBACK_URL}/data/concerts/bands:`,
            status ?? error.code ?? error.message,
            upstreamMessage ?? "",
          );
          if (status && upstreamMessage) {
            return res.status(status).json({ error: upstreamMessage });
          }
          return res.status(502).json({
            error: "Could not reach the band service — check CALLBACK_URL.",
          });
        }
      }

      const existingReference = await prisma.wishlistBandReference.findFirst({
        where: { wishlist_id: wishlistId, band_id: band.id },
      });

      if (existingReference) return res.status(409).json(handleError("wishlist", 409));

      await prisma.wishlistBandReference.create({
        data: { wishlist_id: wishlistId, band_id: band.id, tier },
      });


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
    roleCheck(["ADMIN", "USER"]),
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

module.exports = router;
