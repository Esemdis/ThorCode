const express = require("express");
const router = express.Router();
const { body, param, validationResult } = require("express-validator");

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const prisma = require("../../prisma/client");
const { rateLimiter } = require("../../utils/rateLimiter");
const { ticketState } = require("../../utils/ticketState");
const { isTimeZone } = require("../../utils/weeklyRecap");
const { billForConcert } = require("../../utils/concertBill");
const { checkView, checkable, isPending } = require("../../utils/followCheck");
// Through the module, so a test can stand in for the call on this copy of it.
const pythonService = require("../../utils/pythonService");

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

// A followed show as the app lists it, with where its tickets are.
const FOLLOWED_CONCERT = {
  id: true,
  name: true,
  venue: true,
  city: true,
  country: true,
  concert_date: true,
  // The listing to open from the row, and the site to name it after.
  url: true,
  source: true,
  on_sale: true,
  sold_out: true,
  ticket_sale_start: true,
  price_min: true,
  price_max: true,
  price_currency: true,
  // What the followed-show checker last read off the listing (THO-779).
  vendors: true,
  event_status: true,
  tickets_opened_at: true,
  // The whole bill, not only the acts you wishlisted: the rest of the lineup
  // lives in metadata as plain names, and billForConcert puts the two together.
  metadata: true,
  bands: { select: { band_rel: { select: { id: true, name: true } } } },
  // Read for the checker's line and dropped: the id only names the listing,
  // and the check row is answered as `check` beside the show.
  event_id: true,
  listing_check: { select: { checked_at: true, attempted_at: true, requested_at: true, failures: true } },
};

const concertIdParam = param("concertId").isInt({ min: 1 }).withMessage("Invalid concert id");

// Its own budget: following a festival season's worth of shows is a burst of
// small writes, not someone hammering the watch form.
const followLimit = rateLimiter({ max: 60, message: "Too many follows at once, please try again shortly." });

