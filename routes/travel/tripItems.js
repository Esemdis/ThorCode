const express = require("express");
const router = express.Router({ mergeParams: true });
const { body, param, validationResult } = require("express-validator");

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const prisma = require("../../prisma/client");

router.use(auth);
router.use(roleCheck(["USER", "ADMIN"]));

const VALID_STATUSES = ["NEED_TO_BUY", "BOUGHT", "PACKED", "BORROWED", "NOT_BRINGING"];

async function ownsTrip(userId, tripId) {
  const trip = await prisma.trip.findFirst({ where: { id: tripId, user_id: userId } });
  return !!trip;
}

// GET /travel/trips/:tripId/items
router.get("/", param("tripId").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid tripId" });

  const tripId = parseInt(req.params.tripId);
  if (!(await ownsTrip(req.user.id, tripId))) return res.status(404).json({ error: "Trip not found" });

  try {
    const items = await prisma.tripItem.findMany({
      where: { trip_id: tripId },
      include: { gear_item_rel: true },
      orderBy: [{ sort_order: "asc" }, { created_at: "asc" }],
    });
    res.json({ data: items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /travel/trips/:tripId/items
router.post(
  "/",
  [param("tripId").isInt(), body("name").notEmpty().trim()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const tripId = parseInt(req.params.tripId);
    if (!(await ownsTrip(req.user.id, tripId))) return res.status(404).json({ error: "Trip not found" });

    const { name, category, status, note, url, sort_order, gear_item_id } = req.body;
    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    // If linking to a gear item, verify ownership
    if (gear_item_id) {
      const gear = await prisma.gearItem.findFirst({ where: { id: parseInt(gear_item_id), user_id: req.user.id } });
      if (!gear) return res.status(404).json({ error: "Gear item not found" });
    }

    try {
      const item = await prisma.tripItem.create({
        data: {
          trip_id: tripId,
          name: name.trim(),
          category: category?.trim() || null,
          status: status || "PACKED",
          note: note?.trim() || null,
          url: url?.trim() || null,
          sort_order: sort_order ?? 0,
          gear_item_id: gear_item_id ? parseInt(gear_item_id) : null,
        },
        include: { gear_item_rel: true },
      });
      res.status(201).json({ data: item });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// PATCH /travel/trips/:tripId/items/reorder — bulk sort_order update
router.patch("/reorder", param("tripId").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid tripId" });

  const tripId = parseInt(req.params.tripId);
  if (!(await ownsTrip(req.user.id, tripId))) return res.status(404).json({ error: "Trip not found" });

  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: "items must be an array" });

  try {
    await prisma.$transaction(
      items.map(({ id, sort_order }) =>
        prisma.tripItem.updateMany({
          where: { id, trip_id: tripId },
          data: { sort_order },
        })
      )
    );
    res.json({ message: "Reordered" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /travel/trips/:tripId/items/:itemId
router.patch(
  "/:itemId",
  [param("tripId").isInt(), param("itemId").isInt()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid parameters" });

    const tripId = parseInt(req.params.tripId);
    const itemId = parseInt(req.params.itemId);
    if (!(await ownsTrip(req.user.id, tripId))) return res.status(404).json({ error: "Trip not found" });

    const { name, category, status, note, url, sort_order, gear_item_id } = req.body;
    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const data = {};
    if (name !== undefined) data.name = name.trim();
    if (category !== undefined) data.category = category?.trim() || null;
    if (status !== undefined) data.status = status;
    if (note !== undefined) data.note = note?.trim() || null;
    if (url !== undefined) data.url = url?.trim() || null;
    if (sort_order !== undefined) data.sort_order = sort_order;
    if (gear_item_id !== undefined) data.gear_item_id = gear_item_id ? parseInt(gear_item_id) : null;

    try {
      const existing = await prisma.tripItem.findFirst({ where: { id: itemId, trip_id: tripId } });
      if (!existing) return res.status(404).json({ error: "Item not found" });

      const item = await prisma.tripItem.update({ where: { id: itemId }, data, include: { gear_item_rel: true } });
      res.json({ data: item });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// DELETE /travel/trips/:tripId/items/:itemId
router.delete(
  "/:itemId",
  [param("tripId").isInt(), param("itemId").isInt()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid parameters" });

    const tripId = parseInt(req.params.tripId);
    const itemId = parseInt(req.params.itemId);
    if (!(await ownsTrip(req.user.id, tripId))) return res.status(404).json({ error: "Trip not found" });

    try {
      const existing = await prisma.tripItem.findFirst({ where: { id: itemId, trip_id: tripId } });
      if (!existing) return res.status(404).json({ error: "Item not found" });

      await prisma.tripItem.delete({ where: { id: itemId } });
      res.json({ message: "Item deleted" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
