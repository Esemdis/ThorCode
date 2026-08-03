const express = require("express");
const router = express.Router();
const { body, param, validationResult } = require("express-validator");
const { Prisma } = require("@prisma/client");
const axios = require("axios");

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const prisma = require("../../prisma/client");
const { fail, paginate, sendList } = require("../../utils/apiResponse");

router.use(auth);

// GET /travel/trips/weather-pending — trips needing weather sync (SYSTEM only)
router.get("/weather-pending", roleCheck(["SYSTEM"]), async (_req, res) => {
  try {
    const now = new Date();
    const staleThreshold = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const trips = await prisma.trip.findMany({
      where: {
        destination: { not: null },
        start_date: { not: null },
        end_date: { not: null },
        OR: [
          { weather_data: { equals: Prisma.DbNull } },
          {
            end_date: { gte: now },
            OR: [
              { weather_updated_at: null },
              { weather_updated_at: { lt: staleThreshold } },
            ],
          },
        ],
      },
      select: { id: true, destination: true, start_date: true, end_date: true },
    });
    res.json(trips);
  } catch (err) {
    fail(res, err, { context: "GET weather-pending" });
  }
});

// POST /travel/trips/sync-weather — proxy to Python trip weather sync (ADMIN only)
router.post("/sync-weather", roleCheck(["ADMIN"]), async (_req, res) => {
  try {
    const pythonServiceUrl = process.env.PYTHON_SERVICE_URL;
    await axios.post(`${pythonServiceUrl}/sync-trip-weather`, {}, { timeout: 300000 });
    res.status(200).json({ status: "success" });
  } catch (err) {
    fail(res, err, { context: "POST sync-weather", message: "Weather sync failed" });
  }
});

// How many trips one bulk call may carry, and how many updates share a
// transaction. The body limit is 10MB and the connection pool is 30, so an
// unbounded Promise.all over the whole payload would open hundreds of
// concurrent updates and exhaust the pool. Chunking also means a failure
// halfway leaves whole chunks applied rather than an arbitrary subset.
const BULK_MAX_TRIPS = 500;
const BULK_CHUNK = 25;

// PATCH /travel/trips/weather/bulk — store weather blobs from Python cron (SYSTEM only)
router.patch("/weather/bulk", roleCheck(["SYSTEM"]), async (req, res) => {
  const updates = req.body; // [{ id, weather_data }]
  if (!Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({ error: "Expected non-empty array of { id, weather_data }" });
  }
  if (updates.length > BULK_MAX_TRIPS) {
    return res.status(400).json({ error: `Too many trips in one call — send at most ${BULK_MAX_TRIPS}` });
  }
  if (!updates.every((u) => u && Number.isInteger(u.id))) {
    return res.status(400).json({ error: "Every entry needs an integer id" });
  }

  const now = new Date();
  let updated = 0;
  try {
    for (let i = 0; i < updates.length; i += BULK_CHUNK) {
      const chunk = updates.slice(i, i + BULK_CHUNK);
      await prisma.$transaction(
        chunk.map(({ id, weather_data }) =>
          prisma.trip.update({
            where: { id },
            data: { weather_data, weather_updated_at: now },
          })
        )
      );
      updated += chunk.length;
    }
    res.json({ ok: true, updated });
  } catch (err) {
    // Say how far it got: the caller is a cron job that can retry the rest.
    console.error(`[${new Date().toISOString()}] PATCH weather/bulk failed after ${updated}/${updates.length}`, err);
    res.status(500).json({ error: "Bulk weather update failed", updated });
  }
});

router.use(roleCheck(["USER", "ADMIN"]));

