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
const { checkDue, checkTarget } = require("../../utils/followChecks");
const { pythonServicePost } = require("../../utils/pythonService");

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
  // The whole bill, not only the acts you wishlisted: the rest of the lineup
  // lives in metadata as plain names, and billForConcert puts the two together.
  metadata: true,
  bands: { select: { band_rel: { select: { id: true, name: true } } } },
  // What the followed-show checker has read off the listing.
  price_min: true,
  price_max: true,
  price_currency: true,
  ticket_vendors: true,
  event_status: true,
  tickets_opened_at: true,
  // And when it last did, for the row to say how fresh that is. The rest is
  // read for the cadence below and dropped from the answer.
  tickets_checked_at: true,
  event_id: true,
  ticket_check_attempted_at: true,
  ticket_check_requested_at: true,
  ticket_check_failures: true,
};

// A run of failures this long is a listing the checker cannot read, rather
// than a page that was slow once.
const FAILING_AFTER = 3;

/**
 * Where the checker is with a followed show, for the row in the app.
 *
 * @returns {{checked_at: Date|null, pending: boolean, hot: boolean, next_at: Date|null, failing: boolean}|null}
 *   null for a show it has no listing to read for
 */
function checkStatus(concert, now) {
  if (!checkTarget(concert)) return null;
  const { requested, hot, next_at } = checkDue(concert, now);
  return {
    checked_at: concert.tickets_checked_at,
    // A "Check now" not yet answered: the row says it is on its way.
    pending: requested,
    hot,
    next_at,
    failing: (concert.ticket_check_failures ?? 0) >= FAILING_AFTER,
  };
}

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
        // The checker's bookkeeping goes the same way, into `check`.
        const {
          metadata, ticket_vendors, event_id, tickets_checked_at,
          ticket_check_attempted_at, ticket_check_requested_at, ticket_check_failures,
          ...concert
        } = concert_rel;
        return {
          concert_id,
          created_at,
          tickets: ticketState(concert_rel, now),
          check: checkStatus(concert_rel, now),
          concert: {
            ...concert,
            vendors: Array.isArray(ticket_vendors) ? ticket_vendors : [],
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
          // And whether it is going ahead, when and where.
          event_status: true, concert_date: true, venue: true,
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
          // Told how things stand, so only a change after this is news.
          status_told: concert.event_status ?? "scheduled",
          date_told: concert.concert_date ?? null,
          venue_told: concert.venue ?? null,
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

// Not asked again within this long of the last read or the last request: the
// listing will not have moved, and a button pressed over and over must not
// become a way to aim this server's scraper at Songkick as fast as a finger.
const RECHECK_FLOOR_MS = 2 * 60 * 1000;

// Its own budget, small: each press can start a browser on the sync service.
const checkLimit = rateLimiter({ max: 6, message: "Checking too often, please wait a minute." });

const startOfDay = (now) => {
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  return day;
};

// POST /notifications/follows/check — read the listings of the shows you
// follow now, rather than on the checker's next turn. One show with
// concert_id, otherwise every one still to come.
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
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    const concertId = req.body?.concert_id != null ? parseInt(req.body.concert_id, 10) : null;

    try {
      const now = new Date();
      const follows = await prisma.concertFollow.findMany({
        where: {
          user_id: req.user.id,
          ...(concertId != null && { concert_id: concertId }),
          concert_rel: { OR: [{ concert_date: null }, { concert_date: { gte: startOfDay(now) } }] },
        },
        select: {
          concert_id: true,
          concert_rel: {
            select: {
              url: true, event_id: true, tickets_checked_at: true,
              ticket_check_requested_at: true, ticket_check_attempted_at: true,
            },
          },
        },
      });
      if (concertId != null && follows.length === 0) {
        return res.status(404).json({ error: "You don't follow that show, or it is over" });
      }

      const recent = (value) => value && now.getTime() - new Date(value).getTime() < RECHECK_FLOOR_MS;
      const ids = follows
        .filter(({ concert_rel: c }) => checkTarget(c) && !recent(c.tickets_checked_at) && !recent(c.ticket_check_requested_at))
        .map((f) => f.concert_id);

      let started = false;
      if (ids.length > 0) {
        await prisma.concert.updateMany({ where: { id: { in: ids } }, data: { ticket_check_requested_at: now } });
        // Asked to start now. If the sync service cannot be reached the
        // request still stands, and its next tick — five minutes at most —
        // finds these first.
        try {
          await pythonServicePost("/check-follows", {}, { timeout: 5000 });
          started = true;
        } catch (err) {
          console.warn("[follows] Could not start the checker now:", err.response?.status ?? err.code ?? err.message);
        }
      }
      res.status(202).json({ requested: ids.length, skipped: follows.length - ids.length, started });
    } catch (error) {
      console.error("Error asking for a check of followed shows:", error);
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
