/**
 * GET /data/concerts/nearby — the signed-in user's wishlist shows near a point
 * on some dates (THO-667). wander's trip page reads it with the user's own
 * token, so the trip's city and dates come from there and the wishlist from
 * here.
 *
 * Additive: nothing existing changes shape. Scoped to req.user.id's wishlist,
 * so the token never reads another person's list.
 */
const express = require("express");
const router = express.Router();
const { query, validationResult } = require("express-validator");
const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const prisma = require("../../prisma/client");
const { fail } = require("../../utils/apiResponse");
const { nearbyConcerts, nearbyConcertOut } = require("../../utils/concertsNearby");

const DEFAULT_RADIUS_KM = 30;
const MAX_RADIUS_KM = 300;
// A trip is not a year; a longer window is a mistake that would read the whole
// wishlist.
const MAX_SPAN_DAYS = 120;
// The prefilter is by date and wishlist only (the coordinate columns are
// strings, so the radius is applied in code), so the read is bounded here.
const READ_CEILING = 500;
const DAY_MS = 86_400_000;

const isoDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

const checks = [
  query("from").custom(isoDay).withMessage("from must be a date, YYYY-MM-DD"),
  query("to").custom(isoDay).withMessage("to must be a date, YYYY-MM-DD"),
  query("lat").optional().isFloat({ min: -90, max: 90 }).withMessage("lat must be a latitude"),
  query("lng").optional().isFloat({ min: -180, max: 180 }).withMessage("lng must be a longitude"),
  query("radius_km").optional().isFloat({ min: 1, max: MAX_RADIUS_KM }).withMessage(`radius_km must be 1 to ${MAX_RADIUS_KM}`),
  query("city").optional().isString().isLength({ max: 120 }),
];

router.get("/nearby", [auth, roleCheck(["ADMIN", "USER"]), ...checks], async (req, res) => {
  const problems = validationResult(req);
  if (!problems.isEmpty()) return res.status(400).json({ error: problems.array()[0].msg });
  const { from, to } = req.query;
  const lat = req.query.lat === undefined ? null : Number(req.query.lat);
  const lng = req.query.lng === undefined ? null : Number(req.query.lng);
  const city = req.query.city?.trim() || null;
  if ((lat === null) !== (lng === null)) return res.status(400).json({ error: "Give lat and lng together" });
  if (lat === null && !city) return res.status(400).json({ error: "Give a point (lat and lng) or a city" });
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (end < start) return res.status(400).json({ error: "to is before from" });
  if ((end - start) / DAY_MS > MAX_SPAN_DAYS) return res.status(400).json({ error: `Ask for at most ${MAX_SPAN_DAYS} days` });
  const radiusKm = req.query.radius_km === undefined ? DEFAULT_RADIUS_KM : Number(req.query.radius_km);

  try {
    const wishlist = await prisma.wishlist.findUnique({
      where: { user_id: req.user.id },
      select: { bands: { select: { band_id: true, tier: true } } },
    });
    const tiers = new Map((wishlist?.bands ?? []).map((b) => [b.band_id, b.tier]));
    if (!tiers.size) return res.json({ data: { concerts: [], truncated: false } });

    // A day either side of the asked window. `concert_date` is a UTC stamp
    // whose local day can differ from the venue's (a 23:30 show in Tokyo is the
    // day before in UTC; a wall-clock row is off the other way), and a show on
    // the last night must not drop out here. The caller reads the exact local
    // day, which needs the venue's zone and so cannot be done here.
    const rows = await prisma.concert.findMany({
      where: {
        concert_date: { gte: new Date(start - DAY_MS), lt: new Date(end + 2 * DAY_MS) },
        bands: { some: { band: { in: [...tiers.keys()] } } },
      },
      orderBy: [{ concert_date: "asc" }, { id: "asc" }],
      take: READ_CEILING,
      select: {
        id: true, name: true, festival: true, venue: true, city: true, country: true, concert_date: true,
        source: true, latitude: true, longitude: true, url: true, on_sale: true, sold_out: true, ticket_sale_start: true,
        price_min: true, price_max: true, price_currency: true,
        city_rel: { select: { name: true } },
        bands: { where: { band: { in: [...tiers.keys()] } }, select: { band_rel: { select: { id: true, name: true } } } },
      },
    });
    const now = new Date();
    const concerts = nearbyConcerts(rows, { lat, lng, radiusKm, city }).map((c) => nearbyConcertOut(c, tiers, now));
    // Said, not hidden: a cut-off read means some shows may be missing.
    return res.json({ data: { concerts, truncated: rows.length >= READ_CEILING } });
  } catch (err) {
    return fail(res, err, { context: "GET concerts nearby" });
  }
});

module.exports = router;
