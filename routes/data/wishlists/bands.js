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
// Called through the module rather than destructured, so a test can stand in
// for band creation (which reaches MusicBrainz) on the router's own copy.
const bandCreate = require("../../../utils/bandCreate");
const auth = require("../../../auth/verifyJWT");
const roleCheck = require("../../../middlewares/roleCheck");
const prisma = require("../../../prisma/client");
const { rateLimit, ownWishlist } = require("./shared");
const { RECORD_NOT_FOUND } = require("../../../utils/apiResponse");

const VALID_TIERS = ["LOVE", "LIKE", "FOLLOW"];

const BULK_CHUNK = 25;
const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

// Discord's own webhook host+path shape — anything else lets a user aim the
// server's outbound POST at an internal address (SSRF) via /wishlists/notify.
const DISCORD_WEBHOOK_RE = /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/;
function validateDiscordWebhook(value) {
  if (!DISCORD_WEBHOOK_RE.test(value)) {
    throw new Error("Discord webhook must be a valid https://discord.com/api/webhooks/... URL");
  }
  return true;
}

const NOT_ON_WISHLIST = { error: "That band is not on this wishlist." };
const ALREADY_ON_WISHLIST = { error: "That band is already on this wishlist." };
const SERVER_ERROR = { error: "Internal server error" };

