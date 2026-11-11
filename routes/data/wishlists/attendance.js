/**
 * Shows you went to.
 *
 * Split out of routes/data/wishlists.js, which had grown to 1473 lines and
 * twenty-one endpoints. wishlists.js mounts this and its siblings in their
 * original declaration order — the manifest test in wishlists.test.js pins
 * the resulting surface.
 */
const path = require("node:path");
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
const { upsertSetlistConcert } = require("../../../utils/setlistConcert");
const { retargetSidecars, undoRetarget } = require("../../../utils/mediaRetarget");
const { acquire } = require("../../../utils/serialQueue");
const { ownWishlist } = require("./shared");
// Called through the module rather than destructured, so a test can stand in
// for setlist.fm on the router's own copy of it.
const setlistFm = require("../../../utils/setlistFm");
const { setlistFmLimit } = require("../../../utils/setlistFmLimit");

// GET /wishlists/:id/attendance — all attended/going concerts for this wishlist
router.get(
  "/wishlists/:id/attendance",
  [auth, roleCheck(["ADMIN", "USER"]), param("id").isInt().withMessage("Wishlist ID must be an integer")],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: "Validation failed", details: errors.array() });

      const wishlist = await ownWishlist(req, res, {
        include: { bands: { select: { band_id: true, tier: true } } },
      });
      if (!wishlist) return;
      const wishlistId = wishlist.id;

      const bandTierMap = new Map(wishlist.bands.map((b) => [b.band_id, b.tier]));
      const bandIds = [...bandTierMap.keys()];

      const filterBandId = req.query.band_id ? parseInt(req.query.band_id, 10) : null;

      const records = await prisma.concertAttendance.findMany({
        where: {
          wishlist_id: wishlistId,
          ...(filterBandId
            ? {
                concert_rel: { bands: { some: { band: filterBandId } } },
                // A band's own list of shows you saw them at. Being at a
                // festival they played is not that, when you missed their set.
                missed_bands: { none: { band_id: filterBandId } },
              }
            : {}),
        },
        orderBy: { concert_rel: { concert_date: "desc" } },
        include: {
          missed_bands: { select: { band_id: true } },
          concert_rel: {
            select: {
              id: true,
              event_id: true,
              name: true,
              venue: true,
              // The Venue row, so the client can address a review at it.
              venue_id: true,
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
              // on_sale defaults to true at the sources, so without the date a
              // Going card would say "On sale" for a sale that has not opened.
              ticket_sale_start: true,
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
      //
      // And by kind. has_photos used to mean any media at all, and the list
      // draws it as "This night has photographs", so a night of clips alone
      // claimed photographs it did not have.
      const attendanceIds = records.map((r) => r.id);
      const mediaCounts = attendanceIds.length
        ? await prisma.concertMedia.groupBy({
            by: ["attendance_id", "kind"],
            where: { attendance_id: { in: attendanceIds } },
            _count: true,
          })
        : [];
      const attendanceIdsWith = (kind) => new Set(
        mediaCounts.filter((m) => m.kind === kind).map((m) => m.attendance_id),
      );
      const attendanceIdsWithPhotos = attendanceIdsWith("PHOTO");
      const attendanceIdsWithVideos = attendanceIdsWith("VIDEO");

      const result = records.map((r) => {
        const missed = new Set(r.missed_bands.map((m) => m.band_id));
        return {
          attendance_id: r.id,
          created_at: r.created_at,
          has_photos: attendanceIdsWithPhotos.has(r.id),
          has_videos: attendanceIdsWithVideos.has(r.id),
          // The owner's diary of the night (THO-823). This read is the
          // owner's own (ownWishlist, no admin exception), so it is never
          // shown to anyone else.
          notes: r.notes ?? null,
          rating: r.rating ?? null,
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
              // On the bill and still listed, but not seen: every count of
              // who you have seen leaves it out.
              missed: missed.has(b.band_rel.id),
            })),
          },
        };
      });

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
    // A new mark can search the shared setlist.fm key (below): same budget.
    setlistFmLimit,
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: "Validation failed", details: errors.array() });

      const wishlistId = parseInt(req.params.id, 10);
      const concertId = parseInt(req.body.concert_id, 10);

      if (!(await ownWishlist(req, res, { select: { id: true } }))) return;

      const concert = await prisma.concert.findUnique({
        where: { id: concertId },
        select: { id: true, concert_date: true, venue: true, city: true, bands: { select: { band: true } } },
      });
      if (!concert) return res.status(404).json({ error: "Concert not found" });

      const where = { wishlist_id_concert_id: { wishlist_id: wishlistId, concert_id: concertId } };
      const existed = await prisma.concertAttendance.findUnique({ where, select: { id: true } });
      const attendance = await prisma.concertAttendance.upsert({
        where,
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
      //
      // Only a new mark of a show that has happened: "Going" and "Attended"
      // are one row split by date, so nothing changes when the date passes,
      // and setlist.fm has nothing for a show to come. The 06:00 backfill
      // (setlistBackfill.js) picks up the rest, so a repeat click costs no
      // calls on the shared key.
      const startOfTodayUtc = new Date().setUTCHours(0, 0, 0, 0);
      if (!existed && concert.concert_date && new Date(concert.concert_date).getTime() < startOfTodayUtc) {
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

      if (!(await ownWishlist(req, res, { select: { id: true } }))) return;

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

// PUT /wishlists/:id/attendance/missed — say you did or did not see one act
// of a night you went to
//
// Takes the night's attendances rather than one: a festival day is a record
// per stage or per act, and the client holds the day as one night. The mark
// lands on each of them whose bill has the act, so whichever record a count
// or a band's page reads the night from, it says the same thing.
router.put(
  "/wishlists/:id/attendance/missed",
  [
    auth,
    roleCheck(["ADMIN", "USER"]),
    param("id").isInt().withMessage("Wishlist ID must be an integer"),
    body("attendance_ids").isArray({ min: 1, max: 200 }).withMessage("attendance_ids must be a list of 1 to 200 ids"),
    body("attendance_ids.*").isInt().withMessage("attendance_ids must be integers"),
    body("band_id").isInt().withMessage("band_id must be an integer"),
    body("missed").isBoolean({ strict: true }).withMessage("missed must be true or false"),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: "Validation failed", details: errors.array() });

      const wishlistId = parseInt(req.params.id, 10);
      const bandId = parseInt(req.body.band_id, 10);
      const attendanceIds = [...new Set(req.body.attendance_ids.map((id) => parseInt(id, 10)))];
      // A JSON true or false, nothing else: the validator is strict.
      const missed = req.body.missed === true;

      if (!(await ownWishlist(req, res, { select: { id: true } }))) return;

      const rows = await prisma.concertAttendance.findMany({
        where: { id: { in: attendanceIds }, wishlist_id: wishlistId },
        select: {
          id: true,
          concert_rel: { select: { bands: { where: { band: bandId }, select: { band: true } } } },
        },
      });
      // One answer for "not yours" and "not there", as ownWishlist gives for
      // the wishlist itself — and nothing written for any of them.
      if (rows.length !== attendanceIds.length) {
        return res.status(404).json({ error: "Attendance record not found" });
      }

      if (!missed) {
        // Wherever it is, including a show whose bill has since lost the act:
        // the question was whether you saw them, and the answer is yes.
        await prisma.attendanceMissedBand.deleteMany({
          where: { attendance_id: { in: attendanceIds }, band_id: bandId },
        });
        return res.json({ band_id: bandId, missed: false, attendance_ids: attendanceIds });
      }

      // Only an act on the bill can be one you missed. The bill is a
      // ConcertBandReference; an act that is a name in the scraped lineup has
      // no row to hang this on, and counts for nothing anyway.
      const onBill = rows.filter((r) => r.concert_rel.bands.length > 0).map((r) => r.id);
      if (!onBill.length) {
        return res.status(400).json({ error: "That band is not on the bill of this night" });
      }

      await prisma.attendanceMissedBand.createMany({
        data: onBill.map((attendanceId) => ({ attendance_id: attendanceId, band_id: bandId })),
        skipDuplicates: true,
      });

      res.json({ band_id: bandId, missed: true, attendance_ids: onBill });
    } catch (error) {
      console.error("Error marking a band missed:", error);
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
    // It reads the show from setlist.fm, then searches it for the rest of the
    // bill: the same shared key as the band routes, so the same budget.
    setlistFmLimit,
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

      if (!(await ownWishlist(req, res, { select: { id: true } }))) return;

      // The show itself, and the shared row for it, by the rules in
      // utils/setlistConcert.js — which the move route below uses too.
      let concert;
      let show;
      try {
        ({ concert, show } = await upsertSetlistConcert(prisma, { setlistfmId: req.body.setlistfm_id, bandId }));
      } catch (error) {
        if (error.setlistRefusal) return res.status(error.status).json({ error: error.message });
        throw error;
      }
      const { venue, city } = show;

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

// The longest a night's notes may be. Generous for a diary entry, and a bound
// on what one row can grow to.
const DIARY_NOTES_MAX = 5000;

// express-validator runs a standard validator on each element of a list, so
// `{rating: []}` passed isInt (nothing failed), reached Prisma as NaN and was
// a 500, and `{rating: [4, 5]}` was stored as 4. One value or nothing.
const isScalar = (value) => value === null || (typeof value !== "object" && typeof value !== "function");

// PATCH /wishlists/:id/attendance/:concertId — the owner's notes and 1-to-5
// rating for a show they went to (THO-823)
//
// Either key or both; a key left out is left alone, and null clears it. The
// range is checked here rather than by a CHECK constraint, as VenueReview's
// rating is.
router.patch(
  "/wishlists/:id/attendance/:concertId",
  [
    auth,
    roleCheck(["ADMIN", "USER"]),
    param("id").isInt().withMessage("Wishlist ID must be an integer"),
    param("concertId").isInt().withMessage("Concert ID must be an integer"),
    body("notes").optional({ values: "null" }).custom(isScalar).bail().isString().isLength({ max: DIARY_NOTES_MAX })
      .withMessage(`notes must be text of at most ${DIARY_NOTES_MAX} characters`),
    body("rating").optional({ values: "null" }).custom(isScalar).bail().isInt({ min: 1, max: 5 })
      .withMessage("rating must be a whole number from 1 to 5"),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: "Validation failed", details: errors.array() });

      const has = (key) => Object.prototype.hasOwnProperty.call(req.body ?? {}, key);
      if (!has("notes") && !has("rating")) {
        return res.status(400).json({ error: "Send notes, rating or both" });
      }

      const wishlistId = parseInt(req.params.id, 10);
      const concertId = parseInt(req.params.concertId, 10);

      if (!(await ownWishlist(req, res, { select: { id: true } }))) return;

      const attendance = await prisma.concertAttendance.findUnique({
        where: { wishlist_id_concert_id: { wishlist_id: wishlistId, concert_id: concertId } },
        select: { id: true },
      });
      if (!attendance) return res.status(404).json({ error: "Attendance record not found" });

      const data = {};
      // Whitespace is not a note. Stored as null, so "has notes" is one test
      // on every client rather than a trim in each.
      if (has("notes")) data.notes = req.body.notes == null ? null : req.body.notes.trim() || null;
      if (has("rating")) data.rating = req.body.rating == null ? null : parseInt(req.body.rating, 10);

      const saved = await prisma.concertAttendance.update({
        where: { id: attendance.id },
        data,
        select: { id: true, notes: true, rating: true },
      });

      res.json({ attendance_id: saved.id, notes: saved.notes, rating: saved.rating });
    } catch (error) {
      console.error("Error saving attendance notes:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// setlist.fm's search takes a date as dd-MM-yyyy. concert_date is a wall clock
// wearing a UTC label, so its UTC getters are the venue's own date.
const setlistSearchDate = (date) => {
  const d = new Date(date);
  return `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`;
};

// POST /wishlists/:id/attendance/:concertId/move — say which show this really
// was (THO-823)
//
// A setlist.fm import with the wrong date could only be deleted and imported
// again, and the delete is refused while it has photographs, so a wrong date
// with photographs was permanent. This re-points the attendance at the right
// Concert row instead. The attendance keeps its id, so its media, notes,
// rating and missed marks all go with it, and the sidecars in its folders are
// rewritten to name the new concert.
//
// A move and not an edit of the date: an sfm_ row is shared by everyone who
// imported that setlist and has no owner, so changing its date in place would
// change other people's shows. The old row stays for them.
//
// The target is an existing concert by id, or a setlist.fm show by id, whose
// row is made from setlist.fm's own record exactly as from-setlist makes it.
// Nothing the client says about the show is written.
router.post(
  "/wishlists/:id/attendance/:concertId/move",
  [
    auth,
    roleCheck(["ADMIN", "USER"]),
    // The setlist.fm form reads the show from setlist.fm and then searches it
    // for the rest of the bill, as from-setlist does: the same budget.
    setlistFmLimit,
    param("id").isInt().withMessage("Wishlist ID must be an integer"),
    param("concertId").isInt().withMessage("Concert ID must be an integer"),
    body("concert_id").optional({ values: "null" }).custom(isScalar).bail().isInt()
      .withMessage("concert_id must be an integer"),
    body("setlistfm_id").optional({ values: "null" }).custom(isScalar).bail().custom(setlistFm.isSetlistId)
      .withMessage("setlistfm_id must be a setlist.fm id"),
    body("band_id").optional({ values: "null" }).custom(isScalar).bail().isInt()
      .withMessage("band_id must be an integer"),
  ],
  async (req, res) => {
    let release = null;
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: "Validation failed", details: errors.array() });

      const byConcert = req.body.concert_id != null;
      const bySetlist = req.body.setlistfm_id != null;
      if (byConcert === bySetlist) {
        return res.status(400).json({ error: "Send either concert_id, or setlistfm_id with band_id" });
      }
      if (bySetlist && req.body.band_id == null) {
        return res.status(400).json({ error: "band_id is required with setlistfm_id" });
      }

      const wishlistId = parseInt(req.params.id, 10);
      const fromConcertId = parseInt(req.params.concertId, 10);

      if (!(await ownWishlist(req, res, { select: { id: true } }))) return;

      const attendance = await prisma.concertAttendance.findUnique({
        where: { wishlist_id_concert_id: { wishlist_id: wishlistId, concert_id: fromConcertId } },
        select: { id: true },
      });
      if (!attendance) return res.status(404).json({ error: "Attendance record not found" });

      const alreadyAttending = (concertId) => prisma.concertAttendance.findUnique({
        where: { wishlist_id_concert_id: { wishlist_id: wishlistId, concert_id: concertId } },
        select: { id: true },
      });
      const ALREADY_ATTENDING = "You already have that show in your list.";
      const MOVED_MEANWHILE = "This show was just changed. Reload it and try again.";

      let targetId;
      let show = null;
      if (byConcert) {
        targetId = parseInt(req.body.concert_id, 10);
      } else {
        // Asked before setlist.fm is: a show already in the list is refused
        // without spending the shared key, or writing to the shared row.
        const known = await prisma.concert.findUnique({
          where: { event_id: `sfm_${req.body.setlistfm_id}` },
          select: { id: true },
        });
        if (known?.id === fromConcertId) {
          return res.json({ attendance_id: attendance.id, concert_id: known.id });
        }
        if (known && (await alreadyAttending(known.id))) {
          return conflict(res, ALREADY_ATTENDING);
        }
        try {
          ({ concert: { id: targetId }, show } = await upsertSetlistConcert(prisma, {
            setlistfmId: req.body.setlistfm_id,
            bandId: parseInt(req.body.band_id, 10),
          }));
        } catch (error) {
          if (error.setlistRefusal) return res.status(error.status).json({ error: error.message });
          throw error;
        }
      }

      const target = await prisma.concert.findUnique({
        where: { id: targetId },
        select: { id: true, concert_date: true, venue: true, city: true, country: true },
      });
      if (!target) return res.status(404).json({ error: "Concert not found" });

      if (target.id === fromConcertId) {
        return res.json({ attendance_id: attendance.id, concert_id: target.id });
      }

      // The upload route's lock on this show. An upload chooses its folder and
      // writes its sidecar under it, so a move cannot rewrite the sidecars
      // halfway through one, and the next upload reads where the files are.
      // Taken before the checks below: counted outside it, an upload could add
      // photos between the count and the move, and a second move could change
      // the row under this one.
      release = await acquire(`attendance:${attendance.id}`);

      // The states the rest of the API refuses an attended show. Without a
      // date, the upload route refuses it and the band page drops it, so its
      // photos vanish from there. Still to come, it is a Going row, and the
      // next sync's movedFields can move its date without touching the
      // folders, undoing the correction; with no photos nothing can drift.
      if (!target.concert_date) {
        return res.status(400).json({ error: "This show has no confirmed date yet" });
      }
      if (new Date(target.concert_date).getTime() > Date.now()
        && (await prisma.concertMedia.count({ where: { attendance_id: attendance.id } })) > 0) {
        return res.status(400).json({ error: "That show has not happened yet, and this one has photos" });
      }

      // Only from the show this request read. A move that landed first (the
      // lock is per attendance, but the row was read before it) leaves this
      // one nothing to do but say so; moving on from there would rewrite
      // sidecars, and on a failure put back, a concert this request never saw.
      try {
        const { count } = await prisma.concertAttendance.updateMany({
          where: { id: attendance.id, concert_id: fromConcertId },
          data: { concert_id: target.id },
        });
        if (count === 0) return conflict(res, MOVED_MEANWHILE);
      } catch (error) {
        // @@unique([wishlist_id, concert_id]): another request put that show
        // in the list since the check above.
        if (error.code === "P2002") return conflict(res, ALREADY_ATTENDING);
        throw error;
      }

      const media = await prisma.concertMedia.findMany({
        where: { attendance_id: attendance.id },
        select: { rel_path: true },
      });
      const relDirs = [...new Set(media.map((m) => path.posix.dirname(m.rel_path)))];

      try {
        await retargetSidecars({ relDirs, concertId: target.id, concert: target });
      } catch (error) {
        // Disk and Postgres must agree at every exit. A sidecar left naming
        // the old concert while the row names the new one would send the
        // files back on the next rebuild, so both go back as they were.
        console.error("[move] could not rewrite a sidecar:", error);
        await undoRetarget(error.undo ?? []);
        await prisma.concertAttendance.updateMany({
          where: { id: attendance.id, concert_id: target.id },
          data: { concert_id: fromConcertId },
        });
        return res.status(500).json({ error: "Could not update the photo folders; nothing was changed" });
      }

      res.json({ attendance_id: attendance.id, concert_id: target.id });

      // Background, as for a new mark: the show's other acts and setlists.
      // A setlist.fm show has its own date to search by; an existing row is
      // searched by its date when it has happened.
      if (show) {
        enrichConcertBands(target.id, show.date, show.venue, show.city).catch(() => {});
      } else if (target.concert_date && new Date(target.concert_date).getTime() < new Date().setUTCHours(0, 0, 0, 0)) {
        enrichConcertBands(target.id, setlistSearchDate(target.concert_date), target.venue, target.city).catch(() => {});
      }
    } catch (error) {
      console.error("Error moving attendance:", error);
      if (!res.headersSent) return res.status(500).json({ error: "Internal server error" });
    } finally {
      if (release) release();
    }
  }
);

module.exports = router;