// GET /travel/trips — list user's trips
router.get("/", async (req, res) => {
  const { take, skip } = paginate(req, { defaultLimit: 100, maxLimit: 500 });
  try {
    const where = { user_id: req.user.id };
    const [trips, total] = await Promise.all([
      prisma.trip.findMany({
        where,
        orderBy: [{ start_date: "asc" }, { created_at: "desc" }],
        take,
        skip,
        include: {
          items: {
            // id/name/fill_level feed the refill tasks on the to-do page, which
            // works off this list rather than fetching each trip in full.
            include: { gear_item_rel: { select: { id: true, name: true, fill_level: true, dimensions: true, review_status: true } } },
          },
          todos: { orderBy: [{ done: "asc" }, { sort_order: "asc" }, { created_at: "asc" }] },
          estimates: { select: { amount: true, currency: true, category: true } },
          reviews: { select: { trip_item_id: true } },
          trip_review: {
            select: {
              culture_rating: true, food_rating: true, fun_rating: true,
              // Feeds the "forgotten gear" signal in the gear closet
              missing_gear_item_ids: true, missing_note: true,
            },
          },
        },
      }),
      prisma.trip.count({ where }),
    ]);
    sendList(res, trips, { total, take, skip });
  } catch (err) {
    fail(res, err, { context: "GET trips" });
  }
});

// POST /travel/trips — create trip
router.post("/", body("name").notEmpty().trim(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  const { name, destination, start_date, end_date, notes, weight_budget, money_budget, currency,
          budget_flights, budget_hotel, budget_entertainment, budget_food, tags } = req.body;
  try {
    const trip = await prisma.trip.create({
      data: {
        user_id: req.user.id,
        name: name.trim(),
        destination: destination?.trim() || null,
        start_date: start_date ? new Date(start_date) : null,
        end_date: end_date ? new Date(end_date) : null,
        notes: notes?.trim() || null,
        weight_budget: weight_budget != null ? parseInt(weight_budget, 10) : null,
        money_budget: money_budget != null ? parseFloat(money_budget) : null,
        currency: currency?.toUpperCase() || "SEK",
        budget_flights: budget_flights != null ? parseFloat(budget_flights) : null,
        budget_hotel: budget_hotel != null ? parseFloat(budget_hotel) : null,
        budget_entertainment: budget_entertainment != null ? parseFloat(budget_entertainment) : null,
        budget_food: budget_food != null ? parseFloat(budget_food) : null,
        tags: Array.isArray(tags) ? tags.map((t) => t.trim()).filter(Boolean) : [],
      },
    });
    res.status(201).json({ data: trip });
  } catch (err) {
    fail(res, err, { context: "POST trip" });
  }
});

// GET /travel/trips/:id — get trip with items + estimates
router.get("/:id", param("id").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid id" });

  try {
    const trip = await prisma.trip.findFirst({
      where: { id: parseInt(req.params.id), user_id: req.user.id },
      include: {
        items: {
          include: {
            gear_item_rel: true,
            bag_rel: { select: { id: true, name: true, brand: true } },
          },
          orderBy: [{ sort_order: "asc" }, { created_at: "asc" }],
        },
        estimates: { orderBy: [{ sort_order: "asc" }, { created_at: "asc" }] },
        reviews: { orderBy: { created_at: "asc" } },
        trip_review: true,
        todos: { orderBy: [{ done: "asc" }, { sort_order: "asc" }, { created_at: "asc" }] },
      },
    });
    if (!trip) return res.status(404).json({ error: "Trip not found" });
    res.json({ data: trip });
  } catch (err) {
    fail(res, err, { context: `GET trip ${req.params.id}` });
  }
});

