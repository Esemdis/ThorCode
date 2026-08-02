const express = require("express");
const router = express.Router({ mergeParams: true });
const { param, validationResult } = require("express-validator");

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const ownsTrip = require("../../middlewares/ownsTrip");
const prisma = require("../../prisma/client");
const { fail } = require("../../utils/apiResponse");
const { normalisePlaceInput } = require("../../utils/travel/placeInput");
const routePlanner = require("../../utils/travel/routePlanner");

router.use(auth);
router.use(roleCheck(["USER", "ADMIN"]));
router.use(ownsTrip);

/**
 * Fill in coordinates for a place that arrived without them.
 *
 * Tried once, on write, and then never again — a museum does not move, so this
 * is a column and not a cache. A pasted map link resolves without touching the
 * network at all, which matters because Nominatim can only find what
 * OpenStreetMap has mapped and anywhere that opened recently may be unfindable
 * at any spelling.
 *
 * Returns coordinates or nulls. Never throws: a place nobody could locate is
 * still worth saving, and the solver reports it as dropped rather than failing.
 */
async function locate({ url, address, name }, trip) {
  const near = trip?.lat != null && trip?.lon != null ? [trip.lat, trip.lon] : null;
  for (const query of [url, address, name].filter(Boolean)) {
    const found = await routePlanner.geocode(query, near);
    if (found?.lat != null && found?.lon != null) {
      return { lat: found.lat, lon: found.lon };
    }
  }
  return { lat: null, lon: null };
}

// GET /travel/trips/:tripId/places
router.get("/", async (req, res) => {
  try {
    const places = await prisma.tripPlace.findMany({
      where: { trip_id: req.tripId },
      orderBy: [{ sort_order: "asc" }, { created_at: "asc" }],
    });
    res.json({ data: places });
  } catch (err) {
    fail(res, err, { context: `GET places (trip ${req.tripId})` });
  }
});

// POST /travel/trips/:tripId/places
router.post("/", async (req, res) => {
  const { data, error } = normalisePlaceInput(req.body);
  if (error) return res.status(400).json({ error });

  try {
    // Only geocode when the client did not supply coordinates. travel-bag
    // resolves a pasted link on its own where it can, and re-asking would spend
    // a rate-limited Nominatim second confirming what we already know.
    if (data.lat == null) {
      Object.assign(data, await locate(
        { url: data.url, address: data.address, name: data.name },
        req.body.near ? { lat: req.body.near[0], lon: req.body.near[1] } : null
      ));
    }

    const place = await prisma.tripPlace.create({
      data: { ...data, trip_id: req.tripId },
    });
    res.status(201).json({ data: place });
  } catch (err) {
    fail(res, err, { context: `POST place (trip ${req.tripId})` });
  }
});

// PATCH /travel/trips/:tripId/places/reorder — bulk sort_order update.
// Declared before /:placeId so "reorder" isn't read as a place id.
router.patch("/reorder", async (req, res) => {
  const { places } = req.body;
  if (!Array.isArray(places)) return res.status(400).json({ error: "places must be an array" });

  try {
    await prisma.$transaction(
      places.map(({ id, sort_order }) =>
        prisma.tripPlace.updateMany({
          where: { id, trip_id: req.tripId },
          data: { sort_order },
        })
      )
    );
    res.json({ message: "Reordered" });
  } catch (err) {
    fail(res, err, { context: `PATCH places reorder (trip ${req.tripId})` });
  }
});

// PATCH /travel/trips/:tripId/places/:placeId
router.patch("/:placeId", param("placeId").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid parameters" });

  const { data, error } = normalisePlaceInput(req.body, { partial: true });
  if (error) return res.status(400).json({ error });

  const placeId = parseInt(req.params.placeId, 10);
  try {
    // Pasting a link or an address is *the* fix for a place that could not be
    // found, so an edit that supplies one has to actually try it. Without this
    // the form says pasting a map link is the surest way to place somewhere and
    // then stores the link next to the same empty coordinates, which is exactly
    // as useful as doing nothing and looks like a broken geocoder.
    //
    // Guarded three ways: only when the edit offers something new to search on,
    // only when the caller did not set coordinates itself, and only when the
    // place has none — a museum does not move, so a rename never re-geocodes.
    const offersNewHint = data.url !== undefined || data.address !== undefined || data.name !== undefined;
    if (offersNewHint && data.lat === undefined) {
      const existing = await prisma.tripPlace.findFirst({
        where: { id: placeId, trip_id: req.tripId },
        select: { lat: true, url: true, address: true, name: true },
      });
      if (!existing) return res.status(404).json({ error: "Place not found" });
      if (existing.lat == null) {
        Object.assign(data, await locate({
          url: data.url ?? existing.url,
          address: data.address ?? existing.address,
          name: data.name ?? existing.name,
        }));
      }
    }

    const place = await prisma.tripPlace.update({
      where: { id: placeId, trip_id: req.tripId },
      data,
    });
    res.json({ data: place });
  } catch (err) {
    fail(res, err, { context: `PATCH place ${req.params.placeId}`, notFound: "Place not found" });
  }
});

// POST /travel/trips/:tripId/places/:placeId/locate — retry geocoding one place.
// Separate from PATCH because it is the fix for the "we couldn't find it" state
// and should be one button, not a form the user has to fill in with a link.
router.post("/:placeId/locate", param("placeId").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid parameters" });

  try {
    const existing = await prisma.tripPlace.findFirst({
      where: { id: parseInt(req.params.placeId, 10), trip_id: req.tripId },
    });
    if (!existing) return res.status(404).json({ error: "Place not found" });

    const found = await locate(
      { url: req.body.query || existing.url, address: existing.address, name: existing.name },
      null
    );
    if (found.lat == null) {
      return res.status(404).json({ error: "Still could not find that — try pasting a map link" });
    }

    const place = await prisma.tripPlace.update({ where: { id: existing.id }, data: found });
    res.json({ data: place });
  } catch (err) {
    fail(res, err, { context: `POST locate place ${req.params.placeId}` });
  }
});

// DELETE /travel/trips/:tripId/places/:placeId
router.delete("/:placeId", param("placeId").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid parameters" });

  try {
    await prisma.tripPlace.delete({
      where: { id: parseInt(req.params.placeId, 10), trip_id: req.tripId },
    });
    res.json({ message: "Place deleted" });
  } catch (err) {
    fail(res, err, { context: `DELETE place ${req.params.placeId}`, notFound: "Place not found" });
  }
});

module.exports = router;