// PATCH /weather/bulk — store precomputed weather blobs from Python (SYSTEM only)
router.patch(
  "/weather/bulk",
  [auth, roleCheck(["SYSTEM"])],
  async (req, res) => {
    const updates = req.body; // [{ id, weather }]
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: "Expected non-empty array of { id, weather }" });
    }
    if (!updates.every((u) => u && Number.isInteger(u.id))) {
      return res.status(400).json({ error: "Every entry needs an integer id" });
    }

    // In chunks, each its own transaction — the shape trips' weather bulk
    // already has. One unbounded Promise.all opened an update per concert at
    // once against a pool of thirty, and a single missing id failed the
    // request after an arbitrary subset had been written.
    let updated = 0;
    try {
      for (const chunk of chunks(updates, BULK_CHUNK)) {
        await prisma.$transaction(chunk.map(({ id, weather }) =>
          prisma.concert.updateMany({ where: { id }, data: { weather } })));
        updated += chunk.length;
      }
      res.json({ ok: true, updated });
    } catch (error) {
      console.error(`Error storing concert weather after ${updated}/${updates.length}:`, error);
      return res.status(500).json({ error: "Internal server error", updated });
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

      if (!(await ownWishlist(req, res, { select: { id: true } }))) return;

      const updated = await prisma.wishlistBandReference.update({
        where: { band_wishlist: { band_id: bandId, wishlist_id: wishlistId } },
        data: { tier },
      });

      res.json(updated);
    } catch (error) {
      // A band that is not on the list has no tier to change. The update
      // reports that as "record not found", which was answered as a 500.
      if (error.code === RECORD_NOT_FOUND) return res.status(404).json(NOT_ON_WISHLIST);
      console.error("Error updating band in wishlist:", error);
      return res.status(500).json(SERVER_ERROR);
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
      const findExisting = () => prisma.wishlist.findUnique({ where: { user_id: req.user.id }, include: { bands: true } });
      const existing = await findExisting();
      if (existing) return res.status(200).json(existing);

      const { name, discord_webhook } = req.body;

      try {
        const newWishlist = await prisma.wishlist.create({
          data: {
            name: name.trim(),
            user_id: req.user.id,
            discord_webhook: discord_webhook || null,
          },
          include: { bands: true },
        });
        return res.status(201).json(newWishlist);
      } catch (error) {
        // Two creates that overlap both pass the read above, and user_id is
        // unique, so the second insert fails. It was answered as a 500 on a
        // wishlist that had just been made; the one that won is the answer.
        if (error.code !== "P2002") throw error;
        const winner = await findExisting();
        if (!winner) throw error;
        return res.status(200).json(winner);
      }
    } catch (error) {
      console.error("Error creating wishlist:", error);
      return res.status(500).json(SERVER_ERROR);
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

      if (!(await ownWishlist(req, res, { select: { id: true } }))) return;

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
      return res.status(500).json(SERVER_ERROR);
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
    body("name").optional().isString().trim().notEmpty().withMessage("Band name must be a non-empty string"),
    body("ticketmaster_id").optional().isString().trim().notEmpty().withMessage("Ticketmaster ID must be a non-empty string"),
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

      if (!(await ownWishlist(req, res, { select: { id: true } }))) return;

      // Created in-process. This used to be the API calling itself over HTTP
      // at CALLBACK_URL with the caller's token, so a stale CALLBACK_URL broke
      // adding bands outright, and every user's adds arrived from the server's
      // own address and shared one rate-limit bucket on POST /bands.
      let band;
      let lookupWarning = null;
      if (bandName) {
        try {
          const created = await bandCreate.createBand(bandName);
          band = created.band;
          // Carried through rather than dropped: MusicBrainz being unreachable
          // is what made "added, but with no links and so no concerts" look
          // identical to a clean add.
          lookupWarning = created.warning;
        } catch (error) {
          if (!(error instanceof bandCreate.BandExistsError)) throw error;
          band = error.band;
        }
      } else {
        // A Ticketmaster id alone can only name a band that is already here:
        // bands are created by name, from MusicBrainz, and that source is gone.
        band = await prisma.band.findUnique({ where: { ticketmaster_id: ticketmasterId } });
        if (!band) {
          return res.status(404).json({ error: "No band with that Ticketmaster ID — add it by name instead" });
        }
      }

      const existingReference = await prisma.wishlistBandReference.findFirst({
        where: { wishlist_id: wishlistId, band_id: band.id },
      });

      if (existingReference) return res.status(409).json(ALREADY_ON_WISHLIST);

      try {
        await prisma.wishlistBandReference.create({
          data: { wishlist_id: wishlistId, band_id: band.id, tier },
        });
      } catch (error) {
        // The same add twice at once (a double tap) passes the check above
        // together; the second one is this conflict, not a 500.
        if (error.code === "P2002") return res.status(409).json(ALREADY_ON_WISHLIST);
        throw error;
      }

      res.status(201).json({
        message: "Band added to wishlist successfully",
        band: { id: band.id, name: band.name, ticketmaster_id: band.ticketmaster_id },
        ...(lookupWarning && { warning: lookupWarning }),
      });
    } catch (error) {
      console.error("Error adding band to wishlist:", error);
      return res.status(500).json(SERVER_ERROR);
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

      if (!(await ownWishlist(req, res, { select: { id: true } }))) return;

      const existingReference = await prisma.wishlistBandReference.findFirst({
        where: { wishlist_id: wishlistId, band_id: bandId },
      });

      if (!existingReference) return res.status(404).json(NOT_ON_WISHLIST);

      await prisma.wishlistBandReference.delete({ where: { id: existingReference.id } });

      res.json({ message: "Band removed from wishlist successfully" });
    } catch (error) {
      console.error("Error removing band from wishlist:", error);
      return res.status(500).json(SERVER_ERROR);
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
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: "Validation failed", details: errors.array() });
      }

      const wishlistId = parseInt(req.params.id, 10);
      if (!(await ownWishlist(req, res, { select: { id: true } }))) return;

      // Shows attended hang off the wishlist, and photographs off them — the
      // key restricts on purpose (see utils/mediaDetach.js). Refused in words
      // rather than by the foreign key as a 500.
      const attended = await prisma.concertAttendance.count({ where: { wishlist_id: wishlistId } });
      if (attended > 0) {
        return res.status(409).json({
          error: `This wishlist has ${attended} attended show${attended === 1 ? "" : "s"}. Remove them first.`,
        });
      }

      // The activity log restricts too, and nothing else ever deletes it, so
      // any wishlist that had seen a new concert could not be deleted at all.
      // One transaction, so a failure leaves the wishlist as it was.
      await prisma.$transaction([
        prisma.activityLog.deleteMany({ where: { wishlist_id: wishlistId } }),
        prisma.wishlistBandReference.deleteMany({ where: { wishlist_id: wishlistId } }),
        prisma.wishlist.delete({ where: { id: wishlistId } }),
      ]);

      res.json({ message: "Wishlist deleted successfully." });
    } catch (error) {
      console.error("Error deleting wishlist:", error);
      return res.status(500).json(SERVER_ERROR);
    }
  }
);

module.exports = router;
