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

    const { name, destination, start_date, end_date, notes } = req.body;
    try {
      const trip = await prisma.trip.create({
        data: {
          user_id: req.user.id,
          name: name.trim(),
          destination: destination?.trim() || null,
          start_date: start_date ? new Date(start_date) : null,
          end_date: end_date ? new Date(end_date) : null,
          notes: notes?.trim() || null,
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

  const { name, destination, start_date, end_date, notes } = req.body;
  const data = {};
  if (name !== undefined) data.name = name.trim();
  if (destination !== undefined) data.destination = destination?.trim() || null;
  if (start_date !== undefined) data.start_date = start_date ? new Date(start_date) : null;
  if (end_date !== undefined) data.end_date = end_date ? new Date(end_date) : null;
  if (notes !== undefined) data.notes = notes?.trim() || null;

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

// POST /travel/trips/:id/apply-template — copy template items into trip
router.post(
  "/:id/apply-template",
  [param("id").isInt(), body("template_id").isInt()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid parameters" });

    const tripId = parseInt(req.params.id);
    const templateId = parseInt(req.body.template_id);

    try {
      const [trip, template] = await Promise.all([
        prisma.trip.findFirst({ where: { id: tripId, user_id: req.user.id } }),
        prisma.template.findFirst({
          where: { id: templateId, user_id: req.user.id },
          include: { items: { orderBy: { sort_order: "asc" } } },
        }),
      ]);

      if (!trip) return res.status(404).json({ error: "Trip not found" });
      if (!template) return res.status(404).json({ error: "Template not found" });

      const newItems = template.items.map((item) => ({
        trip_id: tripId,
        name: item.name,
        category: item.category,
        note: item.note,
        url: item.url,
        sort_order: item.sort_order,
        status: "NEED_TO_BUY",
      }));

      const created = await prisma.$transaction(
        newItems.map((item) => prisma.tripItem.create({ data: item }))
      );

      res.json({ data: { added: created.length, items: created } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