// PATCH /travel/trips/:id — update trip metadata
router.patch("/:id", param("id").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid id" });

  const { name, destination, start_date, end_date, notes, weight_budget, money_budget, currency,
          budget_flights, budget_hotel, budget_entertainment, budget_food, exchange_rates, tags,
          arrival_time, departure_time, arrival_place_id, departure_place_id } = req.body;
  const data = {};

  // Minutes since midnight, and a day is 1440 of them. Out of range means a
  // client sent something other than minutes, which would silently produce an
  // impossible day window rather than an error anybody could act on.
  const minutes = (value) => {
    if (value == null || value === "") return null;
    const n = parseInt(value, 10);
    return Number.isInteger(n) && n >= 0 && n < 1440 ? n : undefined;
  };
  for (const [field, value] of [["arrival_time", arrival_time], ["departure_time", departure_time]]) {
    if (value === undefined) continue;
    const parsed = minutes(value);
    if (parsed === undefined) {
      return res.status(400).json({ error: `${field} must be minutes since midnight, 0 to 1439` });
    }
    data[field] = parsed;
  }
  for (const [field, value] of [["arrival_place_id", arrival_place_id],
                                ["departure_place_id", departure_place_id]]) {
    if (value === undefined) continue;
    data[field] = value == null || value === "" ? null : parseInt(value, 10);
  }
  if (tags !== undefined) data.tags = Array.isArray(tags) ? tags.map((t) => t.trim()).filter(Boolean) : [];
  if (exchange_rates !== undefined) data.exchange_rates = exchange_rates ?? null;
  if (name !== undefined) data.name = name.trim();
  if (destination !== undefined) data.destination = destination?.trim() || null;
  if (start_date !== undefined) data.start_date = start_date ? new Date(start_date) : null;
  if (end_date !== undefined) data.end_date = end_date ? new Date(end_date) : null;
  if (notes !== undefined) data.notes = notes?.trim() || null;
  if (weight_budget !== undefined) data.weight_budget = weight_budget != null ? parseInt(weight_budget, 10) : null;
  if (money_budget !== undefined) data.money_budget = money_budget != null ? parseFloat(money_budget) : null;
  if (currency !== undefined) data.currency = currency.toUpperCase();
  if (budget_flights !== undefined) data.budget_flights = budget_flights != null ? parseFloat(budget_flights) : null;
  if (budget_hotel !== undefined) data.budget_hotel = budget_hotel != null ? parseFloat(budget_hotel) : null;
  if (budget_entertainment !== undefined) data.budget_entertainment = budget_entertainment != null ? parseFloat(budget_entertainment) : null;
  if (budget_food !== undefined) data.budget_food = budget_food != null ? parseFloat(budget_food) : null;

  try {
    // user_id in the where does the authorising: a trip that isn't the caller's
    // simply doesn't match, and Prisma reports that the same way as a trip that
    // doesn't exist.
    const trip = await prisma.trip.update({
      where: { id: parseInt(req.params.id, 10), user_id: req.user.id },
      data,
    });
    res.json({ data: trip });
  } catch (err) {
    fail(res, err, { context: `PATCH trip ${req.params.id}`, notFound: "Trip not found" });
  }
});

// DELETE /travel/trips/:id — delete trip (cascades items, estimates, todos, reviews)
router.delete("/:id", param("id").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid id" });

  try {
    await prisma.trip.delete({
      where: { id: parseInt(req.params.id, 10), user_id: req.user.id },
    });
    res.json({ message: "Trip deleted" });
  } catch (err) {
    fail(res, err, { context: `DELETE trip ${req.params.id}`, notFound: "Trip not found" });
  }
});

// POST /travel/trips/:id/duplicate — clone trip with all items
router.post("/:id/duplicate", param("id").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid id" });

  const sourceId = parseInt(req.params.id, 10);
  try {
    const source = await prisma.trip.findFirst({
      where: { id: sourceId, user_id: req.user.id },
      include: { items: { orderBy: [{ sort_order: "asc" }, { created_at: "asc" }] } },
    });
    if (!source) return res.status(404).json({ error: "Trip not found" });

    const newTrip = await prisma.trip.create({
      data: {
        user_id: req.user.id,
        name: `Copy of ${source.name}`,
        destination: source.destination,
        notes: source.notes,
        tags: source.tags,
      },
    });

    if (source.items.length > 0) {
      await prisma.$transaction(
        source.items.map((item) =>
          prisma.tripItem.create({
            data: {
              trip_id: newTrip.id,
              name: item.name,
              category: item.category,
              status: item.status,
              note: item.note,
              url: item.url,
              sort_order: item.sort_order,
              gear_item_id: item.gear_item_id,
              worn: item.worn,
            },
          })
        )
      );
    }

    res.status(201).json({ data: newTrip });
  } catch (err) {
    fail(res, err, { context: `POST duplicate trip ${sourceId}` });
  }
});

module.exports = router;
