/**
 * Every festival still to come, for the Updates panel's Festivals list.
 *
 * All of them, not only the ones your bands play: the list is for finding a
 * festival, and which of yours are on each is marked on it. The grouping is
 * utils/festivals.js.
 */
const express = require("express");
const router = express.Router();
const { validationResult, param } = require("express-validator");
const auth = require("../../../auth/verifyJWT");
const roleCheck = require("../../../middlewares/roleCheck");
const prisma = require("../../../prisma/client");
const { MIN_ACTS, SONGKICK_FESTIVAL, touringRows, groupFestivals } = require("../../../utils/festivals");
const { ownWishlist } = require("./shared");

const contains = (field, text) => ({ [field]: { contains: text, mode: "insensitive" } });

// GET /wishlists/:id/festivals — every festival still to come, your bands on each
router.get(
  "/wishlists/:id/festivals",
  [auth, roleCheck(["ADMIN", "USER"]), param("id").isInt().withMessage("Wishlist ID must be an integer")],
  async (req, res) => {
    try {
      if (!validationResult(req).isEmpty()) return res.status(400).json({ error: "Wishlist ID must be an integer" });
      const wishlist = await ownWishlist(req, res, { select: { bands: { select: { band_id: true, tier: true } } } });
      if (!wishlist) return;

      // By calendar day, as the rest of the app reads "still to come": a show
      // tonight with no start time is stored at midnight and is not over.
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);

      const [crowded, watches] = await Promise.all([
        // A festival that only Bandsintown lists is a row per act, merged
        // into one, and nothing on the way flags it as a festival.
        prisma.$queryRaw`
          SELECT r."concert" AS id
          FROM "ConcertBandReference" r
          JOIN "Concert" c ON c."id" = r."concert"
          WHERE c."concert_date" >= ${today}
          GROUP BY r."concert"
          HAVING COUNT(*) >= ${MIN_ACTS}
        `,
        // A festival you are watching is one by your own say, and early on
        // it can be a single act's page that nothing else would mark.
        prisma.notificationSubscription.findMany({
          where: { user_id: req.user.id, tour_query: { not: null } },
          select: { tour_query: true, venue_query: true },
        }),
      ]);

      const watchClauses = watches.map((w) => ({
        AND: [
          { OR: [contains("name", w.tour_query), contains("venue", w.tour_query)] },
          ...(w.venue_query ? [contains("venue", w.venue_query)] : []),
        ],
      }));

      const concerts = await prisma.concert.findMany({
        where: {
          AND: [
            { OR: [{ concert_date: null }, { concert_date: { gte: today } }] },
            {
              OR: [
                { festival: true },
                contains("url", SONGKICK_FESTIVAL),
                ...(crowded.length ? [{ id: { in: crowded.map((r) => Number(r.id)) } }] : []),
                ...watchClauses,
              ],
            },
          ],
        },
        select: {
          id: true,
          name: true,
          venue: true,
          city: true,
          country: true,
          concert_date: true,
          url: true,
          metadata: true,
          festival: true,
          on_sale: true,
          sold_out: true,
          ticket_sale_start: true,
          // Two rows of one festival are told apart from two festivals partly
          // by where they are.
          latitude: true,
          longitude: true,
          bands: { select: { band_rel: { select: { id: true, name: true } } } },
        },
      });

      const has = (text, needle) => typeof text === "string" && text.toLowerCase().includes(needle.toLowerCase());
      const watched = (concert) => watches.some((w) =>
        (has(concert.name, w.tour_query) || has(concert.venue, w.tour_query))
        && (!w.venue_query || has(concert.venue, w.venue_query)));

      // A Songkick festival link is the weakest of the signals above: Songkick
      // files some tours as festivals. Where it is all a row has, and the row
      // looks like a tour, it is left out.
      const crowdedIds = new Set(crowded.map((r) => Number(r.id)));
      const touring = touringRows(concerts);
      const festivals = concerts.filter((c) => !touring.has(c.id) || c.festival || crowdedIds.has(c.id) || watched(c));

      const tiers = new Map(wishlist.bands.map((b) => [b.band_id, b.tier]));
      res.json({ festivals: groupFestivals(festivals, { tiers, watched }) });
    } catch (error) {
      console.error("Error listing festivals:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

module.exports = router;
