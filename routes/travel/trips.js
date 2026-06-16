const express = require("express");
const router = express.Router();
const { body, param, validationResult } = require("express-validator");
const { Prisma } = require("@prisma/client");
const axios = require("axios");

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const prisma = require("../../prisma/client");

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
    res.status(500).json({ error: err.message });
  }
});

// POST /travel/trips/sync-weather — proxy to Python trip weather sync (ADMIN only)
router.post("/sync-weather", roleCheck(["ADMIN"]), async (_req, res) => {
  try {
    const pythonServiceUrl = process.env.PYTHON_SERVICE_URL;
    await axios.post(`${pythonServiceUrl}/sync-trip-weather`, {}, { timeout: 300000 });
    res.status(200).json({ status: "success" });
  } catch (error) {
    console.error("Error triggering trip weather sync:", error.message);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// PATCH /travel/trips/weather/bulk — store weather blobs from Python cron (SYSTEM only)
router.patch("/weather/bulk", roleCheck(["SYSTEM"]), async (req, res) => {
  try {
    const updates = req.body; // [{ id, weather_data }]
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: "Expected non-empty array of { id, weather_data }" });
    }
    await Promise.all(
      updates.map(({ id, weather_data }) =>
        prisma.trip.update({
          where: { id },
          data: { weather_data, weather_updated_at: new Date() },
        })
      )
    );
    res.json({ ok: true, updated: updates.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.use(roleCheck(["USER", "ADMIN"]));

// GET /travel/trips — list user's trips
router.get("/", async (req, res) => {
  try {
    const trips = await prisma.trip.findMany({
      where: { user_id: req.user.id },
      orderBy: [{ start_date: "asc" }, { created_at: "desc" }],
      include: {
        items: {
          include: { gear_item_rel: { select: { dimensions: true } } },
        },
        estimates: { select: { amount: true, currency: true, category: true } },
      },
    });
    res.json({ data: trips });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /travel/trips — create trip
router.post(
  "/",
  [body("name").notEmpty().trim()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const { name, destination, start_date, end_date, notes, weight_budget, money_budget, currency,
            budget_flights, budget_hotel, budget_entertainment, budget_food } = req.body;
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
          currency: currency?.toUpperCase() || 'SEK',
          budget_flights: budget_flights != null ? parseFloat(budget_flights) : null,
          budget_hotel: budget_hotel != null ? parseFloat(budget_hotel) : null,
          budget_entertainment: budget_entertainment != null ? parseFloat(budget_entertainment) : null,
          budget_food: budget_food != null ? parseFloat(budget_food) : null,
        },
      });
      res.status(201).json({ data: trip });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

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
      },
    });
    if (!trip) return res.status(404).json({ error: "Trip not found" });
    res.json({ data: trip });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /travel/trips/:id — update trip metadata
router.patch("/:id", param("id").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid id" });

  const { name, destination, start_date, end_date, notes, weight_budget, money_budget, currency,
          budget_flights, budget_hotel, budget_entertainment, budget_food } = req.body;
  const data = {};
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
    const existing = await prisma.trip.findFirst({
      where: { id: parseInt(req.params.id), user_id: req.user.id },
    });
    if (!existing) return res.status(404).json({ error: "Trip not found" });

    const trip = await prisma.trip.update({
      where: { id: parseInt(req.params.id) },
      data,
    });
    res.json({ data: trip });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /travel/trips/:id — delete trip (cascades items + estimates)
router.delete("/:id", param("id").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid id" });

  try {
    const existing = await prisma.trip.findFirst({
      where: { id: parseInt(req.params.id), user_id: req.user.id },
    });
    if (!existing) return res.status(404).json({ error: "Trip not found" });

    await prisma.trip.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ message: "Trip deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /travel/trips/:id/duplicate — clone trip with all items
router.post("/:id/duplicate", param("id").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid id" });

  const sourceId = parseInt(req.params.id);
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
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
