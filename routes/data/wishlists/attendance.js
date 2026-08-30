/**
 * Shows you went to.
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
const auth = require("../../../auth/verifyJWT");
const roleCheck = require("../../../middlewares/roleCheck");
const prisma = require("../../../prisma/client");
const { storesRealInstant } = require("../../../utils/ics");

// GET /wishlists/:id/attendance — all attended/going concerts for this wishlist
router.get(
  "/wishlists/:id/attendance",
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

      const bandTierMap = new Map(wishlist.bands.map((b) => [b.band_id, b.tier]));
      const bandIds = [...bandTierMap.keys()];

      const filterBandId = req.query.band_id ? parseInt(req.query.band_id, 10) : null;

      const records = await prisma.concertAttendance.findMany({
        where: {
          wishlist_id: wishlistId,
          ...(filterBandId ? { concert_rel: { bands: { some: { band: filterBandId } } } } : {}),
        },
        orderBy: { concert_rel: { concert_date: "desc" } },
        include: {
          concert_rel: {
            select: {
              id: true,
              event_id: true,
              name: true,
              venue: true,
              city: true,
              country: true,
              concert_date: true,
              url: true,
              festival: true,
              // The support acts on the bill: bands nobody put on a wishlist
              // live only here. Without it concertLineup finds no extra names
              // and half a festival lineup is invisible in the app.
              metadata: true,
              // Read to derive time_is_instant below; not returned raw, so no
              // client grows its own copy of the per-source rule.
              source: true,
              latitude: true,
              longitude: true,
              on_sale: true,
              sold_out: true,
              price_min: true,
              price_max: true,
              price_currency: true,
              weather: true,
              bands: {
                where: { band: { in: bandIds } },
                select: { setlist: true, band_rel: { select: { id: true, name: true } } },
              },
            },
          },
        },
      });

      const result = records.map((r) => ({
        attendance_id: r.id,
        created_at: r.created_at,
        concert: {
          ...r.concert_rel,
          source: undefined,
          // concert_date does not mean the same thing for every row: some
          // sources store a true UTC instant, others the venue's wall clock
          // wearing a Z. The client cannot render a time correctly without
          // knowing which, and deriving it here keeps that rule in one place.
          time_is_instant: storesRealInstant(r.concert_rel.source),
          participating_bands: r.concert_rel.bands.map((b) => ({
            id: b.band_rel.id,
            name: b.band_rel.name,
            tier: bandTierMap.get(b.band_rel.id) ?? null,
            setlist: b.setlist ?? null,
          })),
        },
      }));

      res.json({ attendance: result });
    } catch (error) {
      console.error("Error fetching attendance:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// POST /wishlists/:id/attendance — mark a concert as going/attended
router.post(
  "/wishlists/:id/attendance",
  [
    auth,
    roleCheck(["ADMIN", "USER"]),
    param("id").isInt().withMessage("Wishlist ID must be an integer"),
    body("concert_id").isInt().withMessage("concert_id must be an integer"),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: "Validation failed", details: errors.array() });

      const wishlistId = parseInt(req.params.id, 10);
      const concertId = parseInt(req.body.concert_id, 10);

      const wishlist = await prisma.wishlist.findUnique({
        where: { id: wishlistId },
        include: { bands: { select: { band_id: true } } },
      });
      if (!wishlist) return res.status(404).json({ error: "Not found" });
      if (wishlist.user_id !== req.user.id) return res.status(403).json({ error: "Forbidden" });

      const concert = await prisma.concert.findUnique({
        where: { id: concertId },
        select: { id: true, concert_date: true, bands: { select: { band: true } } },
      });
      if (!concert) return res.status(404).json({ error: "Concert not found" });

      const attendance = await prisma.concertAttendance.upsert({
        where: { wishlist_id_concert_id: { wishlist_id: wishlistId, concert_id: concertId } },
        create: { wishlist_id: wishlistId, concert_id: concertId },
        update: {},
      });

      res.json({ attendance_id: attendance.id });
    } catch (error) {
      console.error("Error adding attendance:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// DELETE /wishlists/:id/attendance/:concertId — unmark a concert
router.delete(
  "/wishlists/:id/attendance/:concertId",
  [
    auth,
    roleCheck(["ADMIN", "USER"]),
    param("id").isInt().withMessage("Wishlist ID must be an integer"),
    param("concertId").isInt().withMessage("Concert ID must be an integer"),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: "Validation failed", details: errors.array() });

      const wishlistId = parseInt(req.params.id, 10);
      const concertId = parseInt(req.params.concertId, 10);

      const wishlist = await prisma.wishlist.findUnique({
        where: { id: wishlistId },
        include: { bands: { select: { band_id: true } } },
      });
      if (!wishlist) return res.status(404).json({ error: "Not found" });
      if (wishlist.user_id !== req.user.id) return res.status(403).json({ error: "Forbidden" });

      const attendance = await prisma.concertAttendance.findUnique({
        where: { wishlist_id_concert_id: { wishlist_id: wishlistId, concert_id: concertId } },
      });
      if (!attendance) return res.status(404).json({ error: "Attendance record not found" });

      await prisma.concertAttendance.delete({ where: { id: attendance.id } });

      res.json({ deleted: true });
    } catch (error) {
      console.error("Error removing attendance:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// POST /wishlists/:id/attendance/from-setlist — add a past concert from Setlist.fm history
router.post(
  "/wishlists/:id/attendance/from-setlist",
  [
    auth,
    roleCheck(["ADMIN", "USER"]),
    param("id").isInt().withMessage("Wishlist ID must be an integer"),
    body("setlistfm_id").isString().notEmpty(),
    body("date").isString().notEmpty(),
    body("venue").isString().notEmpty(),
    body("city").isString().notEmpty(),
    body("country").isString().notEmpty(),
    body("band_id").isInt().withMessage("band_id must be an integer"),
    body("latitude").optional({ nullable: true }).isFloat().withMessage("latitude must be a number"),
    body("longitude").optional({ nullable: true }).isFloat().withMessage("longitude must be a number"),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: "Validation failed", details: errors.array() });

      const wishlistId = parseInt(req.params.id, 10);
      const { setlistfm_id, date, venue, city, country, band_id, url, songs, latitude, longitude } = req.body;
      const bandId = parseInt(band_id, 10);

      const wishlist = await prisma.wishlist.findUnique({
        where: { id: wishlistId },
        include: { bands: { select: { band_id: true } } },
      });
      if (!wishlist) return res.status(404).json({ error: "Not found" });
      if (wishlist.user_id !== req.user.id) return res.status(403).json({ error: "Forbidden" });

      // Parse "DD-MM-YYYY" from Setlist.fm to ISO date
      let concertDate = null;
      try {
        const [dd, mm, yyyy] = date.split("-");
        concertDate = new Date(`${yyyy}-${mm}-${dd}T12:00:00Z`);
      } catch {}

      const eventId = `sfm_${setlistfm_id}`;

      // Coordinates and a city link, both of which this route used to leave
      // empty: a concert without a position is dropped by the map's grouping and
      // simply never appears, and the city link is what carries reachability.
      // The client passes setlist.fm's own venue coordinates through.
      const hasCoords = latitude != null && longitude != null;
      let cityId = null;
      if (city && country) {
        const cityRecord = await prisma.city.upsert({
          where: { name_country: { name: city, country } },
          create: {
            name: city,
            country,
            latitude: hasCoords ? parseFloat(latitude) : null,
            longitude: hasCoords ? parseFloat(longitude) : null,
          },
          update: {},
          select: { id: true, latitude: true },
        });
        cityId = cityRecord.id;
        if (hasCoords && cityRecord.latitude == null) {
          await prisma.city.update({
            where: { id: cityRecord.id },
            data: { latitude: parseFloat(latitude), longitude: parseFloat(longitude) },
          });
        }
      }

      const concert = await prisma.concert.upsert({
        where: { event_id: eventId },
        create: {
          event_id: eventId,
          venue,
          city,
          country,
          concert_date: concertDate,
          on_sale: false,
          created_at: new Date(),
          url: url ?? null,
          source: "setlistfm",
          latitude: hasCoords ? String(latitude) : null,
          longitude: hasCoords ? String(longitude) : null,
          city_id: cityId,
        },
        update: {},
        select: { id: true },
      });

      // Gaps only, and never an overwrite. What setlist.fm returns is the
      // venue's *city* coordinates, so a row already placed at the venue itself
      // — by /bulk, or by the coordinate backfill — must keep what it has.
      if (hasCoords) {
        await prisma.concert.updateMany({
          where: { id: concert.id, OR: [{ latitude: null }, { longitude: null }] },
          data: { latitude: String(latitude), longitude: String(longitude) },
        });
      }
      if (cityId) {
        await prisma.concert.updateMany({
          where: { id: concert.id, city_id: null },
          data: { city_id: cityId },
        });
      }

      // Link band to concert, storing the specific setlist if provided
      const setlistData = Array.isArray(songs) && songs.length > 0 ? { songs } : undefined;
      await prisma.concertBandReference.upsert({
        where: { concert_band: { concert: concert.id, band: bandId } },
        create: { concert: concert.id, band: bandId, setlist: setlistData },
        update: { ...(setlistData ? { setlist: setlistData } : {}) },
      });

      const attendance = await prisma.concertAttendance.upsert({
        where: { wishlist_id_concert_id: { wishlist_id: wishlistId, concert_id: concert.id } },
        create: { wishlist_id: wishlistId, concert_id: concert.id },
        update: {},
      });

      res.json({ concert_id: concert.id, attendance_id: attendance.id });

      // Background: find other bands at the same show via Setlist.fm and link any that exist in the DB
      enrichConcertBands(concert.id, date, venue, city).catch(() => {});
    } catch (error) {
      console.error("Error adding from-setlist attendance:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

async function enrichConcertBands(concertId, date, venue, city) {
  if (!process.env.SETLIST_API_KEY) return;
  try {
    const res = await axios.get("https://api.setlist.fm/rest/1.0/search/setlists", {
      headers: { "x-api-key": process.env.SETLIST_API_KEY, Accept: "application/json" },
      params: { date, venueName: venue, cityName: city, p: 1 },
      timeout: 15000,
    });
    const setlists = res.data?.setlist ?? [];
    const mbids = [...new Set(setlists.map((s) => s.artist?.mbid).filter(Boolean))];
    if (!mbids.length) return;

    const bands = await prisma.band.findMany({
      where: { MBID: { in: mbids } },
      select: { id: true, MBID: true },
    });

    // Build mbid -> songs map from search results
    const mbidSongs = new Map();
    for (const s of setlists) {
      const mbid = s.artist?.mbid;
      if (!mbid || mbidSongs.has(mbid)) continue;
      const songs = (s.sets?.set ?? []).flatMap((set) =>
        (set.song ?? []).map((song) => ({
          name: song.name || '',
          cover: song.cover?.name ?? null,
          tape: song.tape ?? false,
        })),
      );
      if (songs.length) mbidSongs.set(mbid, songs);
    }

    for (const band of bands) {
      const songs = mbidSongs.get(band.MBID);
      const setlistData = songs ? { songs } : undefined;
      await prisma.concertBandReference.upsert({
        where: { concert_band: { concert: concertId, band: band.id } },
        create: { concert: concertId, band: band.id, setlist: setlistData },
        update: { ...(setlistData ? { setlist: setlistData } : {}) },
      });
    }
  } catch (e) {
    console.error("[enrichConcertBands] Error:", e.message);
  }
}

module.exports = router;
