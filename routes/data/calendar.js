// Calendar output: the subscribable Going feed, and the single-concert download
// behind the button in the app.
//
// The feed route is the only route in this API with no auth middleware. That is
// not an oversight — see the note on it below.

const express = require("express");
const router = express.Router();
const { param, validationResult } = require("express-validator");

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const { rateLimiter } = require("../../utils/rateLimiter");
const prisma = require("../../prisma/client");
const { concertToIcs, concertsToIcs, icsFilename } = require("../../utils/ics");

// Everything the .ics needs and nothing else. `metadata` carries the support
// acts that never made it onto a wishlist, which are half the bill on most
// bookings.
const CONCERT_SELECT = {
  id: true,
  event_id: true,
  name: true,
  venue: true,
  city: true,
  country: true,
  concert_date: true,
  url: true,
  metadata: true,
  price_min: true,
  price_max: true,
  price_currency: true,
  bands: { select: { band_rel: { select: { id: true, name: true } } } },
};

/** Prisma row -> the shape utils/ics.js reads. */
function toConcert(row) {
  return {
    ...row,
    participating_bands: (row.bands ?? []).map((b) => b.band_rel).filter(Boolean),
  };
}

// Calendar clients poll unattended, several devices can sit behind one IP, and
// a rate-limited calendar fails silently rather than telling anyone. So this is
// far looser than a user-facing route.
const feedLimiter = rateLimiter({
  message: "Too many calendar feed requests, please try again later.",
  windowMs: 60 * 60 * 1000,
  max: 120,
});

/**
 * GET /data/concerts/calendar/feed/:token/going.ics
 *
 * No auth middleware, deliberately: Google, Apple and Outlook fetch a feed on a
 * schedule with no Authorization header, so the token in the path is the whole
 * credential. Consequences that have to hold:
 *
 * - An unknown token answers 404, never 403. A 403 would confirm the token
 *   exists, which turns guessing into a two-step problem.
 * - The token is never echoed into a response or a log line.
 */
router.get("/calendar/feed/:token/going.ics", feedLimiter, async (req, res) => {
  try {
    const { token } = req.params;
    const wishlist = await prisma.wishlist.findUnique({
      where: { calendar_token: token },
      select: { id: true },
    });
    if (!wishlist) return res.status(404).json({ error: "Not found" });

    // Upcoming is a calendar-day comparison, not an instant one. A concert
    // scraped without a start time is stored at 00:00Z, so comparing instants
    // would drop tonight's gig from the feed the moment the day began.
    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);

    const records = await prisma.concertAttendance.findMany({
      where: {
        wishlist_id: wishlist.id,
        concert_rel: { concert_date: { gte: startOfToday } },
      },
      orderBy: { concert_rel: { concert_date: "asc" } },
      include: { concert_rel: { select: CONCERT_SELECT } },
    });

    const ics = concertsToIcs(records.map((r) => toConcert(r.concert_rel)));

    res.set({
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="going-concerts.ics"',
      // Clients poll on their own schedule; this only stops a burst of refetches
      // from one client hitting the database every time.
      "Cache-Control": "private, max-age=3600",
    });
    return res.send(ics);
  } catch (error) {
    console.error("Error building calendar feed:", error);
    return res.status(500).json({ error: "Failed to build calendar feed" });
  }
});

/**
 * GET /data/concerts/calendar/event/:id/concert.ics
 *
 * The per-concert download. Ordinary JWT auth — no token involved. Concerts are
 * not user-scoped, so there is nothing to own here beyond being signed in.
 */
router.get(
  "/calendar/event/:id/concert.ics",
  [auth, roleCheck(["ADMIN", "USER"]), param("id").isInt().withMessage("Concert ID must be an integer")],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const row = await prisma.concert.findUnique({
        where: { id: parseInt(req.params.id, 10) },
        select: CONCERT_SELECT,
      });
      if (!row) return res.status(404).json({ error: "Not found" });

      const concert = toConcert(row);
      const ics = concertToIcs(concert);
      // No date means no event to place — the caller asked for something that
      // cannot exist rather than something that went wrong.
      if (!ics) return res.status(422).json({ error: "Concert has no date" });

      res.set({
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": `attachment; filename="${icsFilename(concert)}"`,
      });
      return res.send(ics);
    } catch (error) {
      console.error("Error building concert calendar event:", error);
      return res.status(500).json({ error: "Failed to build calendar event" });
    }
  },
);

module.exports = router;
