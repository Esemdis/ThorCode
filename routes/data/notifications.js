const express = require("express");
const router = express.Router();
const { body, param, validationResult } = require("express-validator");

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const prisma = require("../../prisma/client");
const { rateLimiter } = require("../../utils/rateLimiter");

const rateLimit = rateLimiter({
  message: "Too many requests to the notifications route, please try again later.",
});

// GET /notifications/subscriptions — list the current user's concert-notification watches
router.get(
  "/notifications/subscriptions",
  [auth, roleCheck(["ADMIN", "USER"])],
  async (req, res) => {
    try {
      const subscriptions = await prisma.notificationSubscription.findMany({
        where: { user_id: req.user.id },
        include: {
          band_rel: { select: { id: true, name: true } },
          city_rel: { select: { id: true, name: true, country: true } },
        },
        orderBy: { created_at: "desc" },
      });
      res.json(subscriptions);
    } catch (error) {
      console.error("Error fetching notification subscriptions:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// POST /notifications/subscriptions — watch a band, a city, a band-in-a-city
// combo, or a tour/festival by name (optionally narrowed to a venue)
router.post(
  "/notifications/subscriptions",
  [
    auth,
    roleCheck(["ADMIN", "USER"]),
    body("band_id").optional({ nullable: true }).isInt().withMessage("band_id must be an integer"),
    body("city_id").optional({ nullable: true }).isInt().withMessage("city_id must be an integer"),
    // Two characters minimum on both: these are matched as substrings, so a
    // single letter is a subscription to very nearly everything. trim() runs
    // before isLength and rewrites req.body, so a blank box is rejected here
    // rather than stored as "" and matched against every concert there is.
    body("tour_query").optional({ nullable: true }).isString().trim().isLength({ min: 2 })
      .withMessage("tour_query must be at least 2 characters"),
    body("venue_query").optional({ nullable: true }).isString().trim().isLength({ min: 2 })
      .withMessage("venue_query must be at least 2 characters"),
  ],
  rateLimit,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const bandId = req.body.band_id != null ? parseInt(req.body.band_id, 10) : null;
    const cityId = req.body.city_id != null ? parseInt(req.body.city_id, 10) : null;
    const tourQuery = req.body.tour_query ?? null;
    const venueQuery = req.body.venue_query ?? null;

    if (bandId == null && cityId == null && tourQuery == null) {
      return res.status(400).json({ error: "Provide at least one of band_id, city_id or tour_query" });
    }
    // The two shapes stay apart. subscriptionMatches answers a tour watch from
    // the event name alone, so a band or city sent alongside would be accepted
    // here and then silently ignored at match time.
    if (tourQuery != null && (bandId != null || cityId != null)) {
      return res.status(400).json({ error: "tour_query cannot be combined with band_id or city_id" });
    }
    if (venueQuery != null && tourQuery == null) {
      return res.status(400).json({ error: "venue_query only narrows a tour_query watch" });
    }

    try {
      if (bandId != null) {
        const band = await prisma.band.findUnique({ where: { id: bandId } });
        if (!band) return res.status(404).json({ error: "Band not found" });
      }
      if (cityId != null) {
        const city = await prisma.city.findUnique({ where: { id: cityId } });
        if (!city) return res.status(404).json({ error: "City not found" });
      }

      const existing = await prisma.notificationSubscription.findFirst({
        where: {
          user_id: req.user.id,
          band_id: bandId,
          city_id: cityId,
          tour_query: tourQuery,
          venue_query: venueQuery,
        },
      });
      if (existing) return res.status(409).json({ error: "You already have this subscription" });

      const subscription = await prisma.notificationSubscription.create({
        data: { user_id: req.user.id, band_id: bandId, city_id: cityId, tour_query: tourQuery, venue_query: venueQuery },
        include: {
          band_rel: { select: { id: true, name: true } },
          city_rel: { select: { id: true, name: true, country: true } },
        },
      });
      res.status(201).json(subscription);
    } catch (error) {
      console.error("Error creating notification subscription:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// DELETE /notifications/subscriptions/:id
router.delete(
  "/notifications/subscriptions/:id",
  [auth, roleCheck(["ADMIN", "USER"]), param("id").isInt().withMessage("Invalid id")],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid id" });

    try {
      const subscription = await prisma.notificationSubscription.findUnique({
        where: { id: parseInt(req.params.id, 10) },
      });
      if (!subscription) return res.status(404).json({ error: "Subscription not found" });
      if (subscription.user_id !== req.user.id) return res.status(403).json({ error: "Forbidden" });

      await prisma.notificationSubscription.delete({ where: { id: subscription.id } });
      res.json({ message: "Subscription deleted" });
    } catch (error) {
      console.error("Error deleting notification subscription:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

module.exports = router;
