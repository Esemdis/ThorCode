/**
 * Reading wishlists and what is on them.
 *
 * Split out of routes/data/wishlists.js, which had grown to 1473 lines and
 * twenty-one endpoints. wishlists.js mounts this and its siblings in their
 * original declaration order — the manifest test in wishlists.test.js pins
 * the resulting surface.
 */
const express = require("express");
const router = express.Router();
const { validationResult, param, body } = require("express-validator");
const { handleError } = require("../helpers");
const { deduplicateConcerts } = require("../../../utils/concertDedup");
const { groupConcertsByBand } = require("../../../utils/concertUpdateGroups");
const auth = require("../../../auth/verifyJWT");
const roleCheck = require("../../../middlewares/roleCheck");
const prisma = require("../../../prisma/client");
const { rateLimit } = require("./shared");

// Deduplicates by date+venue+city (same logic as the Attended tab display),
// preferring sfm_ records so a TM + sfm_ pair for the same show counts as 1.
async function computeSeenCounts(wishlistId) {
  const attendances = await prisma.concertAttendance.findMany({
    where: {
      wishlist_id: wishlistId,
      concert_rel: { concert_date: { lt: new Date() } },
    },
    select: {
      concert_id: true,
      concert_rel: {
        select: {
          event_id: true,
          concert_date: true,
          venue: true,
          city: true,
          bands: { select: { band: true } },
        },
      },
    },
  });

  // Sort sfm_ first so they win deduplication
  attendances.sort((a, b) => {
    const aS = a.concert_rel.event_id?.startsWith('sfm_') ? 0 : 1;
    const bS = b.concert_rel.event_id?.startsWith('sfm_') ? 0 : 1;
    return aS - bS;
  });

  const deduped = new Map(); // "date|venue|city" -> attendance
  for (const a of attendances) {
    const c = a.concert_rel;
    const day = c.concert_date ? new Date(c.concert_date).toISOString().slice(0, 10) : 'unknown';
    const key = `${day}|${c.venue ?? ''}|${c.city ?? ''}`;
    if (!deduped.has(key)) deduped.set(key, a);
  }

  const seenCountMap = new Map();
  for (const a of deduped.values()) {
    for (const b of a.concert_rel.bands) {
      seenCountMap.set(b.band, (seenCountMap.get(b.band) || 0) + 1);
    }
  }
  return seenCountMap;
}

