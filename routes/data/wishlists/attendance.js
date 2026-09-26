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
const auth = require("../../../auth/verifyJWT");
const roleCheck = require("../../../middlewares/roleCheck");
const prisma = require("../../../prisma/client");
const { storesRealInstant } = require("../../../utils/ics");
const { conflict } = require("../../../utils/apiResponse");
const { countMediaForAttendances } = require("../../../utils/mediaDetach");
const { enrichConcertBands } = require("../../../utils/setlistEnrich");
// Called through the module rather than destructured, so a test can stand in
// for setlist.fm on the router's own copy of it.
const setlistFm = require("../../../utils/setlistFm");

// A show logged "today" can be dated tomorrow in UTC, and setlist.fm takes the
// venue's own date; a day of slack separates that from a show still to come.
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

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

      // Grouped rather than countMediaForAttendances' summed total: the History
      // view needs to know which shows have photos, not how many there are in
      // aggregate across the whole page.
      const attendanceIds = records.map((r) => r.id);
      const mediaCounts = attendanceIds.length
        ? await prisma.concertMedia.groupBy({
            by: ["attendance_id"],
            where: { attendance_id: { in: attendanceIds } },
            _count: true,
          })
        : [];
      const attendanceIdsWithPhotos = new Set(mediaCounts.map((m) => m.attendance_id));

      const result = records.map((r) => ({
        attendance_id: r.id,
        created_at: r.created_at,
        has_photos: attendanceIdsWithPhotos.has(r.id),
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
        select: { id: true, concert_date: true, venue: true, city: true, bands: { select: { band: true } } },
      });
      if (!concert) return res.status(404).json({ error: "Concert not found" });

      const attendance = await prisma.concertAttendance.upsert({
        where: { wishlist_id_concert_id: { wishlist_id: wishlistId, concert_id: concertId } },
        create: { wishlist_id: wishlistId, concert_id: concertId },
        update: {},
      });

      res.json({ attendance_id: attendance.id });

      // Background: a concert reached via the ordinary "mark attended" button
      // — as opposed to the from-setlist import below — has never had its
      // per-band setlists resolved. Without this, a show scraped from
      // Bandsintown/Songkick and later marked attended sits in "Attended"
      // with no setlist forever, even once Setlist.fm has one, because
      // nothing else ever links this concert to it. concert_date is a wall
      // clock wearing a UTC label (see date-handling notes), so its UTC
      // getters are the venue's own date, which is what Setlist.fm's search
      // expects in dd-MM-yyyy form.
      if (concert.concert_date) {
        const d = new Date(concert.concert_date);
        const eventDate = `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`;
        enrichConcertBands(concertId, eventDate, concert.venue, concert.city).catch(() => {});
      }
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

      // Un-attending a show is not a request to delete photographs. The
      // foreign key would refuse this anyway; catching it here is what turns a
      // 500 into a sentence that says what to do about it.
      const mediaCount = await countMediaForAttendances(prisma, [attendance.id]);
      if (mediaCount > 0) {
        return conflict(res, `This show has ${mediaCount} photo${mediaCount === 1 ? '' : 's'} attached. Delete them first if you really did not go.`);
      }

      await prisma.concertAttendance.delete({ where: { id: attendance.id } });

      res.json({ deleted: true });
    } catch (error) {
      console.error("Error removing attendance:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// POST /wishlists/:id/attendance/from-setlist — add a past concert from Setlist.fm history
//
// Everything about the show is read from setlist.fm by id, here. It used to be
// taken from the request body — venue, date, coordinates, songs, link — and
// written into Concert, the table every account reads. Any signed-in user could
// invent a show for any band, date it next month with a link of their choosing,
// and have it appear on that band's page for everyone and go out in other
// people's digest emails and Discord posts; or overwrite the setlist on a real
// one. The client now sends which setlist and which band, and nothing else it
// says about the show is used.
router.post(
  "/wishlists/:id/attendance/from-setlist",
  [
    auth,
    roleCheck(["ADMIN", "USER"]),
    param("id").isInt().withMessage("Wishlist ID must be an integer"),
    body("setlistfm_id").custom(setlistFm.isSetlistId).withMessage("setlistfm_id must be a setlist.fm id"),
    body("band_id").isInt().withMessage("band_id must be an integer"),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: "Validation failed", details: errors.array() });

      const wishlistId = parseInt(req.params.id, 10);
      const bandId = parseInt(req.body.band_id, 10);

      const wishlist = await prisma.wishlist.findUnique({
        where: { id: wishlistId },
        select: { id: true, user_id: true },
      });
      if (!wishlist) return res.status(404).json({ error: "Not found" });
      if (wishlist.user_id !== req.user.id) return res.status(403).json({ error: "Forbidden" });

      const band = await prisma.band.findUnique({ where: { id: bandId }, select: { id: true, MBID: true } });
      if (!band) return res.status(404).json({ error: "Band not found" });

      if (!process.env.SETLIST_API_KEY) {
        return res.status(503).json({ error: "Setlist.fm is not configured on this server" });
      }

      let setlist;
      try {
        setlist = await setlistFm.fetchSetlistById(req.body.setlistfm_id);
      } catch (error) {
        if (error.response?.status === 404) return res.status(404).json({ error: "Setlist not found on setlist.fm" });
        console.error("[from-setlist] setlist.fm lookup failed:", error.response?.status ?? error.message);
        return res.status(502).json({ error: "Could not reach setlist.fm — try again shortly" });
      }

      // The setlist has to be this band's. Without an MBID on the band there is
      // nothing to compare, but the show itself is still setlist.fm's own.
      const artistMbid = setlist?.artist?.mbid ?? null;
      if (band.MBID && artistMbid && band.MBID.toLowerCase() !== String(artistMbid).toLowerCase()) {
        return res.status(400).json({ error: "That setlist is by a different artist" });
      }

      const show = setlistFm.setlistSummary(setlist);
      const concertDate = setlistFm.setlistDate(show.date);
      if (!concertDate) return res.status(422).json({ error: "setlist.fm has no usable date for that show" });
      // Attended means it happened. setlist.fm does list shows ahead of time.
      if (concertDate.getTime() > Date.now() + FUTURE_SLACK_MS) {
        return res.status(400).json({ error: "That show has not happened yet" });
      }
      if (!show.venue || !show.city || !show.country) {
        return res.status(422).json({ error: "setlist.fm has no venue for that show" });
      }

      const { venue, city, country, url } = show;
      const coord = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
      const latitude = coord(show.latitude);
      const longitude = coord(show.longitude);
      const hasCoords = latitude != null && longitude != null;
      // Keyed on the id that was asked for and fetched, as it always was, so a
      // response that somehow lacked one cannot file every such show under
      // "sfm_null".
      const eventId = `sfm_${req.body.setlistfm_id}`;

      // Coordinates and a city link, both of which this route used to leave
      // empty: a concert without a position is dropped by the map's grouping and
      // simply never appears, and the city link is what carries reachability.
      const cityRecord = await prisma.city.upsert({
        where: { name_country: { name: city, country } },
        create: {
          name: city,
          country,
          latitude: hasCoords ? latitude : null,
          longitude: hasCoords ? longitude : null,
        },
        update: {},
        select: { id: true, latitude: true },
      });
      const cityId = cityRecord.id;
      if (hasCoords && cityRecord.latitude == null) {
        await prisma.city.update({
          where: { id: cityRecord.id },
          data: { latitude, longitude },
        });
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
      await prisma.concert.updateMany({
        where: { id: concert.id, city_id: null },
        data: { city_id: cityId },
      });

      // Link band to concert with the setlist setlist.fm has for it.
      const setlistData = show.songs.length > 0 ? { songs: show.songs } : undefined;
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
      enrichConcertBands(concert.id, show.date, venue, city).catch(() => {});
    } catch (error) {
      console.error("Error adding from-setlist attendance:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

module.exports = router;
