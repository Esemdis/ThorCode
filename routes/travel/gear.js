const express = require("express");
const router = express.Router();
const { body, param, validationResult } = require("express-validator");

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const prisma = require("../../prisma/client");
const { recomputeGearReviewStatus } = require("../../utils/reviewStatus");

router.use(auth);
router.use(roleCheck(["USER", "ADMIN"]));

// GET /travel/gear/usage-stats — trip usage summary for all gear items
router.get("/usage-stats", async (req, res) => {
  try {
    const tripItems = await prisma.tripItem.findMany({
      where: {
        gear_item_id: { not: null },
        gear_item_rel: { user_id: req.user.id },
      },
      select: {
        gear_item_id: true,
        trip_rel: { select: { id: true, name: true, destination: true, start_date: true } },
      },
      orderBy: { created_at: "asc" },
    });

    // Build per-gear map: gear_item_id → { trips (deduped by trip id), last_trip }
    const map = new Map();
    for (const ti of tripItems) {
      const gid = ti.gear_item_id;
      if (!map.has(gid)) map.set(gid, { trips: new Map() });
      const entry = map.get(gid);
      const t = ti.trip_rel;
      if (!entry.trips.has(t.id)) entry.trips.set(t.id, t);
    }

    const stats = {};
    for (const [gid, { trips }] of map.entries()) {
      const tripList = [...trips.values()].sort(
        (a, b) => new Date(b.start_date || 0) - new Date(a.start_date || 0)
      );
      stats[gid] = {
        trip_count: tripList.length,
        last_trip: tripList[0] || null,
        trips: tripList,
      };
    }

    res.json({ data: stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /travel/gear — list all gear items with trip count
router.get("/", async (req, res) => {
  try {
    const gear = await prisma.gearItem.findMany({
      where: { user_id: req.user.id },
      include: {
        _count: { select: { trip_items: true } },
        replaced_by_rel: { select: { id: true, name: true, brand: true, model: true } },
      },
      orderBy: [{ category: "asc" }, { brand: "asc" }, { name: "asc" }],
    });
    res.json({ data: gear });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /travel/gear — create gear item
router.post(
  "/",
  [body("name").notEmpty().trim()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const { name, model, brand, category, dimensions, tags, notes, url, worn } = req.body;
    try {
      const item = await prisma.gearItem.create({
        data: {
          user_id: req.user.id,
          name: name.trim(),
          model: model?.trim() || null,
          brand: brand?.trim() || null,
          category: category?.trim() || null,
          dimensions: dimensions ?? null,
          tags: Array.isArray(tags) ? tags.map((t) => t.trim()).filter(Boolean) : [],
          notes: notes?.trim() || null,
          url: url?.trim() || null,
          worn: Boolean(worn),
        },
      });
      res.status(201).json({ data: item });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// GET /travel/gear/:id — get gear item with trip history
router.get("/:id", param("id").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid id" });

  try {
    const item = await prisma.gearItem.findFirst({
      where: { id: parseInt(req.params.id), user_id: req.user.id },
      include: {
        trip_items: {
          include: { trip_rel: { select: { id: true, name: true, destination: true, start_date: true } } },
          orderBy: { created_at: "desc" },
        },
        reviews: {
          include: { trip_rel: { select: { id: true, name: true, destination: true, start_date: true } } },
          orderBy: { created_at: "desc" },
        },
      },
    });
    if (!item) return res.status(404).json({ error: "Gear item not found" });
    res.json({ data: item });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /travel/gear/:id
router.patch("/:id", param("id").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid id" });

  const { name, model, brand, category, dimensions, tags, notes, url, worn, essential, retired, replaced_by_id } = req.body;
  const data = {};
  if (essential !== undefined) data.essential = Boolean(essential);
  if (retired !== undefined) data.retired = Boolean(retired);
  if (replaced_by_id !== undefined) data.replaced_by_id = replaced_by_id != null ? parseInt(replaced_by_id, 10) : null;
  if (name !== undefined) data.name = name.trim();
  if (model !== undefined) data.model = model?.trim() || null;
  if (brand !== undefined) data.brand = brand?.trim() || null;
  if (category !== undefined) data.category = category?.trim() || null;
  if (dimensions !== undefined) data.dimensions = dimensions ?? null;
  if (tags !== undefined) data.tags = Array.isArray(tags) ? tags.map((t) => t.trim()).filter(Boolean) : [];
  if (notes !== undefined) data.notes = notes?.trim() || null;
  if (url !== undefined) data.url = url?.trim() || null;
  if (req.body.sort_order !== undefined) data.sort_order = parseInt(req.body.sort_order, 10);
  if (worn !== undefined) data.worn = Boolean(worn);

  try {
    const existing = await prisma.gearItem.findFirst({
      where: { id: parseInt(req.params.id), user_id: req.user.id },
    });
    if (!existing) return res.status(404).json({ error: "Gear item not found" });

    let item = await prisma.gearItem.update({ where: { id: parseInt(req.params.id) }, data });
    if (essential !== undefined) item = await recomputeGearReviewStatus(item.id);
    res.json({ data: item });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /travel/gear/:id
router.delete("/:id", param("id").isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid id" });

  try {
    const existing = await prisma.gearItem.findFirst({
      where: { id: parseInt(req.params.id), user_id: req.user.id },
    });
    if (!existing) return res.status(404).json({ error: "Gear item not found" });

    await prisma.gearItem.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ message: "Gear item deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