// GET /wishlists — list the user's single wishlist
router.get(
  "/wishlists",
  [auth, roleCheck(["ADMIN", "USER"])],
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

          const seenCountMap = await computeSeenCounts(wishlist.id);

          return {
            id: wishlist.id,
            bands: wishlist.bands.map((b) => ({ ...b, times_seen: seenCountMap.get(b.band_id) ?? 0 })),
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

// GET /wishlists/bands — just the caller's own bands: id, name, tier.
//
// Must stay ahead of GET /wishlists/:id, which validates its id as an integer
// and would answer 400 for every call to this. /wishlists/raw above sits here
// for the same reason, and wishlists.test.js pins both orderings.
//
// Exists because the two callers that want "which bands are mine" were paying
// for GET /wishlists/:id to find out — a route that loads every band's entire
// concert history, with weather, prices and city relations, to produce a set of
// ids. No path parameter on purpose: Wishlist.user_id is unique, so the token
// alone decides whose bands come back.
router.get(
  "/wishlists/bands",
  [auth, roleCheck(["ADMIN", "USER"])],
  async (req, res) => {
    try {
      const refs = await prisma.wishlistBandReference.findMany({
        where: { wishlist_rel: { user_id: req.user.id } },
        select: { tier: true, band_rel: { select: { id: true, name: true } } },
        orderBy: { band_rel: { name: "asc" } },
      });
      res.json(refs.map((ref) => ({ id: ref.band_rel.id, name: ref.band_rel.name, tier: ref.tier })));
    } catch (error) {
      console.error("Error fetching wishlist bands:", error);
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
              price_min: true,
              price_max: true,
              price_currency: true,
              sold_out: true,
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

// GET /wishlists/:id/recent-concerts — newest future concerts for this wishlist, grouped by band.
// Fetches far more rows than it returns: a single band announcing a long tour used to
// occupy every row of a flat top-30, so the window has to be wide enough that other
// bands survive the grouping.
router.get(
  "/wishlists/:id/recent-concerts",
  [auth, roleCheck(["ADMIN", "USER"]), param("id").isInt().withMessage("Wishlist ID must be an integer")],
  async (req, res) => {
    try {
      const wishlistId = parseInt(req.params.id, 10);
      const wishlist = await prisma.wishlist.findUnique({
        where: { id: wishlistId },
        include: { bands: { select: { band_id: true, tier: true } } },
      });
      if (!wishlist) return res.status(404).json({ error: "Not found" });
      if (wishlist.user_id !== req.user.id) return res.status(403).json({ error: "Forbidden" });

      const wishlistBandMap = new Map(wishlist.bands.map((b) => [b.band_id, b.tier]));
      const bandIds = [...wishlistBandMap.keys()];

      const concerts = await prisma.concert.findMany({
        where: {
          concert_date: { gte: new Date() },
          bands: { some: { band: { in: bandIds } } },
        },
        orderBy: { created_at: "desc" },
        take: 300,
        select: {
          id: true,
          name: true,
          city: true,
          country: true,
          venue: true,
          concert_date: true,
          url: true,
          festival: true,
          created_at: true,
          latitude: true,
          longitude: true,
          bands: {
            where: { band: { in: bandIds } },
            select: { band_rel: { select: { id: true, name: true } } },
          },
        },
      });

      const result = concerts.map((c) => ({
        ...c,
        participating_bands: c.bands.map((b) => ({
          id: b.band_rel.id,
          name: b.band_rel.name,
          tier: wishlistBandMap.get(b.band_rel.id),
        })),
      }));

      res.json({ groups: groupConcertsByBand(result) });
    } catch (error) {
      console.error("Error fetching recent concerts:", error);
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
  [auth, roleCheck(["ADMIN", "USER"]), param("id").isInt().withMessage("Wishlist ID must be an integer")],
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

      if (wishlist.user_id !== req.user.id && req.user.role !== 'ADMIN') {
        return res.status(403).json(handleError("wishlist", 403));
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
                  price_min: true,
                  price_max: true,
                  price_currency: true,
                  sold_out: true,
                  festival: true,
                  source: true,
                  url: true,
                  weather: true,
                  reachable: true,
                  city_rel: {
                    // `reachable` is the only field the client reads off this
                    // relation. airport_iata and weather_monthly rode along on
                    // every concert in the payload without a single consumer —
                    // and airport_iata has no producer either: nothing writes it
                    // but PATCH /data/cities/:id, by hand.
                    select: {
                      id: true,
                      reachable: true,
                    },
                  },
                  bands: {
                    include: {
                      band_rel: {
                        // No setlist here. It belongs to the band, so selecting
                        // it on the concert join pulled the same blob once per
                        // concert the band plays — 1532 rows for 85 setlists on
                        // live data. It is sent once in `bands` below instead.
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
              price_min: concert.price_min,
              price_max: concert.price_max,
              price_currency: concert.price_currency,
              sold_out: concert.sold_out,
              festival: concert.festival,
              source: concert.source,
              url: concert.url,
              weather: concert.weather,
              reachable: concert.reachable ?? null,
              city_rel: concert.city_rel ?? null,
              participating_bands: wishlistBands,
              wishlist_band_count: wishlistBands.length,
            });
          }
        });

        const concertsList = Array.from(concertsMap.values());
        return { id: band.id, name: band.name, concerts: concertsList, concertCount: concertsList.length };
      });

      const seenCountMap = await computeSeenCounts(wishlistId);



      // Deduplicated concerts across all bands (by id first)
      const allConcerts = new Map();
      formattedBands.forEach((band) => {
        band.concerts.forEach((concert) => {
          if (!allConcerts.has(concert.id)) allConcerts.set(concert.id, concert);
        });
      });

      const concertsArray = deduplicateConcerts([...allConcerts.values()]);

      // Which bands the caller is actually being shown, so the setlists below
      // can be limited to them.
      const bandsOnScreen = new Set();
      for (const c of concertsArray) {
        for (const b of c.participating_bands ?? []) bandsOnScreen.add(b.id);
      }

      // Simplified bands array with tier and seen count
      const simplifiedBands = wishlist.bands.map((ref) => ({
        id: ref.band_rel.id,
        name: ref.band_rel.name,
        mbid: ref.band_rel.MBID ?? null,
        concertCount: formattedBands.find((b) => b.id === ref.band_id)?.concertCount ?? 0,
        tier: ref.tier,
        times_seen: seenCountMap.get(ref.band_id) ?? 0,
        songkick_url: ref.band_rel.songkick_url ?? null,
        bandsintown_url: ref.band_rel.bandsintown_url ?? null,
        // The band's setlist, sent once, and only when the band actually
        // appears in the concerts below. Sending every wishlist band's setlist
        // regardless made a narrow date range heavier than it was before the
        // dedup — most of a one-week payload was setlists for bands playing
        // nothing that week.
        setlist: bandsOnScreen.has(ref.band_rel.id) ? (ref.band_rel.setlist ?? null) : null,
      }));

      res.json({
        id: wishlist.id,
        name: wishlist.name,
        user_id: wishlist.user_id,
        discord_webhook: wishlist.discord_webhook,
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

module.exports = router;
