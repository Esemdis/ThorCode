const express = require("express");
const router = express.Router();
const { body, param, validationResult } = require("express-validator");

const auth = require("../../auth/verifyJWT");
const roleCheck = require("../../middlewares/roleCheck");
const prisma = require("../../prisma/client");

router.use(auth);
router.use(roleCheck(["USER", "ADMIN"]));

// GET /travel/gear — list all gear items with trip count
router.get("/", async (req, res) => {
  try {
    const gear = await prisma.gearItem.findMany({
      where: { user_id: req.user.id },
      include: { _count: { select: { trip_items: true } } },
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

    const { name, model, brand, category, dimensions, tags, parent_id, notes, url } = req.body;
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
          parent_id: parent_id != null ? parseInt(parent_id, 10) : null,
          notes: notes?.trim() || null,
          url: url?.trim() || null,
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

  const { name, model, brand, category, dimensions, tags, notes, url, parent_id } = req.body;
  const data = {};
  if (name !== undefined) data.name = name.trim();
  if (model !== undefined) data.model = model?.trim() || null;
  if (brand !== undefined) data.brand = brand?.trim() || null;
  if (category !== undefined) data.category = category?.trim() || null;
  if (dimensions !== undefined) data.dimensions = dimensions ?? null;
  if (tags !== undefined) data.tags = Array.isArray(tags) ? tags.map((t) => t.trim()).filter(Boolean) : [];
  if (notes !== undefined) data.notes = notes?.trim() || null;
  if (url !== undefined) data.url = url?.trim() || null;
  if (parent_id !== undefined) data.parent_id = parent_id != null ? parseInt(parent_id, 10) : null;
  if (req.body.sort_order !== undefined) data.sort_order = parseInt(req.body.sort_order, 10);

  try {
    const existing = await prisma.gearItem.findFirst({
      where: { id: parseInt(req.params.id), user_id: req.user.id },
    });
    if (!existing) return res.status(404).json({ error: "Gear item not found" });

    const item = await prisma.gearItem.update({ where: { id: parseInt(req.params.id) }, data });
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
