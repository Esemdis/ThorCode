const express = require("express");
const router = express.Router();
const { body, param, validationResult } = require("express-validator");

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const prisma = require("../../prisma/client");

router.use(auth);
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

    const { name, destination, start_date, end_date, notes, weight_budget } = req.body;
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
          include: { gear_item_rel: true },
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

  const { name, destination, start_date, end_date, notes, weight_budget } = req.body;
  const data = {};
  if (name !== undefined) data.name = name.trim();
  if (destination !== undefined) data.destination = destination?.trim() || null;
  if (start_date !== undefined) data.start_date = start_date ? new Date(start_date) : null;
  if (end_date !== undefined) data.end_date = end_date ? new Date(end_date) : null;
  if (notes !== undefined) data.notes = notes?.trim() || null;
  if (weight_budget !== undefined) data.weight_budget = weight_budget != null ? parseInt(weight_budget, 10) : null;

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