// GET /notifications/follows — the shows you follow for their tickets
router.get(
  "/notifications/follows",
  [auth, roleCheck(["ADMIN", "USER"])],
  async (req, res) => {
    try {
      const follows = await prisma.concertFollow.findMany({
        where: { user_id: req.user.id },
        select: { concert_id: true, created_at: true, concert_rel: { select: FOLLOWED_CONCERT } },
        orderBy: { created_at: "desc" },
      });
      const now = new Date();
      res.json(follows.map(({ concert_id, created_at, concert_rel }) => {
        // metadata is read for the bill and then dropped: the list has no use
        // for the raw column, and on a festival it is the biggest field here.
        const { metadata, event_id: _eventId, listing_check, ...concert } = concert_rel;
        return {
          concert_id,
          created_at,
          tickets: ticketState(concert_rel, now),
          check: checkView(concert_rel, listing_check, now),
          concert: {
            ...concert,
            bands: billForConcert({ bands: concert_rel.bands.map((b) => b.band_rel), metadata }),
          },
        };
      }));
    } catch (error) {
      console.error("Error fetching followed shows:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Its own budget: "Check all now" is one request however many shows, so a
// handful a minute is plenty, and the reads it asks for are Songkick pages.
const checkLimit = rateLimiter({ max: 10, message: "Too many checks at once, please try again shortly." });

// POST /notifications/follows/check — ask for your followed shows' listings to
// be read now: every upcoming one with `{}`, or one with `{ concert_id }`.
// Answers what was asked for; the reads land on the list within about a
// minute, and the client polls GET /notifications/follows until nothing is
// pending.
router.post(
  "/notifications/follows/check",
  [
    auth,
    roleCheck(["ADMIN", "USER"]),
    body("concert_id").optional({ nullable: true }).isInt({ min: 1 }).withMessage("Invalid concert id"),
  ],
  checkLimit,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid concert id" });
    const one = req.body?.concert_id != null ? parseInt(req.body.concert_id, 10) : null;

    try {
      const follows = await prisma.concertFollow.findMany({
        where: { user_id: req.user.id, ...(one != null && { concert_id: one }) },
        select: {
          concert_id: true,
          concert_rel: {
            select: {
              id: true, url: true, event_id: true, concert_date: true,
              listing_check: { select: { attempted_at: true, requested_at: true } },
            },
          },
        },
      });
      if (one != null && follows.length === 0) return res.status(404).json({ error: "You do not follow that show" });

      const now = new Date();
      const wanted = follows.filter(({ concert_rel }) => checkable(concert_rel, concert_rel.listing_check, now));
      const concertIds = wanted.map((f) => f.concert_id);
      for (const { concert_id, concert_rel } of wanted) {
        // One already waiting keeps its first stamp: it is in the queue
        // already, and stamping it again would only move it back.
        // One that waited past PENDING_MAX_MIN was skipped, so it is stamped
        // afresh, or it would stay expired and never be on its way again.
        if (isPending(concert_rel.listing_check, now)) continue;
        await prisma.concertListingCheck.upsert({
          where: { concert_id },
          create: { concert_id, requested_at: now },
          update: { requested_at: now },
        });
      }

      if (concertIds.length > 0 && process.env.PYTHON_SERVICE_URL) {
        // Woken rather than waited on: the sync service's own five-minute tick
        // picks these up anyway, so a wake that fails costs a few minutes and
        // nothing else. Not awaited, so the answer does not wait on it either.
        pythonService.pythonServicePost("/check-follows", {}, { timeout: 5000 })
          .catch((err) => console.warn("[follows/check] could not wake the sync service:", err.code || err.message));
      }
      res.json({ requested: concertIds.length, concert_ids: concertIds });
    } catch (error) {
      console.error("Error asking for followed shows to be checked:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// PUT /notifications/follows/:concertId — follow a show's tickets. Idempotent:
// following one you already follow keeps what you have been told so far.
router.put(
  "/notifications/follows/:concertId",
  [auth, roleCheck(["ADMIN", "USER"]), concertIdParam],
  followLimit,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid concert id" });
    const concertId = parseInt(req.params.concertId, 10);

    try {
      const concert = await prisma.concert.findUnique({
        where: { id: concertId },
        select: {
          id: true, on_sale: true, sold_out: true, ticket_sale_start: true,
          // For the bill to remember, below.
          metadata: true, bands: { select: { band_rel: { select: { name: true } } } },
        },
      });
      if (!concert) return res.status(404).json({ error: "Concert not found" });

      // Told what it is now: following a show that is on sale says nothing
      // until it sells out, and following a festival says nothing about the
      // hundred acts already on its bill — only about what joins it after.
      const tickets = ticketState(concert);
      const bill = billForConcert({
        bands: (concert.bands ?? []).map((ref) => ref.band_rel),
        metadata: concert.metadata,
      }).map((act) => act.name);
      await prisma.concertFollow.upsert({
        where: { user_id_concert_id: { user_id: req.user.id, concert_id: concertId } },
        create: {
          user_id: req.user.id,
          concert_id: concertId,
          told_state: tickets,
          lineup_told: JSON.stringify(bill),
        },
        update: {},
      });

      // The sale-day reminder goes at eight on the follower's own clock, and
      // the only zone saved was the weekly recap's. Without one it was eight
      // UTC, which in Sweden is when the sales open. Kept once set: the zone
      // is the account's, not this browser's.
      if (isTimeZone(req.body?.tz)) {
        const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { settings: true } });
        const settings = user?.settings && typeof user.settings === "object" ? user.settings : {};
        if (!isTimeZone(settings.timeZone)) {
          await prisma.user.update({ where: { id: req.user.id }, data: { settings: { ...settings, timeZone: req.body.tz } } });
        }
      }
      res.json({ concert_id: concertId, tickets });
    } catch (error) {
      console.error("Error following a show:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// DELETE /notifications/follows/:concertId — stop following a show
router.delete(
  "/notifications/follows/:concertId",
  [auth, roleCheck(["ADMIN", "USER"]), concertIdParam],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid concert id" });

    try {
      // Only your own row can match, so there is nothing of anyone else's to refuse.
      await prisma.concertFollow.deleteMany({
        where: { user_id: req.user.id, concert_id: parseInt(req.params.concertId, 10) },
      });
      res.json({ message: "Unfollowed" });
    } catch (error) {
      console.error("Error unfollowing a show:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

module.exports = router;
